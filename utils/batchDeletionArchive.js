import BatchDeletionArchive from "../models/batchDeletionArchives.js";
import { resolveDeletionActor } from "./studentDeletionArchive.js";

const toPlain = (doc) => {
  if (!doc) return null;
  if (typeof doc.toObject === "function") return doc.toObject();
  return doc;
};

const snapshotStudent = (student) => {
  const row = toPlain(student) || {};
  return {
    _id: row._id,
    roll_number: row.roll_number || "",
    name: row.name || "",
    email: row.email || "",
    phone: row.phone || "",
    cnic: row.cnic || "",
    father_name: row.father_name || "",
    city: row.city || "",
    admission_date: row.admission_date || "",
    paid_fee: Number(row.paid_fee) || 0,
    pending_fee: Number(row.pending_fee) || 0,
    total_fee: Number(row.total_fee) || 0,
    cash_amount: Number(row.cash_amount) || 0,
    online_amount: Number(row.online_amount) || 0,
    is_active: row.is_active !== false,
    remarks: row.remarks || "",
  };
};

const snapshotBatch = (batch) => {
  const row = toPlain(batch) || {};
  return {
    _id: row._id,
    name: row.name || "",
    description: row.description || "",
    startdate: row.startdate || "",
    enddate: row.enddate || "",
    class_start_time: row.class_start_time || "",
    class_end_time: row.class_end_time || "",
    batch_fee: row.batch_fee ?? "",
    batch_type: row.batch_type || "",
    is_special_batch: Boolean(row.is_special_batch),
    is_interview_batch: Boolean(row.is_interview_batch),
    is_paid_batch: row.is_paid_batch !== false,
    special_fee_options: row.special_fee_options || [],
    is_active: row.is_active !== false,
    courses: row.courses || [],
    teachers: row.teachers || [],
    teacher_course_assignments: row.teacher_course_assignments || [],
    google_classroom_course_id: row.google_classroom_course_id || "",
    google_classroom_course_url: row.google_classroom_course_url || "",
  };
};

/**
 * Create batch deletion archive BEFORE students/batch are removed.
 */
export const createBatchDeletionArchive = async ({
  batch,
  students = [],
  req = null,
  actor: actorOverride = null,
  deletionReason = "",
}) => {
  const batchDoc = toPlain(batch);
  if (!batchDoc?._id) {
    throw new Error("Cannot archive deletion without batch data");
  }

  const actor = await resolveDeletionActor(req, actorOverride);
  const studentSnapshots = (students || []).map(snapshotStudent);

  const summary = studentSnapshots.reduce(
    (acc, row) => {
      acc.students_count += 1;
      acc.total_fee += Number(row.total_fee) || 0;
      acc.paid_fee += Number(row.paid_fee) || 0;
      acc.pending_fee += Number(row.pending_fee) || 0;
      acc.cash_amount += Number(row.cash_amount) || 0;
      acc.online_amount += Number(row.online_amount) || 0;
      return acc;
    },
    {
      students_count: 0,
      total_fee: 0,
      paid_fee: 0,
      pending_fee: 0,
      cash_amount: 0,
      online_amount: 0,
    }
  );

  return BatchDeletionArchive.create({
    original_batch_id: batchDoc._id,
    batch: snapshotBatch(batchDoc),
    students: studentSnapshots,
    student_archive_ids: [],
    summary,
    deleted_by: actor?.deleted_by || null,
    deleted_by_name: actor?.deleted_by_name || "",
    deleted_by_email: actor?.deleted_by_email || "",
    deleted_by_role: actor?.deleted_by_role || "",
    deletion_reason:
      deletionReason || `Batch deleted: ${batchDoc.name || batchDoc._id}`,
    deleted_at: new Date(),
  });
};

export const finalizeBatchDeletionArchive = async (
  archiveId,
  { studentArchiveIds = [], cascadeSummary = {} } = {}
) => {
  if (!archiveId) return null;
  return BatchDeletionArchive.findByIdAndUpdate(
    archiveId,
    {
      $set: {
        student_archive_ids: studentArchiveIds.filter(Boolean),
        cascade_summary: cascadeSummary || {},
      },
    },
    { new: true }
  );
};

export default {
  createBatchDeletionArchive,
  finalizeBatchDeletionArchive,
};
