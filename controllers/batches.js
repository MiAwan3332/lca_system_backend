import Batch from "../models/batches.js";
import Student from "../models/students.js";
import {
  isStudentRole,
  resolveStudentRecord,
  denyUnlessOwnBatch,
} from "../utils/studentScope.js";
import {
  isTeacherRole,
  getTeacherScope,
  buildEmptyPaginatedResponse,
  denyUnlessInstitutionAdmin,
  denyUnlessCanDeleteStudent,
} from "../utils/lmsAccess.js";
import { parseBatchSpecialFees } from "../utils/specialFeeOptions.js";
import { deleteBatchCascade } from "../utils/deleteBatchCascade.js";
import BatchDeletionArchive from "../models/batchDeletionArchives.js";

const getBatchEnrolledStudentCount = async (batchId) =>
  Student.countDocuments({ batch: batchId });

const deactivateBatchStudents = async (batchId) => {
  const result = await Student.updateMany(
    { batch: batchId },
    { $set: { is_active: false } }
  );
  return result.modifiedCount;
};

const attachEnrolledStudentCounts = async (batches) => {
  const batchIds = batches.docs.map((batch) => batch._id);
  if (!batchIds.length) return batches;

  const counts = await Student.aggregate([
    { $match: { batch: { $in: batchIds } } },
    { $group: { _id: "$batch", count: { $sum: 1 } } },
  ]);
  const countMap = Object.fromEntries(
    counts.map((entry) => [String(entry._id), entry.count])
  );

  batches.docs = batches.docs.map((batch) => ({
    ...(batch.toObject ? batch.toObject() : batch),
    enrolled_student_count: countMap[String(batch._id)] || 0,
  }));

  return batches;
};

export const getBatches = async (req, res) => {
  const { query, is_active, batch_type, start_date, end_date } = req.query;
  try {
    if (isStudentRole(req)) {
      const student = await resolveStudentRecord(req);
      if (!student?.batch) {
        return res.status(200).json({
          docs: [],
          totalDocs: 0,
          limit: 1,
          totalPages: 1,
          page: 1,
          pagingCounter: 1,
          hasPrevPage: false,
          hasNextPage: false,
          prevPage: null,
          nextPage: null,
        });
      }

      const batch = await Batch.findById(student.batch).populate([
        "courses",
        "teachers",
        { path: "teacher_course_assignments.teacher" },
        { path: "teacher_course_assignments.course" },
      ]);
      return res.status(200).json({
        docs: batch ? [batch] : [],
        totalDocs: batch ? 1 : 0,
        limit: 1,
        totalPages: 1,
        page: 1,
        pagingCounter: 1,
        hasPrevPage: false,
        hasNextPage: false,
        prevPage: null,
        nextPage: null,
      });
    }

    const searchQuery = query ? query : "";
    const filter = {
      $or: [
        { name: { $regex: searchQuery, $options: "i" } },
        { description: { $regex: searchQuery, $options: "i" } },
        { batch_type: { $regex: searchQuery, $options: "i" } },
      ],
    };

    if (isTeacherRole(req)) {
      const scope = await getTeacherScope(req);
      if (!scope?.batchIds?.length) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
      filter._id = { $in: scope.batchIds };
    }

    if (is_active === "true") {
      filter.is_active = { $ne: false };
    } else if (is_active === "false") {
      filter.is_active = false;
    }

    if (batch_type) {
      filter.batch_type = { $regex: batch_type, $options: "i" };
    }

    if (start_date) {
      filter.startdate = { ...(filter.startdate || {}), $gte: start_date };
    }

    if (end_date) {
      filter.enddate = { ...(filter.enddate || {}), $lte: end_date };
    }

    const batches = await Batch.paginate(
      filter,
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        populate: [
          "courses",
          "teachers",
          { path: "teacher_course_assignments.teacher" },
          { path: "teacher_course_assignments.course" },
        ],
      }
    );
    await attachEnrolledStudentCounts(batches);
    res.status(200).json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatch = async (req, res) => {
  const { id } = req.params;
  try {
    if (!(await denyUnlessOwnBatch(req, res, id))) {
      return;
    }

    const batch = await Batch.findById(id);
    res.status(200).json(batch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const coerceBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  return value === true || value === "true" || value === 1 || value === "1";
};

export const addBatch = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const {
    name,
    description,
    roll_nickname,
    batch_fee,
    batch_type,
    startdate,
    enddate,
    class_start_time,
    class_end_time,
    is_special_batch,
    is_interview_batch,
    is_paid_batch,
  } = req.body;
  try {
    const isSpecialBatch = coerceBoolean(is_special_batch);
    const isInterviewBatch = coerceBoolean(is_interview_batch);
    const isPaidBatch =
      is_paid_batch === undefined || is_paid_batch === null || is_paid_batch === ""
        ? true
        : coerceBoolean(is_paid_batch, true);
    if (isSpecialBatch && isInterviewBatch) {
      return res.status(400).json({
        message: "A batch cannot be both Special and Interview. Choose one.",
      });
    }
    const parsedFees = parseBatchSpecialFees(
      req.body,
      isSpecialBatch,
      isPaidBatch
    );
    if (parsedFees.error) {
      return res.status(400).json({ message: parsedFees.error });
    }

    const rollNickname = String(roll_nickname || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!rollNickname) {
      return res.status(400).json({
        message:
          "Roll nickname is required (used as the student roll-number prefix)",
      });
    }

    const normalizedBatchType = String(batch_type || "").trim();
    if (!isInterviewBatch) {
      const typeKey = normalizedBatchType.toLowerCase();
      if (typeKey !== "online" && typeKey !== "on campus") {
        return res.status(400).json({
          message:
            "Batch type must be Online or On Campus (roll numbers use On-NICK / OC-NICK)",
        });
      }
    }

    if (!isInterviewBatch) {
      if (!class_start_time || !class_end_time) {
        return res.status(400).json({
          message: "Daily class start time and end time are required",
        });
      }

      if (String(class_end_time) <= String(class_start_time)) {
        return res.status(400).json({
          message: "Class end time must be after start time",
        });
      }
    }

    const newBatch = new Batch({
      name,
      description,
      roll_nickname: rollNickname,
      batch_fee: !isPaidBatch || isSpecialBatch ? batch_fee || "0" : batch_fee,
      batch_type: normalizedBatchType,
      startdate,
      enddate,
      class_start_time: isInterviewBatch ? "" : class_start_time,
      class_end_time: isInterviewBatch ? "" : class_end_time,
      is_special_batch: isSpecialBatch,
      is_interview_batch: isInterviewBatch,
      is_paid_batch: isPaidBatch,
      special_fee_options: parsedFees.fees,
      is_active: true,
    });
    await newBatch.save();
    res.status(200).json(newBatch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateBatch = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  const {
    name,
    description,
    roll_nickname,
    batch_fee,
    batch_type,
    startdate,
    enddate,
    class_start_time,
    class_end_time,
    is_active,
    is_special_batch,
    is_interview_batch,
    is_paid_batch,
  } = req.body;
  try {
    const existingBatch = await Batch.findById(id);
    if (!existingBatch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    const isSpecialBatch =
      is_special_batch !== undefined
        ? coerceBoolean(is_special_batch)
        : existingBatch.is_special_batch === true;

    const isInterviewBatch =
      is_interview_batch !== undefined
        ? coerceBoolean(is_interview_batch)
        : existingBatch.is_interview_batch === true;

    const isPaidBatch =
      is_paid_batch !== undefined &&
      is_paid_batch !== null &&
      is_paid_batch !== ""
        ? coerceBoolean(is_paid_batch, existingBatch.is_paid_batch !== false)
        : existingBatch.is_paid_batch !== false;

    if (isSpecialBatch && isInterviewBatch) {
      return res.status(400).json({
        message: "A batch cannot be both Special and Interview. Choose one.",
      });
    }

    const parsedFees = parseBatchSpecialFees(
      req.body,
      isSpecialBatch,
      isPaidBatch
    );
    if (parsedFees.error) {
      return res.status(400).json({ message: parsedFees.error });
    }

    const nextStartTime =
      class_start_time !== undefined
        ? class_start_time
        : existingBatch.class_start_time;
    const nextEndTime =
      class_end_time !== undefined
        ? class_end_time
        : existingBatch.class_end_time;

    if (!isInterviewBatch && nextStartTime && nextEndTime) {
      if (String(nextEndTime) <= String(nextStartTime)) {
        return res.status(400).json({
          message: "Class end time must be after start time",
        });
      }
    } else if (
      isInterviewBatch &&
      nextStartTime &&
      nextEndTime &&
      String(nextEndTime) <= String(nextStartTime)
    ) {
      return res.status(400).json({
        message: "Class end time must be after start time",
      });
    }

    const rollNicknameRaw =
      roll_nickname !== undefined
        ? roll_nickname
        : existingBatch.roll_nickname || "";
    const rollNickname = String(rollNicknameRaw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!rollNickname) {
      return res.status(400).json({
        message:
          "Roll nickname is required (used as the student roll-number prefix)",
      });
    }

    const nextBatchType =
      batch_type !== undefined ? batch_type : existingBatch.batch_type || "";
    const normalizedBatchType = String(nextBatchType || "").trim();
    if (!isInterviewBatch) {
      const typeKey = normalizedBatchType.toLowerCase();
      if (typeKey !== "online" && typeKey !== "on campus") {
        return res.status(400).json({
          message:
            "Batch type must be Online or On Campus (roll numbers use On-NICK / OC-NICK)",
        });
      }
    }

    const updatePayload = {
      name,
      description,
      roll_nickname: rollNickname,
      batch_fee: isSpecialBatch ? batch_fee || "0" : batch_fee,
      batch_type: normalizedBatchType,
      startdate,
      enddate,
      class_start_time: nextStartTime || "",
      class_end_time: nextEndTime || "",
      is_special_batch: isSpecialBatch,
      is_interview_batch: isInterviewBatch,
      is_paid_batch: isPaidBatch,
      special_fee_options: parsedFees.fees,
    };
    let studentsDeactivated = 0;
    if (is_active !== undefined) {
      const nextActive = is_active === true || is_active === "true";
      updatePayload.is_active = nextActive;
      if (!nextActive && existingBatch.is_active !== false) {
        studentsDeactivated = await deactivateBatchStudents(id);
      }
    }
    const updatedBatch = await Batch.findByIdAndUpdate(id, updatePayload, {
      new: true,
    });
    const enrolledStudentCount = await getBatchEnrolledStudentCount(id);
    res.status(200).json({
      ...(updatedBatch.toObject ? updatedBatch.toObject() : updatedBatch),
      enrolled_student_count: enrolledStudentCount,
      students_deactivated_count: studentsDeactivated,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const toggleBatchStatus = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  const { is_active } = req.body;

  try {
    const batch = await Batch.findById(id);
    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    const nextActive =
      is_active !== undefined
        ? is_active === true || is_active === "true"
        : batch.is_active === false;

    batch.is_active = nextActive;
    await batch.save();

    let studentsDeactivated = 0;
    if (!nextActive) {
      studentsDeactivated = await deactivateBatchStudents(id);
    }

    const enrolledStudentCount = await getBatchEnrolledStudentCount(id);
    res.status(200).json({
      ...(batch.toObject ? batch.toObject() : batch),
      enrolled_student_count: enrolledStudentCount,
      students_deactivated_count: studentsDeactivated,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteBatch = async (req, res) => {
  // Same roles as student delete: Accounts, Principal, VP, CEO, Super Admins
  if (denyUnlessCanDeleteStudent(req, res)) return;

  const { id } = req.params;
  try {
    const summary = await deleteBatchCascade(id, { req });
    res.status(200).json({
      message:
        "Batch, enrolled students, finance records, and related data deleted successfully. History archived.",
      summary,
    });
  } catch (error) {
    const msg = error?.message || "Failed to delete batch";
    if (msg === "Batch not found" || msg === "Invalid batch id") {
      return res.status(404).json({ message: msg });
    }
    res.status(500).json({ message: msg });
  }
};

export const getDeletedBatches = async (req, res) => {
  try {
    if (denyUnlessCanDeleteStudent(req, res)) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const query = String(req.query.query || "").trim();

    const filter = {};
    if (query) {
      const regex = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      filter.$or = [
        { "batch.name": regex },
        { "batch.description": regex },
        { "batch.batch_type": regex },
        { deleted_by_name: regex },
        { deleted_by_email: regex },
        { "students.name": regex },
        { "students.phone": regex },
        { "students.roll_number": regex },
      ];
    }

    const result = await BatchDeletionArchive.paginate(filter, {
      page,
      limit,
      sort: { deleted_at: -1 },
      select:
        "original_batch_id batch.name batch.description batch.batch_type batch.batch_fee batch.startdate batch.enddate batch.is_interview_batch batch.is_paid_batch summary deleted_by deleted_by_name deleted_by_email deleted_by_role deletion_reason deleted_at cascade_summary.students_deleted",
      populate: { path: "deleted_by", select: "name email role" },
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getDeletedBatchArchive = async (req, res) => {
  const { id } = req.params;
  try {
    if (denyUnlessCanDeleteStudent(req, res)) return;

    const archive = await BatchDeletionArchive.findById(id)
      .populate("deleted_by", "name email role")
      .populate({
        path: "student_archive_ids",
        select:
          "original_student_id student.name student.phone student.roll_number student.paid_fee student.pending_fee student.total_fee finance.summary deleted_at deletion_source",
      });

    if (!archive) {
      return res
        .status(404)
        .json({ message: "Deleted batch archive not found" });
    }

    res.status(200).json(archive);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const assignCoursesToBatch = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { batchId, courseIds } = req.body;
  try {
    const batch = await Batch.findById(batchId);
    batch.courses = courseIds;
    await batch.save();
    res.status(200).json("Courses assigned to batch successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const assignTeachersToBatch = async (req, res) => {
  const { batchId, teacherIds } = req.body;
  try {
    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }
    batch.teachers = teacherIds;
    await batch.save();
    res.status(200).json("Teachers assigned to batch successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatchTeacherAssignments = async (req, res) => {
  const { id } = req.params;
  try {
    const batch = await Batch.findById(id).populate([
      { path: "teacher_course_assignments.teacher" },
      { path: "teacher_course_assignments.course" },
    ]);
    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }
    res.status(200).json(batch.teacher_course_assignments || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const assignTeacherCoursesToBatch = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { batchId, assignments = [] } = req.body;
  try {
    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    const batchCourseIds = (batch.courses || []).map((courseId) => String(courseId));
    const normalizedAssignments = assignments.map((item) => ({
      teacher: item.teacher || item.teacherId,
      course: item.course || item.courseId,
    }));

    for (const assignment of normalizedAssignments) {
      if (!assignment.teacher || !assignment.course) {
        return res.status(400).json({
          message: "Each assignment must include both teacher and course",
        });
      }
      if (!batchCourseIds.includes(String(assignment.course))) {
        return res.status(400).json({
          message: "Selected course must be assigned to this batch first",
        });
      }
    }

    const uniquePairs = new Map();
    normalizedAssignments.forEach((assignment) => {
      const key = `${assignment.teacher}-${assignment.course}`;
      uniquePairs.set(key, assignment);
    });

    batch.teacher_course_assignments = Array.from(uniquePairs.values());
    batch.teachers = [
      ...new Set(batch.teacher_course_assignments.map((item) => String(item.teacher))),
    ];
    await batch.save();

    const populated = await Batch.findById(batchId).populate([
      { path: "teacher_course_assignments.teacher" },
      { path: "teacher_course_assignments.course" },
    ]);

    res.status(200).json(populated.teacher_course_assignments || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatchCourses = async (req, res) => {
  const { id } = req.params;
  try {
    if (!(await denyUnlessOwnBatch(req, res, id))) {
      return;
    }

    const batch = await Batch.findById(id).populate("courses");
    res.status(200).json(batch.courses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatchTeachers = async (req, res) => {
  const { id } = req.params;
  try {
    const batch = await Batch.findById(id).populate("teachers");
    res.status(200).json(batch.teachers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
