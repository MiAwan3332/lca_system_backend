export const shuffleArray = (items) => {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

export const buildQuizAnswers = (mcqs, pattern) => {
  let orderedMcqs = [...mcqs];

  if (pattern === "shuffle_questions" || pattern === "shuffle_all") {
    orderedMcqs = shuffleArray(orderedMcqs);
  }

  return orderedMcqs.map((mcq, questionOrder) => {
    const options = [mcq.option1, mcq.option2, mcq.option3, mcq.option4];
    const correctOriginal = parseInt(mcq.correct_option, 10);

    let displayOptions = options;
    let correctDisplayIndex = correctOriginal;

    if (pattern === "shuffle_all") {
      const indexed = options.map((text, originalIndex) => ({
        text,
        originalIndex,
      }));
      const shuffled = shuffleArray(indexed);
      displayOptions = shuffled.map((item) => item.text);
      correctDisplayIndex = shuffled.findIndex(
        (item) => item.originalIndex === correctOriginal
      );
    }

    return {
      mcq: mcq._id,
      question_order: questionOrder,
      question: mcq.question,
      options: displayOptions,
      correct_option_index: correctDisplayIndex,
      selected_option: null,
      is_skipped: false,
      is_correct: null,
      answered_at: null,
    };
  });
};

export const sanitizeAttemptForClient = (attempt, includeAnswers = false) => {
  const base = {
    _id: attempt._id,
    student: attempt.student,
    course: attempt.course,
    pattern: attempt.pattern,
    question_count_requested: attempt.question_count_requested,
    timer_enabled: attempt.timer_enabled,
    timer_seconds: attempt.timer_seconds,
    started_at: attempt.started_at,
    ended_at: attempt.ended_at,
    duration_seconds: attempt.duration_seconds,
    total_questions: attempt.total_questions,
    correct_count: attempt.correct_count,
    incorrect_count: attempt.incorrect_count,
    skipped_count: attempt.skipped_count,
    score: attempt.score,
    percentage: attempt.percentage,
    status: attempt.status,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };

  if (!includeAnswers) {
    return {
      ...base,
      answers: (attempt.answers || []).map((answer) => ({
        question_order: answer.question_order,
        question: answer.question,
        options: answer.options,
        selected_option: answer.selected_option,
        is_skipped: answer.is_skipped,
        answered_at: answer.answered_at,
      })),
    };
  }

  return {
    ...base,
    answers: (attempt.answers || []).map((answer) => ({
      question_order: answer.question_order,
      question: answer.question,
      options: answer.options,
      selected_option: answer.selected_option,
      is_skipped: answer.is_skipped,
      is_correct: answer.is_correct,
      correct_option_index: answer.correct_option_index,
      answered_at: answer.answered_at,
      mcq: answer.mcq,
    })),
  };
};

export const gradeAttempt = (attempt) => {
  let correctCount = 0;
  let incorrectCount = 0;
  let skippedCount = 0;

  const gradedAnswers = attempt.answers.map((answer) => {
    const answerData = answer.toObject ? answer.toObject() : { ...answer };
    const isSkipped =
      answerData.is_skipped ||
      answerData.selected_option === null ||
      answerData.selected_option === undefined;

    if (isSkipped) {
      skippedCount += 1;
      return {
        ...answerData,
        is_skipped: true,
        is_correct: false,
      };
    }

    const isCorrect =
      answerData.selected_option === answerData.correct_option_index;
    if (isCorrect) {
      correctCount += 1;
    } else {
      incorrectCount += 1;
    }

    return {
      ...answerData,
      is_skipped: false,
      is_correct: isCorrect,
    };
  });

  const totalQuestions = attempt.answers.length;
  const percentage =
    totalQuestions > 0
      ? Math.round((correctCount / totalQuestions) * 100)
      : 0;

  return {
    gradedAnswers,
    correctCount,
    incorrectCount,
    skippedCount,
    score: correctCount,
    percentage,
    totalQuestions,
  };
};
