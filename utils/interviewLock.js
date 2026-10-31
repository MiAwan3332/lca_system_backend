import mongoose from 'mongoose';
import crypto from 'node:crypto';

export const interviewError = (status, message) => Object.assign(new Error(message), { status });

// Cross-process leases serialize identity provisioning and interview mutations on standalone MongoDB too.
export async function withInterviewLock(key, work) {
  const locks = mongoose.connection.db.collection('interviewoperationlocks');
  const holder = crypto.randomUUID(), until = Date.now() + 10000;
  for (;;) {
    const now = new Date();
    try {
      const result = await locks.updateOne({ _id: key, $or: [{ expiresAt: { $lte: now } }, { holder }] },
        { $set: { holder, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true });
      if (result.modifiedCount || result.upsertedCount) break;
    } catch (error) { if (error.code !== 11000) throw error; }
    if (Date.now() >= until) throw interviewError(409, 'Another interview operation is in progress. Please retry.');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const heartbeat = setInterval(() => locks.updateOne({ _id: key, holder }, { $set: { expiresAt: new Date(Date.now() + 120000) } }).catch(() => {}), 10000);
  try { return await work(); }
  finally { clearInterval(heartbeat); await locks.deleteOne({ _id: key, holder }); }
}

export const interviewMutation = handler => async (req, res) => {
  try { return await withInterviewLock('interview-scheduling', () => handler(req, res)); }
  catch (error) { if (!res.headersSent) res.status(error.status || 500).json({ message: error.message }); }
};
