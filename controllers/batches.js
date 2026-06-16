import Batch from "../models/batches.js";
import {
  isStudentRole,
  resolveStudentRecord,
  denyUnlessOwnBatch,
} from "../utils/studentScope.js";

export const getBatches = async (req, res) => {
  const { query } = req.query;
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

      const batch = await Batch.findById(student.batch).populate(["courses", "teachers"]);
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
    const batches = await Batch.paginate(
      {
        $or: [
          { name: { $regex: searchQuery, $options: "i" } },
          { description: { $regex: searchQuery, $options: "i" } },
          { batch_type: { $regex: searchQuery, $options: "i" } },
        ],
      },
      {
        page: parseInt(req.query.page),
        limit: parseInt(req.query.limit),
        populate: ["courses", "teachers"],
      }
    );
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
    });
    await newBatch.save();
    res.status(200).json(newBatch);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateBatch = async (req, res) => {
  const { id } = req.params;
  const { name, description, batch_fee, batch_type, startdate, enddate } =
    req.body;
  try {
    await Batch.findByIdAndUpdate(id, {
      name,
      description,
      batch_fee,
      batch_type,
      startdate,
      enddate,
    });
    res.status(200).json("Batch updated successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteBatch = async (req, res) => {
  const { id } = req.params;
  try {
    await Batch.findByIdAndDelete(id);
    res.status(200).json("Batch deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const assignCoursesToBatch = async (req, res) => {
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
    batch.teachers = teacherIds;
    await batch.save();
    res.status(200).json("Teachers assigned to batch successfully");
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
