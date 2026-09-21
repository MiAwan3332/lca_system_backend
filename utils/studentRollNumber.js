import StudentRollCounter from "../models/studentRollCounters.js";
import Student from "../models/students.js";
import Batch from "../models/batches.js";

/** Normalize a roll nickname into a safe prefix (letters/digits). */
export const normalizeRollNickname = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/**
 * Online → On, On Campus / OnCampus → OC.
 * Also peeks at batch name when batch_type is empty.
 */
export const resolveBatchModeCode = (batchType, batchName = "") => {
  const typeRaw = String(batchType || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  const nameRaw = String(batchName || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  const source = typeRaw || nameRaw;
  if (!source) return "";

  if (
    typeRaw === "online" ||
    /^online$/.test(typeRaw) ||
    (/\bonline\b/.test(source) && !/\bcampus\b/.test(source))
  ) {
    return "On";
  }

  if (
    typeRaw === "on campus" ||
    typeRaw === "oncampus" ||
    /\bon\s*campus\b/.test(source) ||
    /\boncampus\b/.test(source) ||
    (/\bcampus\b/.test(source) && !/\bonline\b/.test(source))
  ) {
    return "OC";
  }

  if (/\bonline\b/.test(source)) return "On";
  return "";
};

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
    .filter((w) => !/^\d+$/.test(w) && w.toLowerCase() !== "batch")
    .map((w) => w[0].toUpperCase())
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

/**
 * Roll prefix: {On|OC}-{NICKNAME}
 * Example: On Campus + MARATHON → OC-MARATHON
 * If nickname is missing, falls back to an auto code from the batch name
 * so admission slips always get a roll number.
 */
export const buildRollNumberPrefix = ({
  batchType,
  batchName,
  rollNickname,
  strict = true,
} = {}) => {
  const mode = resolveBatchModeCode(batchType, batchName);
  let nick = normalizeRollNickname(rollNickname);

  if (!mode) {
    if (strict) {
      throw new Error(
        "Batch type must be Online or On Campus to generate roll numbers (On-NICK-1 / OC-NICK-1)"
      );
    }
  }
  if (!nick) {
    // Prefer configured nickname; otherwise derive from batch name (e.g. B110…)
    nick = normalizeRollNickname(extractBatchCode(batchName));
  }
  if (!nick) {
    if (strict) {
      throw new Error(
        "Batch roll nickname is required to generate roll numbers (e.g. OC-MARATHON-1)"
      );
    }
  }

  if (mode && nick) return `${mode}-${nick}`;
  if (nick) return nick;
  return extractBatchCode(batchName || "B");
};

/** Prefer batch roll nickname; fall back to auto code from batch name. */
export const resolveBatchCode = ({
  rollNickname,
  batchName,
  batchType,
} = {}) =>
  buildRollNumberPrefix({
    batchType,
    batchName,
    rollNickname,
  });

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const extractRollSequence = (rollNumber) => {
  const match = String(rollNumber || "").match(/-(\d+)$/);
  if (!match) return 0;
  const seq = Number(match[1]);
  return Number.isFinite(seq) ? seq : 0;
};

const getMaxRollSeqForBatch = async (batchId, batchCode) => {
  const existing = await Student.find({
    batch: batchId,
    roll_number: { $regex: `^${escapeRegex(batchCode)}-\\d+$` },
  })
    .select("roll_number")
    .lean();

  let maxSeq = 0;
  for (const student of existing) {
    maxSeq = Math.max(maxSeq, extractRollSequence(student.roll_number));
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

export const getNextStudentRollNumber = async ({
  batchId,
  batchName,
  rollNickname,
  batchType,
} = {}) => {
  if (!batchId) {
    throw new Error("Batch is required to generate roll number");
  }

  let resolvedName = batchName;
  let resolvedNickname = rollNickname;
  let resolvedType = batchType;

  if (
    !resolvedName ||
    resolvedNickname == null ||
    resolvedNickname === "" ||
    resolvedType == null ||
    resolvedType === ""
  ) {
    const batch = await Batch.findById(batchId)
      .select("name roll_nickname batch_type")
      .lean();
    if (!resolvedName) resolvedName = batch?.name || "";
    if (resolvedNickname == null || resolvedNickname === "") {
      resolvedNickname = batch?.roll_nickname || "";
    }
    if (resolvedType == null || resolvedType === "") {
      resolvedType = batch?.batch_type || "";
    }
  }

  const batchCode = buildRollNumberPrefix({
    batchType: resolvedType,
    batchName: resolvedName,
    rollNickname: resolvedNickname,
    strict: true,
  });
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
  rollNickname,
  batchType,
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
    const rollNumber = await getNextStudentRollNumber({
      batchId,
      batchName,
      rollNickname,
      batchType,
    });
    await Student.updateOne(
      { _id: student._id },
      { $set: { roll_number: rollNumber } }
    );
    assigned.push({ student_id: student._id, roll_number: rollNumber });
  }

  return assigned;
};

/**
 * Rebuild every student's roll number in a batch to:
 *   {On|OC}-{NICKNAME}-{seq}
 * Sequence is by admission_date then _id.
 */
export const rebuildStudentRollNumbersForBatch = async ({
  batchId,
  batchName,
  rollNickname,
  batchType,
  dryRun = false,
} = {}) => {
  if (!batchId) {
    return { updated: [], skipped_reason: "missing_batch_id" };
  }

  let resolvedName = batchName;
  let resolvedNickname = rollNickname;
  let resolvedType = batchType;

  if (
    !resolvedName ||
    resolvedNickname == null ||
    resolvedNickname === "" ||
    resolvedType == null ||
    resolvedType === ""
  ) {
    const batch = await Batch.findById(batchId)
      .select("name roll_nickname batch_type")
      .lean();
    if (!resolvedName) resolvedName = batch?.name || "";
    if (resolvedNickname == null || resolvedNickname === "") {
      resolvedNickname = batch?.roll_nickname || "";
    }
    if (resolvedType == null || resolvedType === "") {
      resolvedType = batch?.batch_type || "";
    }
  }

  const mode = resolveBatchModeCode(resolvedType, resolvedName);
  const nick = normalizeRollNickname(resolvedNickname);

  if (!mode) {
    return {
      updated: [],
      skipped_reason: "missing_or_unknown_batch_type",
      batch_name: resolvedName,
      batch_type: resolvedType,
    };
  }
  if (!nick) {
    return {
      updated: [],
      skipped_reason: "missing_roll_nickname",
      batch_name: resolvedName,
      batch_type: resolvedType,
    };
  }

  const prefix = `${mode}-${nick}`;
  const students = await Student.find({ batch: batchId })
    .select("_id name roll_number admission_date")
    .sort({ admission_date: 1, _id: 1 });

  if (!students.length) {
    if (!dryRun) {
      await StudentRollCounter.findOneAndUpdate(
        { batch: batchId },
        { $set: { seq: 0 } },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
    return {
      updated: [],
      prefix,
      batch_name: resolvedName,
      mode,
      nickname: nick,
    };
  }

  const plan = students.map((student, index) => ({
    student_id: student._id,
    name: student.name || "",
    old_roll_number: student.roll_number || "",
    new_roll_number: `${prefix}-${index + 1}`,
  }));

  if (dryRun) {
    return {
      updated: plan,
      dry_run: true,
      prefix,
      batch_name: resolvedName,
      mode,
      nickname: nick,
    };
  }

  // Phase 1: temporary unique rolls to avoid unique collisions while swapping
  for (const row of plan) {
    const tempRoll = `__TMP__${String(batchId)}_${String(row.student_id)}`;
    await Student.updateOne(
      { _id: row.student_id },
      { $set: { roll_number: tempRoll } }
    );
  }

  // Phase 2: final rolls — ensure global uniqueness
  for (const row of plan) {
    const clash = await Student.exists({
      roll_number: row.new_roll_number,
      _id: { $ne: row.student_id },
    });
    if (clash) {
      throw new Error(
        `Roll number ${row.new_roll_number} already exists outside this batch rebuild`
      );
    }
    await Student.updateOne(
      { _id: row.student_id },
      { $set: { roll_number: row.new_roll_number } }
    );
  }

  await StudentRollCounter.findOneAndUpdate(
    { batch: batchId },
    { $set: { seq: plan.length } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return {
    updated: plan,
    dry_run: false,
    prefix,
    batch_name: resolvedName,
    mode,
    nickname: nick,
  };
};
