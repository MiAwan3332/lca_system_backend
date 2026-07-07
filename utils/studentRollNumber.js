import StudentRollCounter from "../models/studentRollCounters.js";
import Student from "../models/students.js";

const extractBatchCode = (batchName) => {
  const name = String(batchName || "").trim();
  if (!name) return "B";

  // e.g. "batch-8", "Batch 8", "B8"
  const match = name.match(/(\d+)/);
  if (match?.[1]) {
    return `B${match[1]}`;
  }

  // fallback: first 3 letters (safe)
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return cleaned ? cleaned.slice(0, 3) : "B";
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getMaxRollSeqForBatch = async (batchId, batchCode) => {
  const existing = await Student.find({
    batch: batchId,
    roll_number: { $regex: `^${escapeRegex(batchCode)}-\\d+$` },
  })
    .select("roll_number")
    .lean();

  let maxSeq = 0;
  for (const student of existing) {
    const seq = Number(String(student.roll_number).split("-")[1]);
    if (Number.isFinite(seq)) {
      maxSeq = Math.max(maxSeq, seq);
    }
  }
  return maxSeq;
};

export const getNextStudentRollNumber = async ({ batchId, batchName }) => {
  const batchCode = extractBatchCode(batchName);
  const maxExistingSeq = await getMaxRollSeqForBatch(batchId, batchCode);

  const counter = await StudentRollCounter.findOne({ batch: batchId });
  if (!counter || counter.seq < maxExistingSeq) {
    await StudentRollCounter.findOneAndUpdate(
      { batch: batchId },
      { $set: { seq: maxExistingSeq } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  const updatedCounter = await StudentRollCounter.findOneAndUpdate(
    { batch: batchId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return `${batchCode}-${updatedCounter.seq}`;
};

