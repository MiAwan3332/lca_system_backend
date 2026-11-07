import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import Alert from '../models/operationalAlerts.js';
import { creationAudit } from './creationAudit.js';
import { buildOperationalReport } from './operationalAlertReport.js';
import { redactDiagnostic } from './operationalDiagnostics.js';

export const alertChannelConfigured = () => Boolean(process.env.ALERT_EMAIL_TO && process.env.EMAIL_USER && process.env.EMAIL_PASS);
const sendEmail = async (mail) => {
  const transport = nodemailer.createTransport({ service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
  try { await transport.sendMail(mail); } finally { transport.close(); }
};

// Delivery state and cooldown survive API restarts and serialize multiple API instances.
export async function notifyOperationalAlert(topic, counts, { send = sendEmail } = {}) {
  if (!alertChannelConfigured()) return { configured: false, delivered: false };
  const recipients = process.env.ALERT_EMAIL_TO.split(',').map((item) => item.trim());
  if (!recipients.length || recipients.some((item) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(item))) {
    throw new Error('Invalid operational alert recipient configuration');
  }
  const resolved = topic === 'creation-queue' ? !counts.failed && !counts.stuck : topic === 'http-errors'
    ? !(counts.gatewayTimeouts || counts.disconnected >= 5 || (counts.requests >= 20 && counts.serverErrors / counts.requests >= 0.05)) : false;
  const previous = await Alert.findById(topic).lean();
  if (resolved && !previous?.active) return { configured: true, delivered: false, healthy: true };
  // Do not perform record lookups on every worker tick while delivery is cooling down.
  if (previous?.nextAttempt > new Date() || previous?.leaseUntil > new Date()) return { configured: true, delivered: false, deferred: true };
  const report = await buildOperationalReport(topic, counts);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ counts, resolved,
    incidents: report.incidents?.map((item) => ({ id: item.creationId, state: item.coreState,
      jobs: item.jobs.map((job) => ({ name: job.name, state: job.state, attempts: job.attempts, error: job.error })) })) })).digest('hex');
  if (previous?.fingerprint === fingerprint && previous.lastSent > new Date(Date.now() - 86400000)) {
    return { configured: true, delivered: false, deferred: true, unchanged: true };
  }
  await Alert.updateOne({ _id: topic }, { $setOnInsert: { nextAttempt: new Date(0), leaseUntil: new Date(0) } }, { upsert: true })
    .catch((error) => { if (error.code !== 11000) throw error; });
  const token = crypto.randomUUID();
  const alert = await Alert.findOneAndUpdate({ _id: topic, nextAttempt: { $lte: new Date() }, leaseUntil: { $lte: new Date() } },
    { $set: { leaseUntil: new Date(Date.now() + 60000), leaseToken: token } }, { new: true });
  if (!alert) return { configured: true, delivered: false, deferred: true };
  try {
    const title = resolved ? 'RESOLVED' : 'ACTION REQUIRED';
    const affected = report.incidents?.[0];
    const summary = affected ? ` - ${affected.kind} ${affected.record?.roll || affected.recordId} - ${affected.jobs.filter((job) => job.state === 'failed').map((job) => job.name.split(':')[0]).join(', ') || affected.coreState}` : '';
    const serialized = JSON.stringify(report, null, 2);
    const detail = redactDiagnostic(serialized, 60000) + (serialized.length > 60000 ? '\n[Report truncated at 60,000 characters; use record/request IDs to inspect the remaining logs.]' : '');
    await send({ from: process.env.EMAIL_USER, to: recipients.join(','), subject: `LCA operational alert: ${topic} [${title}]${summary}`.replace(/[\r\n]/g, ' '),
      text: `${resolved ? 'The previously reported incident is below the alert threshold.' : 'The LCA API needs attention.'}\nObserved: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })} PKT\n${detail}\n\nInternal operational report. Credentials, message bodies, attachment URLs and government identifiers are excluded. Up to 20 incident/request examples are included. Unchanged incidents are reminded daily; changed incidents are rate-limited to one email per 15 minutes.` });
    await Alert.updateOne({ _id: topic, leaseToken: token }, { $set: { lastSent: new Date(), nextAttempt: new Date(Date.now() + 900000),
      leaseUntil: new Date(0), attempts: 0, error: null, fingerprint, active: !resolved } }, { writeConcern: { w: 1, j: true } });
    return { configured: true, delivered: true };
  } catch {
    await Alert.updateOne({ _id: topic, leaseToken: token }, { $inc: { attempts: 1 }, $set: { error: 'Notification delivery failed',
      leaseUntil: new Date(0), nextAttempt: new Date(Date.now() + Math.min(900000, 30000 * 2 ** Math.min(alert.attempts, 5))) } });
    creationAudit('operational_alert_delivery_failed', { topic });
    return { configured: true, delivered: false };
  }
}
