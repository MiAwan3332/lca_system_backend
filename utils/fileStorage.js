import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import mime from 'mime-types';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { retryUpload } from './uploadRetry.js';
import { creationAudit } from './creationAudit.js';
import { serveCachedImage, invalidatePublicImage } from './publicImageCache.js';

let s3Client = null;
let creationS3Client = null;

export async function uploadCreationAsset(asset, recordId) {
  const storageRoot = path.resolve(process.env.FILES_STORAGE_PATH || 'public');
  const token = path.basename(asset.stagedPath, asset.ext);
  const image = asset.ext !== '.pdf';
  const relative = asset.type === 'avatar' ? `students/avatars/avatar_${recordId}_${token}.jpeg`
    : `students/payment-evidence/${recordId}/${token}${image ? '.jpeg' : '.pdf'}`;
  const output = path.join(storageRoot, relative);
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  if (image) {
    await sharp(asset.stagedPath, { limitInputPixels: 40000000 }).rotate().jpeg({ quality: 65 }).toFile(output);
  } else {
    const file = await fs.promises.open(asset.stagedPath, 'r');
    try {
      const header = Buffer.alloc(5);
      await file.read(header, 0, 5, 0);
      if (header.toString() !== '%PDF-') throw new Error('Invalid PDF attachment');
    } finally { await file.close(); }
    await fs.promises.copyFile(asset.stagedPath, output);
  }
  if (isS3Enabled()) {
    creationS3Client ||= new S3Client({
      region: process.env.S3_REGION || 'eu2', endpoint: process.env.S3_ENDPOINT, forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED', maxAttempts: 1,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, socketTimeout: 15000 }),
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    });
    const body = fs.createReadStream(output);
    const started = Date.now();
    try {
      await creationS3Client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: toObjectKey(output), Body: body,
        ContentLength: (await fs.promises.stat(output)).size, ContentType: image ? 'image/jpeg' : 'application/pdf',
        ACL: process.env.S3_OBJECT_ACL || 'public-read' }), { abortSignal: AbortSignal.timeout(15000) });
      creationAudit('creation_storage_upload', { durationMs: Date.now() - started, outcome: 'complete' });
    } finally { body.destroy(); await fs.promises.unlink(output).catch(() => {}); }
  }
  const base = String(process.env.FILES_STORAGE_URL || '/public').replace(/\/$/, '');
  return `${base}/${process.env.S3_KEY_PREFIX || 'files'}/${relative}`;
}

const isS3Enabled = () => Boolean(
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
);

const getS3Client = () => {
  if (!isS3Enabled()) {
    return null;
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.S3_REGION || 'eu2',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: Number(process.env.S3_CONNECTION_TIMEOUT_MS) || 5000,
        socketTimeout: Number(process.env.S3_SOCKET_TIMEOUT_MS) || 30000,
      }),
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  return s3Client;
};

const toObjectKey = (filePath) => {
  const storageRoot = path.resolve(process.env.FILES_STORAGE_PATH || 'public');
  const storageKeyPrefix = process.env.S3_KEY_PREFIX || 'files';
  const normalizedPath = path.resolve(filePath);
  let relativePath = path.relative(storageRoot, normalizedPath);

  if (relativePath.startsWith('..')) {
    relativePath = path.basename(filePath);
  }

  return path
    .posix
    .join(storageKeyPrefix, relativePath.split(path.sep).join('/'))
    .replace(/^\/+/, '');
};

const toPublicObjectKey = (publicPath) => {
  const storageKeyPrefix = process.env.S3_KEY_PREFIX || 'files';
  const normalizedPath = decodeURIComponent(publicPath)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');

  if (!normalizedPath || normalizedPath.includes('..')) {
    throw new Error('Invalid file path');
  }

  if (normalizedPath === storageKeyPrefix || normalizedPath.startsWith(`${storageKeyPrefix}/`)) {
    return normalizedPath;
  }

  return path.posix.join(storageKeyPrefix, normalizedPath);
};

const uploadObject = async (filePath) => {
  const client = getS3Client();

  if (!client) {
    return;
  }

  const contentType = mime.lookup(filePath) || 'application/octet-stream';

  const size = (await fs.promises.stat(filePath)).size;
  const key = toObjectKey(filePath);
  await invalidatePublicImage(key);
  // A consumed file stream cannot be replayed by the SDK; reopen it for each attempt.
  await retryUpload({
    attempts: Number(process.env.S3_UPLOAD_MAX_ATTEMPTS) || 3,
    deadlineMs: Number(process.env.S3_UPLOAD_DEADLINE_MS) || 60000,
    attemptTimeoutMs: Number(process.env.S3_UPLOAD_ATTEMPT_TIMEOUT_MS) || 15000,
    run: async ({ signal }) => {
      const body = fs.createReadStream(filePath);
      try {
        return await client.send(new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: key,
          Body: body,
          ContentLength: size,
          ContentType: contentType,
          ACL: process.env.S3_OBJECT_ACL || 'public-read',
        }), { abortSignal: signal });
      } finally {
        body.destroy();
      }
    },
    onAttempt: ({ attempt, durationMs, error, result }) => {
      const metadata = (error || result)?.$metadata;
      console.log(JSON.stringify({
        event: 's3_upload', level: error ? 'error' : 'info',
        endpoint: process.env.S3_ENDPOINT, key, bytes: size, attempt, durationMs,
        status: metadata?.httpStatusCode, storageRequestId: metadata?.requestId,
        errorName: error?.name, errorCode: error?.code, message: error?.message,
      }));
    },
  });
};

export const serveStoredPublicFile = async (req, res, next) => {
  const client = getS3Client();

  if (!client) {
    return next();
  }

  try {
    const key = toPublicObjectKey(req.path);
    if (await serveCachedImage(key, (signal) => client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET, Key: key,
    }), { abortSignal: signal }), res, next)) return;
    const object = await client.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
      }), { abortSignal: AbortSignal.timeout(15000) }
    );

    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }

    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength.toString());
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    object.Body.on('error', next);
    object.Body.pipe(res);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).send('File not found');
    }

    next(error);
  }
};

const deleteObject = async (filePath) => {
  await invalidatePublicImage(toObjectKey(filePath));
  const client = getS3Client();

  if (!client) {
    return;
  }

  await client.send(
    new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: toObjectKey(filePath),
    })
  );
};

const renameObject = async (oldFilePath, newFilePath) => {
  await invalidatePublicImage(toObjectKey(oldFilePath));
  await invalidatePublicImage(toObjectKey(newFilePath));
  const client = getS3Client();

  if (!client) {
    return;
  }

  const oldKey = toObjectKey(oldFilePath);
  const newKey = toObjectKey(newFilePath);

  await client.send(
    new CopyObjectCommand({
      Bucket: process.env.S3_BUCKET,
      CopySource: `${process.env.S3_BUCKET}/${encodeURIComponent(oldKey).replace(/%2F/g, '/')}`,
      Key: newKey,
      ContentType: mime.lookup(newFilePath) || 'application/octet-stream',
      MetadataDirective: 'REPLACE',
      ACL: process.env.S3_OBJECT_ACL || 'public-read',
    })
  );

  await client.send(
    new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: oldKey,
    })
  );
};

export const uploadFile = async (file, fileName, folderPath) => {
  try {
    if (!file) {
      throw new Error("No file provided");
    }

    // Generate a unique file name using the current timestamp
    const filePath = path.join(folderPath, fileName);

    // Ensure the directory exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Move the file to the specified folder
    await new Promise((resolve, reject) => {
      file.mv(filePath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    await uploadObject(filePath);

    return fileName;
  } catch (error) {
    throw new Error(`File upload failed: ${error.message}`);
  }
};

export const compressImage = async (originalFilePath, compressedFilePath, quality) => {
  try {
    // Read the original image
    const imageBuffer = fs.readFileSync(originalFilePath);

    // Compress the image
    const compressedBuffer = await sharp(imageBuffer)
      .jpeg({ quality })
      .toBuffer();

    // Save the compressed image
    fs.writeFileSync(compressedFilePath, compressedBuffer);

    await uploadObject(compressedFilePath);

    if (originalFilePath !== compressedFilePath) {
      await deleteObject(originalFilePath);
    }

    // Delete the original image
    if (fs.existsSync(originalFilePath)) {
      fs.unlinkSync(originalFilePath);
    }
  } catch (error) {
    throw new Error(`Image compression failed: ${error.message}`);
  }
}

export const renameFile = async (oldFilePath, newFilePath) => {
  if (fs.existsSync(oldFilePath)) {
    fs.renameSync(oldFilePath, newFilePath);
  }

  await renameObject(oldFilePath, newFilePath);
}

export const deleteFile = async (filePath) => {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  await deleteObject(filePath);
}
