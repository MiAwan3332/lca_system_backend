import fileUpload from 'express-fileupload';
import fs from 'node:fs/promises';
import path from 'node:path';
import auth from './auth.js';

const ordinary = fileUpload();
export default function creationUploads(req, res, next) {
  if (req.method !== 'POST' || !/^\/(students|users)\/add\/?$/.test(req.path)) return ordinary(req, res, next);
  const incoming = path.resolve(process.env.CREATION_STAGING_DIR || '.creation-staging', '_incoming');
  const parser = fileUpload({ useTempFiles: true, tempFileDir: incoming, createParentPath: true,
    limits: { fileSize: 10 * 1024 * 1024, files: 11, fields: 40 }, abortOnLimit: true,
    responseOnLimit: 'Attachments must be no larger than 10 MB each' });
  return auth(req, res, () => parser(req, res, (error) => {
    const clean = () => {
      for (const files of Object.values(req.files || {})) for (const file of (Array.isArray(files) ? files : [files])) {
        if (file.tempFilePath && path.dirname(path.resolve(file.tempFilePath)) === incoming) {
          fs.unlink(file.tempFilePath).catch(() => {});
        }
      }
    };
    res.once('finish', clean);
    res.once('close', clean);
    if (error && ['ENOSPC', 'EDQUOT'].includes(error.code)) {
      error.status = 507;
      error.code = 'CREATION_NOT_COMMITTED';
      error.message = 'Upload staging storage is full. No record was created. Contact an administrator.';
    }
    next(error);
  }));
}
