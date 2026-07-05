import StudentRollCounter from "../models/studentRollCounters.js";

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

export const getNextStudentRollNumber = async ({ batchId, batchName }) => {
  const counter = await StudentRollCounter.findOneAndUpdate(
    { batch: batchId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const batchCode = extractBatchCode(batchName);
  return `${batchCode}-${counter.seq}`;
};

