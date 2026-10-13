import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { uploadFile } from '../utils/fileStorage.js';

if (!process.argv.includes('--write-test')) {
  throw new Error('Pass --write-test to create, verify and remove temporary diagnostic objects.');
}
const runId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const folder = path.join(process.env.FILES_STORAGE_PATH || 'public', 'diagnostics');
const prefix = `${process.env.S3_KEY_PREFIX || 'files'}/diagnostics`;
const base = {
  endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'eu2',
  forcePathStyle: true, maxAttempts: 1,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
};
const makeClient = (compatible) => new S3Client({ ...base,
  ...(compatible ? { requestChecksumCalculation: 'WHEN_REQUIRED' } : {}),
  requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, socketTimeout: 10000 }),
});
const control = makeClient(true);
const report = [];
const keys = new Set();
await fs.mkdir(folder, { recursive: true });
try {
  for (const mode of ['default-stream', 'compatible-stream', 'compatible-buffer', 'application-upload']) {
    const client = makeClient(mode !== 'default-stream');
    try {
      for (let trial = 1; trial <= 2; trial += 1) {
        const name = `${runId}-${mode}-${trial}.bin`;
        const key = `${prefix}/${name}`;
        keys.add(key);
        const bytes = crypto.randomBytes(trial === 1 ? 512 : 256 * 1024);
        const started = Date.now();
        let body;
        try {
          if (mode === 'application-upload') {
            await uploadFile({ mv: (target, cb) => fs.writeFile(target, bytes).then(() => cb(), cb) }, name, folder);
          } else {
            body = mode.endsWith('buffer') ? bytes : Readable.from([bytes]);
            await client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET,
              Key: key, Body: body, ContentLength: bytes.length, ContentType: 'application/octet-stream', ACL: 'private',
            }), { abortSignal: AbortSignal.timeout(15000) });
          }
          const response = await control.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
          const received = Buffer.from(await response.Body.transformToByteArray());
          if (!received.equals(bytes)) throw new Error('Read-back content differs from uploaded bytes');
          report.push({ mode, trial, bytes: bytes.length, ok: true, durationMs: Date.now() - started });
        } catch (error) {
          report.push({ mode, trial, bytes: bytes.length, ok: false, durationMs: Date.now() - started,
            error: error.name, message: error.message, status: error.$metadata?.httpStatusCode });
        } finally {
          body?.destroy?.();
          await fs.rm(path.join(folder, name), { force: true });
        }
        console.log(JSON.stringify(report.at(-1)));
      }
    } finally { client.destroy(); }
  }
} finally {
  for (const key of keys) {
    try {
      await control.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
      console.log(JSON.stringify({ event: 'diagnostic_cleanup', key, ok: true }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'diagnostic_cleanup', key, ok: false, message: error.message }));
      process.exitCode = 1;
    }
  }
  control.destroy();
}
if (report.some((item) => item.mode === 'application-upload' && !item.ok)) process.exitCode = 1;
