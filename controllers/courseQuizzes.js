import CourseQuiz from "../models/courseQuizzes.js";
import CourseQuizAttempt from "../models/courseQuizAttempts.js";
import Batch from "../models/batches.js";
import {
  buildQuizQuestions,
  canStudentStartQuiz,
  deriveQuizRuntimeStatus,
  gradeAttemptAnswers,
  sanitizeQuestionForStudent,
  shouldShowQuizResult,
} from "../utils/courseQuizHelpers.js";
import {
  canAccessBatch,
  canAccessCourse,
  courseInBatch,
  denyUnlessCanManage,
  getStudentBatchId,
  isStudentRole,
  resolveStudentId,
  studentInBatch,
  isTeacherRole,
  getTeacherScope,
} from "../utils/lmsAccess.js";
import { createNotification, notifyBatchStudents } from "../utils/notificationService.js";

const populateOptions = [
  { path: "batch", select: "name" },
  { path: "course", select: "name" },
  { path: "created_by", select: "name email" },
];

const attemptPopulate = [
  { path: "quiz", populate: populateOptions },
  { path: "student", select: "name email" },
  { path: "reviewed_by", select: "name email" },
];

const parseQuizBody = (body) => {
  const payload = { ...body };
  const boolFields = [
    "randomize_questions",
    "negative_marking",
    "use_mcq_bank",
    "auto_submit_on_timeout",
    "hide_correct_answers_until_release",
  ];
  boolFields.forEach((field) => {
    if (payload[field] !== undefined) {
      payload[field] = payload[field] === true || payload[field] === "true";
    }
  });
  ["duration_minutes", "passing_marks", "max_marks", "max_attempts", "question_count", "negative_mark_value"].forEach(
    (field) => {
      if (payload[field] !== undefined) payload[field] = Number(payload[field]);
    }
  );
  if (typeof payload.embedded_questions === "string") {
    try {
      payload.embedded_questions = JSON.parse(payload.embedded_questions);
    } catch {
      payload.embedded_questions = [];
    }
  }
  return payload;
};

export const createCourseQuiz = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const payload = parseQuizBody(req.body);
    if (!(await canAccessBatch(req, payload.batch))) {
      return res.status(403).json({ message: "You cannot create quizzes for this batch" });
    }
    if (!(await courseInBatch(payload.batch, payload.course))) {
      return res.status(400).json({ message: "Course does not belong to selected batch" });
    }

    const quiz = await CourseQuiz.create({
      ...payload,
      created_by: req.user.user.id,
      status: payload.status === "Scheduled" ? "Scheduled" : "Draft",
      published_at: payload.status === "Scheduled" ? new Date() : null,
    });

    if (quiz.status === "Scheduled") {
      await notifyBatchStudents({
        batchId: quiz.batch,
        type: "quiz_available",
        title: "New Quiz Scheduled",
        message: `${quiz.title} has been scheduled.`,
        entityType: "course_quiz",
        entityId: quiz._id,
      });
    }

    const populated = await CourseQuiz.findById(quiz._id).populate(populateOptions);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getCourseQuizzes = async (req, res) => {
  try {
    const filter = {};
    const { batch_id, course_id, status, query } = req.query;
    if (batch_id) filter.batch = batch_id;
    if (course_id) filter.course = course_id;
    if (status) filter.status = status;

    if (isStudentRole(req)) {
      const batchId = await getStudentBatchId(req);
      if (!batchId) return res.status(200).json({ docs: [], totalDocs: 0 });
      filter.batch = batchId;
      filter.status = { $in: ["Scheduled", "Active", "Closed", "Published"] };
    } else if (denyUnlessCanManage(req, res)) {
      return;
    } else if (isTeacherRole(req)) {
      const scope = await getTeacherScope(req);
      if (!scope?.batchIds?.length) {
        return res.status(200).json({ docs: [], totalDocs: 0, page: 1, limit: 10 });
      }
      if (batch_id) {
        filter.batch = scope.batchIds.includes(String(batch_id)) ? batch_id : { $in: [] };
      } else {
        filter.batch = { $in: scope.batchIds };
      }
      if (course_id) {
        filter.course = scope.courseIds.includes(String(course_id)) ? course_id : { $in: [] };
      } else {
        filter.course = { $in: scope.courseIds };
      }
    }

    if (query) {
      filter.$or = [
        { title: { $regex: query, $options: "i" } },
        { description: { $regex: query, $options: "i" } },
      ];
    }

    const quizzes = await CourseQuiz.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { start_datetime: -1 },
      populate: populateOptions,
    });

    quizzes.docs = quizzes.docs.map((quiz) => ({
      ...quiz.toObject(),
      runtime_status: deriveQuizRuntimeStatus(quiz),
    }));

    res.status(200).json(quizzes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getCourseQuizById = async (req, res) => {
  try {
    const quiz = await CourseQuiz.findById(req.params.id).populate(populateOptions);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });

    if (isStudentRole(req)) {
      if (!(await studentInBatch(req, quiz.batch._id || quiz.batch))) {
        return res.status(403).json({ message: "Quiz not available" });
      }
    } else if (!(await canAccessBatch(req, quiz.batch._id || quiz.batch))) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.status(200).json({
      ...quiz.toObject(),
      runtime_status: deriveQuizRuntimeStatus(quiz),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateCourseQuiz = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const quiz = await CourseQuiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    const payload = parseQuizBody(req.body);
    Object.assign(quiz, payload);
    await quiz.save();
    const populated = await CourseQuiz.findById(quiz._id).populate(populateOptions);
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteCourseQuiz = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const quiz = await CourseQuiz.findByIdAndDelete(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    await CourseQuizAttempt.deleteMany({ quiz: quiz._id });
    res.status(200).json({ message: "Quiz deleted", _id: quiz._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const publishCourseQuiz = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const quiz = await CourseQuiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    quiz.status = "Scheduled";
    quiz.published_at = new Date();
    await quiz.save();

    await notifyBatchStudents({
      batchId: quiz.batch,
      type: "quiz_available",
      title: "New Quiz Available",
      message: `${quiz.title} is now scheduled.`,
      entityType: "course_quiz",
      entityId: quiz._id,
    });

    const populated = await CourseQuiz.findById(quiz._id).populate(populateOptions);
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const startCourseQuizAttempt = async (req, res) => {
  try {
    const studentId = await resolveStudentId(req);
    if (!studentId) return res.status(403).json({ message: "Student account required" });

    const quiz = await CourseQuiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    if (!(await studentInBatch(req, quiz.batch))) {
      return res.status(403).json({ message: "Quiz not assigned to your batch" });
    }
    if (!canStudentStartQuiz(quiz)) {
      return res.status(400).json({ message: "Quiz is not active right now" });
    }

    const existingAttempts = await CourseQuizAttempt.countDocuments({
      quiz: quiz._id,
      student: studentId,
    });
    if (existingAttempts >= quiz.max_attempts) {
      return res.status(400).json({ message: "Maximum attempts reached" });
    }

    const inProgress = await CourseQuizAttempt.findOne({
      quiz: quiz._id,
      student: studentId,
      status: "In Progress",
    });
    if (inProgress) {
      const hideAnswers = quiz.hide_correct_answers_until_release;
      return res.status(200).json({
        attempt: inProgress,
        questions: inProgress.answers.map((a) =>
          sanitizeQuestionForStudent(a, hideAnswers)
        ),
      });
    }

    const questions = await buildQuizQuestions(quiz);
    const answers = questions.map((q) => ({
      question_id: q.question_id,
      question_type: q.question_type,
      question: q.question,
      options: q.options,
      correct_answers: q.correct_answers,
      marks: q.marks,
      selected_answers: [],
      text_answer: "",
    }));

    const attempt = await CourseQuizAttempt.create({
      quiz: quiz._id,
      student: studentId,
      attempt_number: existingAttempts + 1,
      answers,
      max_score: questions.reduce((sum, q) => sum + (q.marks || 0), 0),
      status: "In Progress",
    });

    const hideAnswers = quiz.hide_correct_answers_until_release;
    res.status(201).json({
      attempt,
      questions: questions.map((q) => sanitizeQuestionForStudent(q, hideAnswers)),
      duration_minutes: quiz.duration_minutes,
      auto_submit_on_timeout: quiz.auto_submit_on_timeout,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveCourseQuizAnswer = async (req, res) => {
  try {
    const studentId = await resolveStudentId(req);
    const attempt = await CourseQuizAttempt.findById(req.params.attemptId);
    if (!attempt || String(attempt.student) !== String(studentId)) {
      return res.status(404).json({ message: "Attempt not found" });
    }
    if (attempt.status !== "In Progress") {
      return res.status(400).json({ message: "Attempt is already submitted" });
    }

    const { question_id, selected_answers, text_answer } = req.body;
    attempt.answers = attempt.answers.map((answer) => {
      if (answer.question_id !== question_id) return answer;
      return {
        ...answer.toObject?.() || answer,
        selected_answers: selected_answers || [],
        text_answer: text_answer || "",
      };
    });
    await attempt.save();
    res.status(200).json(attempt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const submitCourseQuizAttempt = async (req, res) => {
  try {
    const studentId = await resolveStudentId(req);
    const attempt = await CourseQuizAttempt.findById(req.params.attemptId).populate("quiz");
    if (!attempt || String(attempt.student) !== String(studentId)) {
      return res.status(404).json({ message: "Attempt not found" });
    }
    if (attempt.status !== "In Progress") {
      return res.status(400).json({ message: "Attempt already submitted" });
    }

    const { gradedAnswers, autoScore, manualPending } = gradeAttemptAnswers(
      attempt.answers.map((a) => a.toObject?.() || a)
    );

    attempt.answers = gradedAnswers;
    attempt.auto_graded_score = autoScore;
    attempt.total_score = autoScore + (attempt.manual_score || 0);
    attempt.percentage =
      attempt.max_score > 0
        ? Math.round((attempt.total_score / attempt.max_score) * 100)
        : 0;
    attempt.passed = attempt.percentage >= (attempt.quiz?.passing_marks || 0);
    attempt.status = manualPending ? "Under Review" : "Submitted";
    attempt.submitted_at = new Date();
    attempt.duration_seconds = Math.floor(
      (attempt.submitted_at - attempt.started_at) / 1000
    );

    const quiz = attempt.quiz;
    if (!manualPending && shouldShowQuizResult(quiz, attempt)) {
      attempt.result_visible = true;
      attempt.status = "Published";
      attempt.result_published_at = new Date();
    }

    await attempt.save();

    const response = {
      attempt_id: attempt._id,
      status: attempt.status,
      percentage: attempt.result_visible ? attempt.percentage : null,
      passed: attempt.result_visible ? attempt.passed : null,
      total_score: attempt.result_visible ? attempt.total_score : null,
      max_score: attempt.max_score,
      result_visible: attempt.result_visible,
    };

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getCourseQuizAttempts = async (req, res) => {
  try {
    const filter = {};
    if (req.query.quiz_id) filter.quiz = req.query.quiz_id;
    if (req.query.status) filter.status = req.query.status;

    if (isStudentRole(req)) {
      filter.student = await resolveStudentId(req);
    } else if (denyUnlessCanManage(req, res)) {
      return;
    }

    const attempts = await CourseQuizAttempt.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { createdAt: -1 },
      populate: attemptPopulate,
    });

    res.status(200).json(attempts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getCourseQuizAttemptById = async (req, res) => {
  try {
    const attempt = await CourseQuizAttempt.findById(req.params.id).populate(attemptPopulate);
    if (!attempt) return res.status(404).json({ message: "Attempt not found" });

    if (isStudentRole(req)) {
      const studentId = await resolveStudentId(req);
      if (String(attempt.student._id || attempt.student) !== String(studentId)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const quiz = attempt.quiz;
      if (!shouldShowQuizResult(quiz, attempt)) {
        return res.status(200).json({
          attempt_id: attempt._id,
          status: attempt.status,
          result_visible: false,
          message: "Results are not published yet",
        });
      }
    }

    res.status(200).json(attempt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const reviewCourseQuizAttempt = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const { manual_score, feedback_updates = [], publish_result } = req.body;
    const attempt = await CourseQuizAttempt.findById(req.params.id).populate("quiz");
    if (!attempt) return res.status(404).json({ message: "Attempt not found" });

    if (Array.isArray(feedback_updates)) {
      attempt.answers = attempt.answers.map((answer) => {
        const update = feedback_updates.find((u) => u.question_id === answer.question_id);
        if (!update) return answer;
        const updated = answer.toObject?.() || { ...answer };
        if (update.manual_marks !== undefined) updated.manual_marks = Number(update.manual_marks);
        if (update.feedback !== undefined) updated.feedback = update.feedback;
        if (update.manual_marks !== undefined) {
          updated.awarded_marks = update.manual_marks;
          updated.requires_manual_grading = false;
        }
        return updated;
      });
    }

    attempt.manual_score = Number(manual_score || 0);
    attempt.auto_graded_score = attempt.answers.reduce(
      (sum, a) => sum + (a.awarded_marks || 0),
      0
    );
    attempt.total_score = attempt.auto_graded_score + attempt.manual_score;
    attempt.percentage =
      attempt.max_score > 0
        ? Math.round((attempt.total_score / attempt.max_score) * 100)
        : 0;
    attempt.passed = attempt.percentage >= (attempt.quiz?.passing_marks || 0);
    attempt.reviewed_by = req.user.user.id;
    attempt.reviewed_at = new Date();
    attempt.status = "Graded";

    if (publish_result === true || shouldShowQuizResult(attempt.quiz, attempt)) {
      attempt.result_visible = true;
      attempt.status = "Published";
      attempt.result_published_at = new Date();
      await createNotification({
        recipientStudentId: attempt.student,
        type: "quiz_result_published",
        title: "Quiz Result Published",
        message: `Your result for ${attempt.quiz?.title || "quiz"} is now available.`,
        entityType: "quiz_attempt",
        entityId: attempt._id,
      });
    }

    await attempt.save();
    res.status(200).json(attempt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const publishCourseQuizResults = async (req, res) => {
  if (denyUnlessCanManage(req, res)) return;

  try {
    const quiz = await CourseQuiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });

    const attempts = await CourseQuizAttempt.find({
      quiz: quiz._id,
      status: { $in: ["Submitted", "Graded", "Under Review"] },
    });

    for (const attempt of attempts) {
      attempt.result_visible = true;
      attempt.status = "Published";
      attempt.result_published_at = new Date();
      await attempt.save();
      await createNotification({
        recipientStudentId: attempt.student,
        type: "quiz_result_published",
        title: "Quiz Results Published",
        message: `Results for ${quiz.title} are now available.`,
        entityType: "quiz_attempt",
        entityId: attempt._id,
      });
    }

    quiz.status = "Published";
    await quiz.save();
    res.status(200).json({ message: `Published results for ${attempts.length} attempts` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBatchCoursesForQuiz = async (req, res) => {
  try {
    const { batchId } = req.params;
    if (isStudentRole(req)) {
      const studentBatch = await getStudentBatchId(req);
      if (String(studentBatch) !== String(batchId)) {
        return res.status(403).json({ message: "Access denied" });
      }
    } else if (!(await canAccessBatch(req, batchId))) {
      return res.status(403).json({ message: "Access denied" });
    }
    const batch = await Batch.findById(batchId).populate("courses", "name description");
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    let courses = batch.courses || [];

    if (isTeacherRole(req)) {
      const scope = await getTeacherScope(req);
      const allowedCourseIds = new Set(
        (scope?.assignments || [])
          .filter((item) => item.batchId === String(batchId))
          .map((item) => item.courseId)
      );
      courses = courses.filter((course) =>
        allowedCourseIds.has(String(course._id || course))
      );
    }

    res.status(200).json(courses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
