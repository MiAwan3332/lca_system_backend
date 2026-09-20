/**
 * Rebuild student roll numbers to:
 *   {On|OC}-{NICKNAME}-{seq}
 *
 * Rules:
 *   - Online batch      → On
 *   - On Campus batch   → OC
 *   - Nickname from batch.roll_nickname (required)
 *   - Sequence per batch by admission_date, then _id
 *
 * Examples:
 *   On Campus + MARATHON → OC-MARATHON-1, OC-MARATHON-2, ...
 *   Online + CSS         → On-CSS-1, On-CSS-2, ...
 *
 * Usage:
 *   node scripts/updateStudentRollNumbers.js --dry-run
 *   node scripts/updateStudentRollNumbers.js
 *   node scripts/updateStudentRollNumbers.js --batch=<batchId>
 *
 * npm:
 *   npm run update-roll-numbers -- --dry-run
 *   npm run update-roll-numbers
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

import Batch from "../models/batches.js";
import {
  rebuildStudentRollNumbersForBatch,
  resolveBatchModeCode,
  normalizeRollNickname,
} from "../utils/studentRollNumber.js";

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");
const batchArg = args.find((arg) => arg.startsWith("--batch="));
const onlyBatchId = batchArg ? batchArg.split("=")[1]?.trim() : "";

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is missing in .env");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");
  console.log(
    dryRun
      ? "Mode: DRY RUN (no writes)"
      : "Mode: LIVE UPDATE (will rewrite roll numbers)"
  );

  const filter = {
    is_interview_batch: { $ne: true },
  };
  if (onlyBatchId) {
    if (!mongoose.Types.ObjectId.isValid(onlyBatchId)) {
      throw new Error(`Invalid --batch id: ${onlyBatchId}`);
    }
    filter._id = onlyBatchId;
  }

  const batches = await Batch.find(filter)
    .select("_id name batch_type roll_nickname is_active")
    .sort({ name: 1 });

  if (!batches.length) {
    console.log("No batches found.");
    return;
  }

  let totalUpdated = 0;
  let totalUnchanged = 0;
  let skipped = 0;

  for (const batch of batches) {
    const mode = resolveBatchModeCode(batch.batch_type, batch.name);
    const nick = normalizeRollNickname(batch.roll_nickname);

    console.log("\n----------------------------------------");
    console.log(`Batch: ${batch.name || batch._id}`);
    console.log(`  type: ${batch.batch_type || "(empty)"} → mode: ${mode || "(unknown)"}`);
    console.log(`  nickname: ${batch.roll_nickname || "(empty)"} → ${nick || "(missing)"}`);

    const result = await rebuildStudentRollNumbersForBatch({
      batchId: batch._id,
      batchName: batch.name,
      batchType: batch.batch_type,
      rollNickname: batch.roll_nickname,
      dryRun,
    });

    if (result.skipped_reason) {
      skipped += 1;
      console.log(`  SKIPPED (${result.skipped_reason})`);
      continue;
    }

    if (!result.updated.length) {
      console.log("  No students in this batch.");
      continue;
    }

    console.log(`  Prefix: ${result.prefix}`);
    console.log(`  Students: ${result.updated.length}`);

    for (const row of result.updated) {
      const changed = row.old_roll_number !== row.new_roll_number;
      if (changed) totalUpdated += 1;
      else totalUnchanged += 1;

      console.log(
        `    ${changed ? "UPDATE" : "KEEP  "} ${row.name || row.student_id}: ${
          row.old_roll_number || "(none)"
        } → ${row.new_roll_number}`
      );
    }
  }

  console.log("\n========================================");
  console.log(`Batches processed: ${batches.length}`);
  console.log(`Batches skipped:   ${skipped}`);
  console.log(`Rolls changed:     ${totalUpdated}`);
  console.log(`Rolls unchanged:   ${totalUnchanged}`);
  if (dryRun) {
    console.log("Dry run complete. Re-run without --dry-run to apply.");
  } else {
    console.log("Done. Student roll numbers updated.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
