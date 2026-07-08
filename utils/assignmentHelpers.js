export const computeAssignmentSubmissionStatus = (assignment, submittedAt = new Date()) => {
  if (!assignment.has_deadline || !assignment.submission_deadline) {
    return { isLate: false, status: "Submitted" };
  }

  const deadline = new Date(assignment.submission_deadline);
  const isLate = submittedAt > deadline;

  if (!isLate) {
    return { isLate: false, status: "Submitted" };
  }

  const policy = assignment.late_submission_policy;
  if (policy === "no_late") {
    return { isLate: true, status: "Late Submitted", blocked: true };
  }

  if (policy === "late_until_deadline" && assignment.late_deadline) {
    const lateDeadline = new Date(assignment.late_deadline);
    if (submittedAt > lateDeadline) {
      return { isLate: true, status: "Late Submitted", blocked: true };
    }
  }

  return { isLate: true, status: "Late Submitted", blocked: false };
};

export const applyLatePenalty = (marks, assignment) => {
  if (!assignment.late_penalty_percent) return marks;
  const penalty = (marks * assignment.late_penalty_percent) / 100;
  return Math.max(0, marks - penalty);
};

export const isAssignmentVisibleToStudent = (assignment, now = new Date()) => {
  if (assignment.visibility_status !== "Published") return false;
  const availableFrom = new Date(assignment.availability_date);
  return now >= availableFrom;
};
