import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import Alert from '../models/operationalAlerts.js';
import { creationAudit } from './creationAudit.js';

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
  await Alert.updateOne({ _id: topic }, { $setOnInsert: { nextAttempt: new Date(0), leaseUntil: new Date(0) } }, { upsert: true })
    .catch((error) => { if (error.code !== 11000) throw error; });
  const token = crypto.randomUUID();
  const alert = await Alert.findOneAndUpdate({ _id: topic, nextAttempt: { $lte: new Date() }, leaseUntil: { $lte: new Date() } },
    { $set: { leaseUntil: new Date(Date.now() + 60000), leaseToken: token } }, { new: true });
  if (!alert) return { configured: true, delivered: false, deferred: true };
  try {
    await send({ from: process.env.EMAIL_USER, to: recipients.join(','), subject: `LCA operational alert: ${topic}`,
      text: `The LCA API needs attention.\n${JSON.stringify(counts, null, 2)}\nInspect the creation processing panel and server logs. No student details are included in this notification.` });
    await Alert.updateOne({ _id: topic, leaseToken: token }, { $set: { lastSent: new Date(), nextAttempt: new Date(Date.now() + 900000),
      leaseUntil: new Date(0), attempts: 0, error: null } }, { writeConcern: { w: 1, j: true } });
    return { configured: true, delivered: true };
  } catch {
    await Alert.updateOne({ _id: topic, leaseToken: token }, { $inc: { attempts: 1 }, $set: { error: 'Notification delivery failed',
      leaseUntil: new Date(0), nextAttempt: new Date(Date.now() + Math.min(900000, 30000 * 2 ** Math.min(alert.attempts, 5))) } });
    creationAudit('operational_alert_delivery_failed', { topic });
    return { configured: true, delivered: false };
  }
}
