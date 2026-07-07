import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import mime from 'mime-types';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

let s3Client = null;

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

const uploadObject = async (filePath) => {
  const client = getS3Client();

  if (!client) {
    return;
  }

  const contentType = mime.lookup(filePath) || 'application/octet-stream';

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: toObjectKey(filePath),
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
      ACL: process.env.S3_OBJECT_ACL || 'public-read',
    })
  );
};

const deleteObject = async (filePath) => {
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
