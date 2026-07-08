import Mcq from "../models/mcqs.js";
import Course from "../models/courses.js";
import Batch from "../models/batches.js";
import mongoose from "mongoose";
import dotenv from "dotenv";
import {
  isTeacherRole,
  applyTeacherCourseFilter,
  canAccessCourse,
  buildEmptyPaginatedResponse,
} from "../utils/lmsAccess.js";
dotenv.config();

const populateOptions = { path: "courseId", select: "name description fee" };

const normalizeCorrectOption = (value) => {
  const normalized = String(value ?? "").trim().toUpperCase();
  const map = {
    A: "0",
    B: "1",
    C: "2",
    D: "3",
    "0": "0",
    "1": "1",
    "2": "2",
    "3": "3",
  };
  if (map[normalized] !== undefined) {
    return map[normalized];
  }
  throw new Error(`Invalid correct option "${value}". Use A, B, C, D or 0-3.`);
};

const resolveCourseId = async (courseValue) => {
  const trimmed = String(courseValue ?? "").trim();
  if (!trimmed) {
    throw new Error("Course is required");
  }

  if (mongoose.Types.ObjectId.isValid(trimmed)) {
    const courseById = await Course.findById(trimmed);
    if (courseById) {
      return courseById._id;
    }
  }

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const courseByName = await Course.findOne({
    name: { $regex: new RegExp(`^${escaped}$`, "i") },
  });
  if (courseByName) {
    return courseByName._id;
  }

  throw new Error(`Course "${trimmed}" not found`);
};

const validateMcqRow = (row, rowNumber) => {
  const requiredFields = [
    ["question", "Question"],
    ["option1", "Option-A"],
    ["option2", "Option-B"],
    ["option3", "Option-C"],
    ["option4", "Option-D"],
    ["correct_option", "Correct Option"],
    ["courseId", "Course"],
  ];

  for (const [field, label] of requiredFields) {
    if (!String(row[field] ?? "").trim()) {
      throw new Error(`Row ${rowNumber}: ${label} is required`);
    }
  }
};

export const createMcq = async (req, res) => {
  const {
    question,
    option1,
    option2,
    option3,
    option4,
    correct_option,
    courseId,
  } = req.body;

  try {
    const resolvedCourseId = await resolveCourseId(courseId);
    if (!(await canAccessCourse(req, resolvedCourseId))) {
      return res.status(403).json({ message: "You do not have access to this course" });
    }

    const newMcq = new Mcq({
      question,
      option1,
      option2,
      option3,
      option4,
      correct_option,
      courseId: resolvedCourseId,
    });
    await newMcq.save();
    const populatedMcq = await Mcq.findById(newMcq._id).populate(populateOptions);
    res.status(201).json(populatedMcq);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateMcq = async (req, res) => {
  const { id } = req.params;
  const {
    question,
    option1,
    option2,
    option3,
    option4,
    correct_option,
    courseId,
  } = req.body;
  try {
    const existingMcq = await Mcq.findById(id);
    if (!existingMcq) {
      return res.status(404).json({ message: "Mcq not found" });
    }

    const resolvedCourseId = courseId
      ? await resolveCourseId(courseId)
      : existingMcq.courseId;

    if (!(await canAccessCourse(req, resolvedCourseId))) {
      return res.status(403).json({ message: "You do not have access to this course" });
    }

    const updatedMcq = await Mcq.findByIdAndUpdate(
      id,
      {
        question,
        option1,
        option2,
        option3,
        option4,
        correct_option,
        courseId: resolvedCourseId,
      },
      { new: true, runValidators: true }
    ).populate(populateOptions);
    res.status(200).json(updatedMcq);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAllMcqs = async (req, res) => {
  const { query, course_id, batch_id } = req.query;

  try {
    const searchQuery = query ? query : "";
    const filter = {
      $or: [
        { question: { $regex: searchQuery, $options: "i" } },
        { option1: { $regex: searchQuery, $options: "i" } },
        { option2: { $regex: searchQuery, $options: "i" } },
        { option3: { $regex: searchQuery, $options: "i" } },
        { option4: { $regex: searchQuery, $options: "i" } },
      ],
    };

    if (course_id) {
      filter.courseId = course_id;
    }

    if (batch_id) {
      const batch = await Batch.findById(batch_id).select("courses");
      if (!batch) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
      const courseIds = (batch.courses || []).map((course) => course._id || course);
      filter.courseId = course_id
        ? courseIds.some((id) => String(id) === String(course_id))
          ? course_id
          : { $in: [] }
        : { $in: courseIds };
      if (filter.courseId?.$in?.length === 0) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
    }

    if (isTeacherRole(req)) {
      await applyTeacherCourseFilter(req, filter, "courseId");
      if (filter.courseId?.$in?.length === 0) {
        return res.status(200).json(buildEmptyPaginatedResponse(parseInt(req.query.limit, 10) || 10));
      }
    }

    const mcqs = await Mcq.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: populateOptions,
    });
    res.status(200).json(mcqs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getMcqById = async (req, res) => {
  const { id } = req.params;
  try {
    const mcq = await Mcq.findById(id).populate(populateOptions);
    if (!mcq) {
      return res.status(404).json({ message: "Mcq not found" });
    }
    if (!(await canAccessCourse(req, mcq.courseId?._id || mcq.courseId))) {
      return res.status(403).json({ message: "You do not have access to this MCQ" });
    }
    res.status(200).json(mcq);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteMcq = async (req, res) => {
  const { id } = req.params;
  try {
    const mcq = await Mcq.findById(id);
    if (!mcq) {
      return res.status(404).json({ message: "Mcq not found" });
    }
    if (!(await canAccessCourse(req, mcq.courseId))) {
      return res.status(403).json({ message: "You do not have access to this course" });
    }
    await Mcq.findByIdAndDelete(id);
    res.status(200).json({ message: "Mcq deleted successfully", _id: id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const bulkImportMcqs = async (req, res) => {
  const { mcqs } = req.body;

  if (!Array.isArray(mcqs) || mcqs.length === 0) {
    return res.status(400).json({ message: "No MCQs provided for import" });
  }

  if (mcqs.length > 500) {
    return res.status(400).json({ message: "Maximum 500 MCQs can be imported at once" });
  }

  const results = {
    imported: 0,
    failed: [],
  };

  for (let index = 0; index < mcqs.length; index += 1) {
    const rowNumber = index + 2;
    const row = mcqs[index];

    try {
      const courseId = await resolveCourseId(row.course);
      if (!(await canAccessCourse(req, courseId))) {
        throw new Error(`You do not have access to course "${row.course}"`);
      }
      const correct_option = normalizeCorrectOption(row.correct_option);

      const mcqPayload = {
        question: String(row.question).trim(),
        option1: String(row.option1).trim(),
        option2: String(row.option2).trim(),
        option3: String(row.option3).trim(),
        option4: String(row.option4).trim(),
        correct_option,
        courseId,
      };

      validateMcqRow(
        {
          ...mcqPayload,
          courseId: mcqPayload.courseId.toString(),
        },
        rowNumber
      );

      const newMcq = new Mcq(mcqPayload);
      await newMcq.save();
      results.imported += 1;
    } catch (error) {
      results.failed.push({
        row: rowNumber,
        message: error.message,
      });
    }
  }

  res.status(200).json({
    message: `Imported ${results.imported} of ${mcqs.length} MCQs`,
    ...results,
  });
};

export const getMcqsByCourseId = async (req, res) => {
  const { id } = req.params;
  try {
    if (!(await canAccessCourse(req, id))) {
      return res.status(403).json({ message: "You do not have access to this course" });
    }

    const mcqs = await Mcq.find({ courseId: id });

    if (!mcqs || mcqs.length === 0) {
      return res.status(404).json({ message: "MCQs not found" });
    }
    const formattedMcqs = mcqs.map((mcq) => {
      const options = [
        mcq.option1.trim(),
        mcq.option2.trim(),
        mcq.option3.trim(),
        mcq.option4.trim(),
      ];
      const correctOptionIndex = mcq.correct_option.trim();

      return {
        question: mcq.question,
        options: options,
        correctOptionIndex: correctOptionIndex,
      };
    });

    res.status(200).json({ MCQ: formattedMcqs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
