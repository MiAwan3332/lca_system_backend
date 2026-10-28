import mongoose from 'mongoose';
import { STAFF_ROLE_CODES, staffCommunication, staffProfileCodes } from './staffRoleProfiles.js';

const deny = (message) => { throw Object.assign(new Error(message), { status: 403, code: 'ACCESS_DENIED' }); };
export function staffQueryFilters(context, route) {
  const communication = staffCommunication(context);
  if (!communication || route.resource !== 'whatsapp') return {};
  return { WhatsAppTemplate: { process: { $in: communication.processes } }, WhatsAppQueuedMessage: { process: { $in: communication.processes } } };
}
export async function enforceStaffMutation(context, route, body = {}, pathname = '') {
  const profiles = staffProfileCodes(context);
  if (!profiles.length) return;
  if (['discount_amount', 'discountAmount'].some((key) => Number(body[key] || 0) !== 0)) deny('Discounts must be applied by the protected owner.');
  if (route.resource === 'students' && ['updateStudent', 'basicStudentUpdate', 'updateStudentinfo'].includes(route.handler) &&
    profiles.every((code) => [STAFF_ROLE_CODES.desk, STAFF_ROLE_CODES.accounts].includes(code)) && Object.hasOwn(body, 'batch')) {
    const id = pathname.split('/').pop();
    const student = mongoose.isValidObjectId(id) ? await mongoose.models.Student.findById(id).select('batch').lean() : null;
    if (!student || String(student.batch || '') !== String(body.batch || '')) deny('Batch transfers require an academic administrator.');
  }
  if (route.resource === 'whatsapp' && ['createWhatsAppTemplate', 'updateWhatsAppTemplate'].includes(route.handler) && body.process &&
    !staffCommunication(context).processes.includes(String(body.process))) deny('This message process is reserved for the owner.');
}
export function enforceStaffMessage(context, request, process) {
  const communication = staffCommunication(context);
  if (!communication) return;
  if (!communication.processes.includes(process)) deny('This message template is outside your role.');
  if (communication.savedTemplatesOnly && (String(request.body || '').trim() || (Array.isArray(request.recipients) && request.recipients.length))) {
    deny('Use an approved saved template and an existing student or qualifier audience.');
  }
  if (communication.savedTemplatesOnly && !request.template_key && !request.template_id) deny('Select an approved saved template.');
  if (staffProfileCodes(context).every((code) => code === STAFF_ROLE_CODES.accounts) && request.audience === 'qualifiers') {
    deny('Accounts messages are limited to students and fee reminders.');
  }
}
