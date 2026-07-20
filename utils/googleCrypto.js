import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const getKey = () => {
  const configured = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!configured) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is required");
  }

  const decoded = Buffer.from(configured, "base64");
  if (decoded.length === 32) {
    return decoded;
  }

  const utf8 = Buffer.from(configured, "utf8");
  if (utf8.length === 32) {
    return utf8;
  }

  throw new Error(
    "GOOGLE_TOKEN_ENCRYPTION_KEY must be a 32-byte value or base64-encoded 32-byte value"
  );
};

export const encryptToken = (value) => {
  if (!value) return value;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64")).join(".");
};

export const decryptToken = (value) => {
  if (!value) return value;
  const [ivEncoded, tagEncoded, encryptedEncoded] = String(value).split(".");
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) {
    return value;
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivEncoded, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
};
