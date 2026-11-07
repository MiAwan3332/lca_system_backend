import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
export function policyFingerprint(context) {
  return crypto.createHash('sha256').update(JSON.stringify({ owner: context.owner, roles: context.roles,
    grants: context.grants, batches: context.assignedBatchIds, courses: context.assignedCourseIds, pairs: context.assignedPairs })).digest('hex');
}
export function privateMediaUrl(value, context) {
  if (process.env.PRIVATE_MEDIA_ACCESS !== 'true' || typeof value !== 'string') return value;
  const key = storedMediaKey(value);
  if (key === null) return value;
  if (!key) return undefined;
  const api = new URL(process.env.FILES_STORAGE_URL || 'https://api.lca-portal.com/public');
  if (!context.owner && !context.grants.some((grant) => grant.permission === 'files.download' && grant.scope === 'all')) return undefined;
  const ticket = jwt.sign({ purpose: 'access-media', userId: context.userId, permission: context.permission, key,
    policy: policyFingerprint(context) }, process.env.JWT_SECRET, { expiresIn: '15m', audience: 'lca-private-media' });
  return `${api.origin}/access/media?ticket=${encodeURIComponent(ticket)}`;
}
export function storedMediaKey(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const api = new URL(process.env.FILES_STORAGE_URL || 'https://api.lca-portal.com/public');
  const s3 = process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT) : null;
  let key;
  try {
    if (url.origin === api.origin && url.pathname.includes('/public/')) key = decodeURIComponent(url.pathname.split('/public/')[1]);
    else if (s3 && url.origin === s3.origin && url.pathname.startsWith(`/${process.env.S3_BUCKET}/`)) key = decodeURIComponent(url.pathname.slice(process.env.S3_BUCKET.length + 2));
    else return null;
  } catch { return undefined; }
  if (!key || key.includes('..') || key.includes('\\')) return undefined;
  return key;
}
export function verifyMediaTicket(ticket) {
  const payload = jwt.verify(ticket, process.env.JWT_SECRET, { audience: 'lca-private-media' });
  if (payload.purpose !== 'access-media' || !payload.key || payload.key.includes('..') || payload.key.includes('\\')) throw new Error('Invalid media ticket');
  return payload;
}
export function retainedMediaReference(value, originals, context) {
  if (originals.includes(value)) return value;
  try {
    const api = new URL(process.env.FILES_STORAGE_URL || 'https://api.lca-portal.com/public');
    const url = new URL(value);
    if (url.origin !== api.origin || url.pathname !== '/access/media' || !context) throw new Error();
    const ticket = verifyMediaTicket(url.searchParams.get('ticket'));
    if (context.disabled || ticket.userId !== context.userId || ticket.policy !== policyFingerprint(context) ||
      (!context.owner && (!context.grants.some((grant) => grant.permission === ticket.permission) || !context.grants.some((grant) => grant.permission === 'files.download')))) throw new Error();
    const original = originals.find((candidate) => storedMediaKey(candidate) === ticket.key);
    if (original) return original;
  } catch { /* Invalid or foreign references are never persisted. */ }
  throw Object.assign(new Error('Only existing payment attachments may be retained'), { status: 400 });
}
