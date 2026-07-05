import mongoose from "mongoose";
import dotenv from "dotenv";

import Student from "../models/students.js";
import Batch from "../models/batches.js";
import StudentRollCounter from "../models/studentRollCounters.js";

dotenv.config();

const extractBatchCode = (batchName) => {
  const name = String(batchName || "").trim();
  if (!name) return "B";

  // e.g. "batch-8", "Batch 8", "B8"
  const match = name.match(/(\d+)/);
  if (match?.[1]) return `B${match[1]}`;

  // fallback: first 3 alphanumerics
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return cleaned ? cleaned.slice(0, 3) : "B";
};

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is missing in .env");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const batches = await Batch.find({}).select("_id name");
  for (const batch of batches) {
    const batchCode = extractBatchCode(batch.name);

    // Students missing roll_number for this batch
    const students = await Student.find({
      batch: batch._id,
      $or: [{ roll_number: { $exists: false } }, { roll_number: "" }, { roll_number: null }],
    })
      .select("_id admission_date roll_number")
      .sort({ admission_date: 1, _id: 1 });

    if (students.length === 0) continue;

    // Continue after the max existing roll_number in the same batch prefix.
    const existing = await Student.find({
      batch: batch._id,
      roll_number: { $regex: `^${batchCode}-\\d+$` },
    })
      .select("roll_number")
      .lean();

    let maxSeq = 0;
    for (const s of existing) {
      const n = Number(String(s.roll_number).split("-")[1]);
      if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
    }

    let seq = maxSeq;
    for (const s of students) {
      seq += 1;
      const roll = `${batchCode}-${seq}`;
      await Student.updateOne({ _id: s._id }, { $set: { roll_number: roll } });
    }

    // Sync counter so future adds continue from here.
    await StudentRollCounter.updateOne(
      { batch: batch._id },
      { $set: { seq } },
      { upsert: true }
    );

    console.log(
      `Batch ${batch.name}: assigned ${students.length} roll numbers (up to ${batchCode}-${seq})`
    );
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

