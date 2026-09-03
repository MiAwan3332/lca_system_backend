import StudentRollCounter from "../models/studentRollCounters.js";
import Student from "../models/students.js";

export const extractBatchCode = (batchName) => {
  const name = String(batchName || "").trim();
  if (!name) return "B";

  let code = "B";
  
  // 1. Try to extract the first number
  const numMatch = name.match(/(\d+)/);
  if (numMatch?.[1]) {
    code = `B${numMatch[1]}`;
  }

  // 2. Extract first letters of additional words to avoid collisions
  // (e.g. "Batch 110 Online" -> "B110O", "Batch 110 On Campus" -> "B110OC")
  const words = name.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const extraLetters = words
    .filter(w => !/^\d+$/.test(w) && w.toLowerCase() !== "batch")
    .map(w => w[0].toUpperCase())
    .join("");
  
  if (extraLetters) {
    code += extraLetters;
  }

  // fallback: if we still just have "B", use first 3 letters
  if (code === "B") {
    const cleaned = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    code = cleaned ? cleaned.slice(0, 3) : "B";
  }

  return code;
};

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const syncCounterToAtLeast = async (batchId, minSeq) => {
  const counter = await StudentRollCounter.findOne({ batch: batchId });
  if (!counter || Number(counter.seq) < minSeq) {
    await StudentRollCounter.findOneAndUpdate(
      { batch: batchId },
      { $set: { seq: minSeq } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
};

export const getNextStudentRollNumber = async ({ batchId, batchName }) => {
  if (!batchId) {
    throw new Error("Batch is required to generate roll number");
  }

  const batchCode = extractBatchCode(batchName);
  const maxExistingSeq = await getMaxRollSeqForBatch(batchId, batchCode);
  await syncCounterToAtLeast(batchId, maxExistingSeq);

  let rollNumber = null;
  let attempts = 0;

  while (!rollNumber && attempts < 100) {
    attempts++;

    const updatedCounter = await StudentRollCounter.findOneAndUpdate(
      { batch: batchId },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const seq = Number(updatedCounter?.seq);
    if (!Number.isFinite(seq) || seq < 1) {
      throw new Error("Failed to generate student roll number");
    }

    const candidate = `${batchCode}-${seq}`;
    
    // Ensure the generated roll number is globally unique across all batches
    const existsGlobally = await Student.exists({ roll_number: candidate });
    if (!existsGlobally) {
      rollNumber = candidate;
    }
  }

  if (!rollNumber) {
    throw new Error("Could not generate a unique roll number. Please try again.");
  }

  return rollNumber;
};

/** Assign roll numbers to students in a batch that are missing one. */
export const backfillMissingRollNumbersForBatch = async ({
  batchId,
  batchName,
}) => {
  if (!batchId) return [];

  const missing = await Student.find({
    batch: batchId,
    $or: [
      { roll_number: { $exists: false } },
      { roll_number: null },
      { roll_number: "" },
    ],
  })
    .select("_id admission_date")
    .sort({ admission_date: 1, _id: 1 });

  const assigned = [];
  for (const student of missing) {
    const rollNumber = await getNextStudentRollNumber({ batchId, batchName });
    await Student.updateOne(
      { _id: student._id },
      { $set: { roll_number: rollNumber } }
    );
    assigned.push({ student_id: student._id, roll_number: rollNumber });
  }

  return assigned;
};
