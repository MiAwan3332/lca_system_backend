import Mcq from "../models/mcqs.js";

const normalizeAnswer = (value) => String(value ?? "").trim().toLowerCase();

export const deriveQuizRuntimeStatus = (quiz, now = new Date()) => {
  if (quiz.status === "Draft") return "Draft";
  const start = new Date(quiz.start_datetime);
  const end = new Date(quiz.end_datetime);
  if (now < start) return "Scheduled";
  if (now >= start && now <= end) return "Active";
  if (quiz.status === "Published") return "Published";
  return "Closed";
};

export const canStudentStartQuiz = (quiz, now = new Date()) => {
  const runtime = deriveQuizRuntimeStatus(quiz, now);
  return runtime === "Active";
};

export const shouldShowQuizResult = (quiz, attempt, now = new Date()) => {
  if (!attempt || attempt.status === "In Progress") return false;

  switch (quiz.result_publication) {
    case "immediate":
      return true;
    case "after_review":
      return attempt.status === "Published" || attempt.result_visible === true;
    case "scheduled":
      return quiz.result_release_at && now >= new Date(quiz.result_release_at);
    case "after_end_date":
    default:
      return now > new Date(quiz.end_datetime);
  }
};

export const buildQuizQuestions = async (quiz) => {
  if (quiz.use_mcq_bank) {
    const mcqs = await Mcq.find({ courseId: quiz.course }).limit(500);
    let pool = [...mcqs];
    if (quiz.randomize_questions) {
      pool = pool.sort(() => Math.random() - 0.5);
    }
    const selected = pool.slice(0, quiz.question_count || pool.length);
    return selected.map((mcq, index) => ({
      question_id: String(mcq._id),
      question_type: "multiple_choice",
      question: mcq.question,
      options: [mcq.option1, mcq.option2, mcq.option3, mcq.option4],
      correct_answers: [mcq[`option${parseInt(mcq.correct_option, 10) + 1}`]],
      marks: 1,
      negative_marks: quiz.negative_marking ? quiz.negative_mark_value || 0 : 0,
      order: index + 1,
    }));
  }

  return (quiz.embedded_questions || []).map((q, index) => ({
    question_id: String(q._id),
    question_type: q.question_type,
    question: q.question,
    options: q.options || [],
    correct_answers: q.correct_answers || [],
    marks: q.marks || 1,
    negative_marks: quiz.negative_marking ? q.negative_marks || 0 : 0,
    order: index + 1,
  }));
};

export const sanitizeQuestionForStudent = (question, hideAnswers = true) => ({
  question_id: question.question_id,
  question_type: question.question_type,
  question: question.question,
  options: question.options || [],
  marks: question.marks,
  order: question.order,
  ...(hideAnswers
    ? {}
    : {
        correct_answers: question.correct_answers,
      }),
});

export const gradeObjectiveAnswer = (question, studentAnswer) => {
  const requiresManual =
    question.question_type === "short_answer" || question.question_type === "essay";

  if (requiresManual) {
    return {
      requires_manual_grading: true,
      is_correct: false,
      awarded_marks: 0,
    };
  }

  const selected = Array.isArray(studentAnswer)
    ? studentAnswer.map(normalizeAnswer)
    : [normalizeAnswer(studentAnswer)];

  const correct = (question.correct_answers || []).map(normalizeAnswer).sort();
  const chosen = [...selected].sort();

  let isCorrect = false;
  if (question.question_type === "multiple_select") {
    isCorrect =
      correct.length === chosen.length &&
      correct.every((value, idx) => value === chosen[idx]);
  } else if (question.question_type === "true_false") {
    isCorrect = normalizeAnswer(studentAnswer) === correct[0];
  } else {
    isCorrect = chosen[0] === correct[0];
  }

  if (isCorrect) {
    return {
      requires_manual_grading: false,
      is_correct: true,
      awarded_marks: question.marks || 1,
    };
  }

  const negative = question.negative_marks || 0;
  return {
    requires_manual_grading: false,
    is_correct: false,
    awarded_marks: negative > 0 ? -negative : 0,
  };
};

export const gradeAttemptAnswers = (answers = []) => {
  let autoScore = 0;
  let manualPending = false;
  const graded = answers.map((answer) => {
    const studentAnswer =
      answer.question_type === "multiple_select"
        ? answer.selected_answers
        : answer.selected_answers?.[0] || answer.text_answer;
    const result = gradeObjectiveAnswer(answer, studentAnswer);
    if (result.requires_manual_grading) manualPending = true;
    autoScore += result.awarded_marks || 0;
    return {
      ...answer,
      requires_manual_grading: result.requires_manual_grading,
      is_correct: result.is_correct,
      awarded_marks: result.awarded_marks,
    };
  });
  return { gradedAnswers: graded, autoScore, manualPending };
};
