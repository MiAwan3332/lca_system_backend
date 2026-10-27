import fs from 'node:fs';
import { privateMediaUrl } from './accessMedia.js';
export const accessCatalog = JSON.parse(fs.readFileSync(new URL('../config/accessCatalog.generated.json', import.meta.url), 'utf8'));
export const permissionKeys = new Set(accessCatalog.permissions.map((item) => item.key));
const pattern = (path) => new RegExp(`^${path.split('/').map((part) => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}/?$`);
export function classifyAccessRoute(method, path) {
  if (method === 'HEAD') method = 'GET';
  return accessCatalog.routes.find((route) => route.method === method && pattern(route.path).test(path.split('?')[0]));
}

export const FIELD_GROUPS = {
  credentials: new Set(accessCatalog.fieldGroups?.credentials || []),
  general: new Set(accessCatalog.fieldGroups?.general || []),
  contact: new Set(['email', 'phone', 'student_phone', 'contact', 'contacts', 'father_phone', 'guardian_phone', 'address', 'city']),
  identity: new Set(['cnic', 'father_cnic', 'date_of_birth', 'dob', 'nationality']),
  financial: new Set(['amount', 'action_amount', 'requested_amount', 'paid_fee', 'pending_fee', 'total_fee', 'cash_amount', 'online_amount', 'batch_fee', 'course_fee', 'salary', 'discount', 'discount_amount', 'discount_remarks', 'fee', 'fee_logs', 'fees', 'total_batch_fee', 'pending_amount', 'outstanding_before', 'outstanding_after', 'paidFee', 'totalFee', 'remainingAfter', 'payingNow']),
  evidence: new Set(['payment_evidence', 'paymentEvidence', 'evidence', 'payment_evidence_urls', 'resume', 'attachment', 'attachments', 'image', 'avatar']),
  internal: new Set(['remarks', 'description_internal', 'approval_comment', 'rejection_reason', 'rejection_comment', 'internal_notes']),
  integration: new Set(['google_classroom', 'google_calendar', 'meeting_url', 'classroom_url', 'classroom_course_id', 'google_event_id']),
};
for (const [group, fields] of Object.entries(accessCatalog.fieldGroups || {})) for (const field of fields) FIELD_GROUPS[group].add(field);
export function canAccessField(context, group, key, action = 'read') {
  return context.owner || context.grants.some((grant) => grant.permission === `fields.${group}.${action}` && (!grant.fields?.length || grant.fields.includes(key)));
}
export const SECRET_FIELDS = /password|secret|credential|token|api[_-]?key|private[_-]?key|^plan$|fingerprint|accessOnboardingRole/i;
const STRUCTURAL_FIELDS = new Set(['_id', 'id', 'docs', 'page', 'limit', 'totalDocs', 'totalPages', 'pagingCounter', 'hasPrevPage', 'hasNextPage', 'prevPage', 'nextPage',
  'message', 'error', 'requestId', 'status', 'code', 'success', 'record_id', 'idempotency_key', 'submission_status', 'processing_status', 'jobs', 'protocol']);
export function redactAccessFields(value, context) {
  if (typeof value === 'string') return privateMediaUrl(value, context);
  if (Array.isArray(value)) return value.map((item) => redactAccessFields(item, context));
  if (!value || typeof value !== 'object' || value instanceof Date || value._bsontype || Buffer.isBuffer(value)) return value;
  const source = typeof value.toObject === 'function' ? value.toObject() : value;
  const ownIds = [context.userId, context.studentId, context.teacherId, context.qualifierId, context.panelistId].filter(Boolean).map(String);
  const recordOwner = source.user || source.recipient_user || source.student;
  const owned = recordOwner && ownIds.includes(String(recordOwner._id || recordOwner));
  const ownGoogleStatus = context.route?.resource === 'google' && context.route?.handler === 'getGoogleStatus';
  const foreignRecord = source._id && !owned && !ownGoogleStatus && !ownIds.includes(String(source._id)) && ['student', 'teacher', 'qualifier', 'panelist'].includes(context.accountType);
  const result = {};
  for (const [key, child] of Object.entries(source)) {
    if (SECRET_FIELDS.test(key)) continue;
    const group = !STRUCTURAL_FIELDS.has(key) && (Object.entries(FIELD_GROUPS).find(([, fields]) => fields.has(key))?.[0] || 'general');
    if (foreignRecord && ['contact', 'identity'].includes(group) && !(context.accountType === 'teacher' && ['phone', 'email'].includes(key))) continue;
    if (foreignRecord && group === 'evidence' && ['phone', 'email', 'cnic', 'resume'].some((field) => Object.hasOwn(source, field)) && !['image', 'avatar', 'photo'].includes(key)) continue;
    if (group && !canAccessField(context, group, key)) continue;
    result[key] = typeof child === 'string' ? privateMediaUrl(child, context) : redactAccessFields(child, context);
  }
  return result;
}
