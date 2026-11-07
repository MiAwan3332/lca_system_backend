// Explicit maintenance only. No students, users, passwords or finance records are created/deleted.
import mongoose from 'mongoose';
if (!process.env.MONGO_URI) throw new Error('MONGO_URI must be supplied explicitly');
const apply = process.argv.includes('--apply') || process.env.APPLY_STUDENT_IDENTITY === 'true';
await mongoose.connect(process.env.MONGO_URI);
try {
  const db = mongoose.connection.db;
  const students = await db.collection('students').find({}, { projection: { phone: 1, email: 1, normalized_phone: 1, user: 1 } }).toArray();
  const phones = new Map();
  for (const student of students) {
    const digits = String(student.phone || '').replace(/\D/g, '');
    if (digits.length < 10) throw new Error('Invalid legacy phone found; manual review required before backfill');
    const normalized = digits.slice(-10);
    if (phones.has(normalized)) throw new Error('Duplicate legacy phones found; no automatic merge is permitted');
    phones.set(normalized, student._id);
  }
  let updated = 0, linked = 0, unlinked = 0;
  const claimedUsers = new Set();
  const changes = [];
  for (const student of students) {
    const matches = await db.collection('users').find({ email: student.email, role: /^student$/i }, { projection: { _id: 1 } }).limit(2).toArray();
    const update = { normalized_phone: String(student.phone).replace(/\D/g, '').slice(-10) };
    if (matches.length === 1 && !claimedUsers.has(String(matches[0]._id))) {
      if (student.user && String(student.user) !== String(matches[0]._id)) throw new Error('Conflicting existing account link; manual review required');
      update.user = matches[0]._id; claimedUsers.add(String(matches[0]._id)); linked++;
    } else { unlinked++; }
    changes.push({ updateOne: { filter: { _id: student._id, phone: student.phone, email: student.email }, update: { $set: update } } });
  }
  // Validate the full plan before the first write, then apply in bounded batches.
  if (apply) for (let offset = 0; offset < changes.length; offset += 100) {
    const result = await db.collection('students').bulkWrite(changes.slice(offset, offset + 100), { ordered: true, writeConcern: { w: 1, j: true } });
    updated += result.modifiedCount;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', students: students.length, plannedLinks: linked, unlinkedAccounts: unlinked, updated,
    passwordsChanged: 0, usersCreated: 0, financeChanged: 0 }));
} finally { await mongoose.disconnect(); }
