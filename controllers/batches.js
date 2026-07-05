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
} from "../utils/lmsAccess.js";

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

export const addBatch = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { name, description, batch_fee, batch_type, startdate, enddate } =
    req.body;
  try {
    const newBatch = new Batch({
      name,
      description,
      batch_fee,
      batch_type,
      startdate,
      enddate,
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
  const { name, description, batch_fee, batch_type, startdate, enddate, is_active } =
    req.body;
  try {
    const existingBatch = await Batch.findById(id);
    if (!existingBatch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    const updatePayload = {
      name,
      description,
      batch_fee,
      batch_type,
      startdate,
      enddate,
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
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const { id } = req.params;
  try {
    await Batch.findByIdAndDelete(id);
    res.status(200).json("Batch deleted successfully");
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
