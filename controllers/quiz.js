import Mcq from "../models/mcqs.js";
import Course from "../models/courses.js";
import Batch from "../models/batches.js";
import QuizAttempt from "../models/quizAttempts.js";
import {
  isStudentRole,
  resolveStudentId,
  resolveStudentRecord,
} from "../utils/studentScope.js";
import {
  buildQuizAnswers,
  sanitizeAttemptForClient,
  gradeAttempt,
} from "../utils/quizHelpers.js";

const getAllowedCourseIds = async (req) => {
  if (!isStudentRole(req)) {
    return null;
  }

  const student = await resolveStudentRecord(req);
  if (!student?.batch) {
    return [];
  }

  const batch = await Batch.findById(student.batch).populate("courses");
  return (batch?.courses || []).map((course) => course._id.toString());
};

export const getQuizSubjects = async (req, res) => {
  try {
    const allowedCourseIds = await getAllowedCourseIds(req);

    const mcqCounts = await Mcq.aggregate([
      {
        $group: {
          _id: "$courseId",
          mcq_count: { $sum: 1 },
        },
      },
    ]);

    const countMap = mcqCounts.reduce((acc, item) => {
      acc[item._id.toString()] = item.mcq_count;
      return acc;
    }, {});

    let courses = await Course.find().sort({ name: 1 });

    if (allowedCourseIds !== null) {
      courses = courses.filter((course) =>
        allowedCourseIds.includes(course._id.toString())
      );
    }

    const subjects = courses
      .map((course) => ({
        _id: course._id,
        name: course.name,
        description: course.description,
        mcq_count: countMap[course._id.toString()] || 0,
      }))
      .filter((course) => course.mcq_count > 0);

    res.status(200).json(subjects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const startQuiz = async (req, res) => {
  const {
    course_id,
    pattern = "sequential",
    question_count,
    timer_enabled = false,
    timer_seconds,
  } = req.body;

  try {
    if (!course_id) {
      return res.status(400).json({ message: "Subject (course) is required" });
    }

    const validPatterns = ["sequential", "shuffle_questions", "shuffle_all"];
    if (!validPatterns.includes(pattern)) {
      return res.status(400).json({ message: "Invalid quiz pattern" });
    }

    const studentId = await resolveStudentId(req);
    if (!studentId) {
      return res.status(403).json({ message: "Student profile not found" });
    }

    const allowedCourseIds = await getAllowedCourseIds(req);
    if (
      allowedCourseIds !== null &&
      !allowedCourseIds.includes(course_id.toString())
    ) {
      return res.status(403).json({ message: "Access denied for this subject" });
    }

    const course = await Course.findById(course_id);
    if (!course) {
      return res.status(404).json({ message: "Subject not found" });
    }

    const mcqs = await Mcq.find({ courseId: course_id }).sort({ createdAt: 1 });
    if (!mcqs.length) {
      return res.status(404).json({ message: "No MCQs found for this subject" });
    }

    let selectedMcqs = [...mcqs];
    if (question_count && Number(question_count) > 0) {
      selectedMcqs = selectedMcqs.slice(0, Number(question_count));
    }

    const answers = buildQuizAnswers(selectedMcqs, pattern);

    const attempt = await QuizAttempt.create({
      student: studentId,
      course: course_id,
      pattern,
      question_count_requested: question_count ? Number(question_count) : null,
      timer_enabled: Boolean(timer_enabled),
      timer_seconds: timer_enabled ? Number(timer_seconds) || null : null,
      total_questions: answers.length,
      answers,
    });

    const populated = await QuizAttempt.findById(attempt._id)
      .populate("course", "name description")
      .populate("student", "name email");

    res.status(201).json(sanitizeAttemptForClient(populated));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getQuizAttempt = async (req, res) => {
  const { id } = req.params;

  try {
    const attempt = await QuizAttempt.findById(id)
      .populate("course", "name description")
      .populate("student", "name email");

    if (!attempt) {
      return res.status(404).json({ message: "Quiz attempt not found" });
    }

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (attempt.student?._id?.toString() !== studentId) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    const includeAnswers = attempt.status === "submitted";
    res.status(200).json(sanitizeAttemptForClient(attempt, includeAnswers));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveQuizAnswer = async (req, res) => {
  const { id } = req.params;
  const { question_order, selected_option, is_skipped = false } = req.body;

  try {
    const attempt = await QuizAttempt.findById(id);
    if (!attempt) {
      return res.status(404).json({ message: "Quiz attempt not found" });
    }

    if (attempt.status !== "in_progress") {
      return res.status(400).json({ message: "Quiz attempt is already closed" });
    }

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (attempt.student.toString() !== studentId) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    const answer = attempt.answers.find(
      (item) => item.question_order === Number(question_order)
    );

    if (!answer) {
      return res.status(404).json({ message: "Question not found in attempt" });
    }

    if (is_skipped) {
      answer.selected_option = null;
      answer.is_skipped = true;
    } else {
      answer.selected_option = Number(selected_option);
      answer.is_skipped = false;
    }
    answer.answered_at = new Date();

    await attempt.save();

    res.status(200).json(sanitizeAttemptForClient(attempt));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const submitQuiz = async (req, res) => {
  const { id } = req.params;

  try {
    const attempt = await QuizAttempt.findById(id)
      .populate("course", "name description")
      .populate("student", "name email");

    if (!attempt) {
      return res.status(404).json({ message: "Quiz attempt not found" });
    }

    if (attempt.status !== "in_progress") {
      return res.status(400).json({ message: "Quiz attempt is already submitted" });
    }

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (attempt.student?._id?.toString() !== studentId) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    const endedAt = new Date();
    const durationSeconds = Math.max(
      0,
      Math.floor((endedAt - new Date(attempt.started_at)) / 1000)
    );

    const grading = gradeAttempt(attempt);

    attempt.answers = grading.gradedAnswers;
    attempt.correct_count = grading.correctCount;
    attempt.incorrect_count = grading.incorrectCount;
    attempt.skipped_count = grading.skippedCount;
    attempt.score = grading.score;
    attempt.percentage = grading.percentage;
    attempt.total_questions = grading.totalQuestions;
    attempt.ended_at = endedAt;
    attempt.duration_seconds = durationSeconds;
    attempt.status = "submitted";

    await attempt.save();

    res.status(200).json(sanitizeAttemptForClient(attempt, true));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getQuizAttempts = async (req, res) => {
  const { course_id, student_id, page, limit } = req.query;

  try {
    const filter = { status: "submitted" };

    if (course_id) {
      filter.course = course_id;
    }

    if (isStudentRole(req)) {
      const ownStudentId = await resolveStudentId(req);
      filter.student = ownStudentId;
    } else if (student_id) {
      filter.student = student_id;
    }

    const attempts = await QuizAttempt.paginate(filter, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: [
        { path: "course", select: "name description" },
        { path: "student", select: "name email" },
      ],
    });

    attempts.docs = attempts.docs.map((attempt) =>
      sanitizeAttemptForClient(attempt, false)
    );

    res.status(200).json(attempts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getQuizAttemptLog = async (req, res) => {
  const { id } = req.params;

  try {
    const attempt = await QuizAttempt.findById(id)
      .populate("course", "name description")
      .populate("student", "name email");

    if (!attempt) {
      return res.status(404).json({ message: "Quiz attempt not found" });
    }

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (attempt.student?._id?.toString() !== studentId) {
        return res.status(403).json({ message: "Access denied" });
      }
    }

    if (attempt.status !== "submitted") {
      return res
        .status(400)
        .json({ message: "Attempt log is available after submission only" });
    }

    res.status(200).json(sanitizeAttemptForClient(attempt, true));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
