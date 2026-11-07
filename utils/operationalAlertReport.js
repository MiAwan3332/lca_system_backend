import CreationRequest from '../models/creationRequests.js';
import Student from '../models/students.js';
import User from '../models/users.js';
import Batch from '../models/batches.js';
import { recentRequestFailures } from './requestObservability.js';
import { redactDiagnostic } from './operationalDiagnostics.js';

export async function buildOperationalReport(topic, counts) {
  const report = { environment: process.env.NODE_ENV || 'unknown', portal: 'https://lca-portal.com', counts };
  if (topic === 'http-errors') {
    report.window = 'Last five minutes; application-observed requests only, not Nginx/Cloudflare-only failures';
    report.requests = recentRequestFailures();
    report.action = 'Use requestId to correlate the route, error and duration with persistent API logs. Do not assume a failed response means a payment or record was not committed.';
    return report;
  }
  if (topic !== 'creation-queue') return report;
  const requests = await CreationRequest.find({ state: { $nin: ['deleted', 'expired'] }, $or: [
    { state: 'failed' }, { 'jobs.state': 'failed' },
    { finalized: false, createdAt: { $lt: new Date(Date.now() - 300000) } },
  ] }).sort({ updatedAt: -1 }).limit(20).lean();
  report.sampleLimit = 20;
  report.truncated = Math.max(counts.failed || 0, counts.stuck || 0) > requests.length;
  report.incidents = [];
  for (const request of requests) {
    const record = await (request.kind === 'student' ? Student : User).findById(request.recordId).select('name email phone roll_number batch').lean();
    const actor = await User.findById(request.actor).select('name email role').lean();
    const batch = record?.batch ? await Batch.findById(record.batch).select('name').lean() : null;
    report.incidents.push({ creationId: String(request._id), requestId: request.requestId, recordId: String(request.recordId),
      kind: request.kind, operation: request.operation || 'admission', coreState: request.state,
      coreCommitted: request.state === 'complete', createdAt: request.createdAt,
      ageMinutes: Math.floor((Date.now() - new Date(request.createdAt)) / 60000),
      record: record ? { name: record.name, email: record.email, phone: record.phone, roll: record.roll_number, batch: batch?.name } : { missing: true },
      actor: actor ? { name: actor.name, email: actor.email, role: actor.role } : { missing: true },
      diagnostic: request.error ? request.diagnostic || null : null, error: redactDiagnostic(request.error),
      jobs: request.jobs.map((job) => ({ name: job.name, state: job.state, attempts: job.attempts, maxAttempts: 5,
        startedAt: job.startedAt, nextRun: ['pending', 'processing'].includes(job.state) ? job.nextRun : null,
        error: redactDiagnostic(job.error), diagnostic: job.diagnostic || null,
        action: job.state === 'failed' ? (job.name === 'welcome'
          ? 'Check OpenWA session readiness and sending limits. Confirm message history before a manual retry; do not recreate the student.'
          : 'Check storage availability and staged files, then retry this job from the record processing panel.') : undefined })),
      action: request.state === 'complete' ? 'The record is saved. Only follow-up work needs attention; do not create the record again.'
        : 'Core creation needs recovery. Inspect the journal and logs before retrying or editing related financial records.',
      diagnosticNote: !request.diagnostic && request.jobs.some((job) => job.error && !job.diagnostic)
        ? 'Legacy failure: the previous version discarded the underlying error. Exact cause cannot be reconstructed from this journal.' : undefined,
    });
  }
  return report;
}
