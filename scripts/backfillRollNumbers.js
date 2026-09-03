/**
 * Backfill roll numbers for all students missing one.
 *
 * Usage:
 *   node scripts/backfillRollNumbers.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

import Batch from "../models/batches.js";
import { backfillMissingRollNumbersForBatch } from "../utils/studentRollNumber.js";

dotenv.config();

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is missing in .env");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const batches = await Batch.find({}).select("_id name");
  let totalAssigned = 0;

  for (const batch of batches) {
    const assigned = await backfillMissingRollNumbersForBatch({
      batchId: batch._id,
      batchName: batch.name,
    });

    if (assigned.length > 0) {
      totalAssigned += assigned.length;
      console.log(
        `${batch.name}: assigned ${assigned.length} roll number(s) → ${assigned
          .map((a) => a.roll_number)
          .join(", ")}`
      );
    }
  }

  console.log(`Done. Assigned ${totalAssigned} roll number(s) in total.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
