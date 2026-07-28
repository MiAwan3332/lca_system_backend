import path from "path";
import { compressImage, uploadFile } from "./fileStorage.js";

/** Normalize express-fileupload single file or array. */
export const asUploadedFileArray = (fileField) => {
  if (!fileField) return [];
  return Array.isArray(fileField) ? fileField.filter(Boolean) : [fileField];
};

/** Normalize stored evidence value (legacy string or array) to URL list. */
export const getPaymentEvidenceUrls = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
};

/** Store as array when multiple, string when one (backward compatible reads). */
export const normalizePaymentEvidenceForStorage = (urls) => {
  const list = getPaymentEvidenceUrls(urls);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return list;
};

/**
 * Upload one or more payment evidence files and return public URLs.
 */
export const uploadPaymentEvidenceFiles = async (fileField, ownerId) => {
  const files = asUploadedFileArray(fileField);
  if (!files.length) return [];

  const filesStorageUrl = process.env.FILES_STORAGE_URL;
  const filesStoragePath = process.env.FILES_STORAGE_PATH;
  if (!filesStorageUrl || !filesStoragePath) {
    throw new Error("File storage is not configured");
  }

  const folderPath = `${filesStoragePath}/students/payment-evidence`;
  const urls = [];

  for (let index = 0; index < files.length; index += 1) {
    const evidenceFile = files[index];
    const fileExt = path.extname(evidenceFile.name) || ".jpg";
    const baseName = `payment_evidence_${ownerId}_${Date.now()}_${index + 1}`;
    const fileName = `${baseName}${fileExt}`;
    await uploadFile(evidenceFile, fileName, folderPath);

    const isImage = /\.(jpe?g|png|webp|gif)$/i.test(fileExt);
    if (isImage) {
      const webpFileName = `${baseName}.jpeg`;
      await compressImage(
        `${folderPath}/${fileName}`,
        `${folderPath}/${webpFileName}`,
        70
      );
      urls.push(
        `${filesStorageUrl}/files/students/payment-evidence/${webpFileName}`
      );
    } else {
      urls.push(
        `${filesStorageUrl}/files/students/payment-evidence/${fileName}`
      );
    }
  }

  return urls;
};
