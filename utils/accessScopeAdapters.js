import mongoose from 'mongoose';

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const none = () => ({ _id: { $in: [] } });
const ids = (values = []) => values.filter((value) => mongoose.isValidObjectId(String(value))).map(oid);
const union = (clauses) => clauses.length ? { $or: clauses } : none();

// Record relations are resolved before the request context is installed, then reused by query hooks.
export async function scopedModelFilters(context, route, grants) {
  const models = Object.values(mongoose.models);
  const filters = Object.fromEntries(models.map((model) => [model.modelName, none()]));
  const batchIds = ids([...new Set(grants.flatMap((grant) => grant.scope === 'selected' ? grant.batchIds || [] : context.assignedBatchIds))]);
  const courseIds = ids([...new Set(grants.flatMap((grant) => grant.scope === 'selected' ? grant.courseIds || [] : context.assignedCourseIds))]);
  const pairClauses = grants.flatMap((grant) => grant.scope === 'assigned' && context.assignedPairs
    ? context.assignedPairs.map((pair) => ({ batch: oid(pair.batchId), course: oid(pair.courseId) }))
    : grant.scope === 'selected' ? [{ batch: { $in: ids(grant.batchIds) }, ...(grant.courseIds?.length ? { course: { $in: ids(grant.courseIds) } } : {}) }]
      : [{ batch: { $in: batchIds } }]);
  const teaching = union(pairClauses);
  const own = context.accountType === 'student';
  const teacher = context.accountType === 'teacher';
  const self = oid(context.userId);
  filters.User = { _id: self };
  filters.Complaint = { submitted_by: self };
  filters.Expense = { created_by: self };
  if (route.handler === 'createComplaint') filters.User = {}; // Recipients are chosen by the server, not the submitter.
  filters.Batch = { _id: { $in: batchIds } }; filters.Course = { _id: { $in: courseIds } };
  const scopeStudent = own && context.studentId ? { _id: oid(context.studentId) } : teacher ? { batch: { $in: batchIds } } : none();
  filters.Student = scopeStudent;
  if (context.teacherId) filters.Teacher = { _id: oid(context.teacherId) };
  if (own && mongoose.models.Batch && batchIds.length) {
    const batches = await mongoose.models.Batch.find({ _id: { $in: batchIds } }).select('teachers teacher_course_assignments').lean();
    filters.Teacher = { _id: { $in: ids(batches.flatMap((batch) => [...(batch.teachers || []), ...(batch.teacher_course_assignments || []).map((entry) => entry.teacher)])) } };
  }
  if (context.qualifierId) filters.Qualifier = { _id: oid(context.qualifierId) };
  if (context.panelistId) filters.Panelist = { _id: oid(context.panelistId) };
  filters.GoogleAccount = { user: self };
  filters.Notification = { $or: [{ recipient_user: self }, ...(context.studentId ? [{ recipient_student: oid(context.studentId) }] : [])] };
  filters.Announcement = { batches: { $in: batchIds } };
  filters.Assignment = teaching; filters.CourseQuiz = teaching; filters.TimeTable = teaching;
  filters.Mcqs = { course: { $in: courseIds } }; filters.pastPapers = { course: { $in: courseIds } };
  const students = own && context.studentId ? [oid(context.studentId)] : teacher && mongoose.models.Student
    ? (await mongoose.models.Student.find(scopeStudent).select('_id').lean()).map((student) => student._id) : [];
  filters.Enrollment = { student: { $in: students }, batch: { $in: batchIds } };
  filters.Attendence = own ? { student: { $in: students } } : teaching;
  for (const name of ['Fee', 'FeeLog', 'FeeReceipt', 'PendingFeeSlip', 'RefundRequest', 'StudentBatchShift']) filters[name] = { student: { $in: students } };
  filters.CreationRequest = { recordId: route.resource === 'users' ? self : { $in: students } };
  const assignments = teacher && mongoose.models.Assignment ? await mongoose.models.Assignment.find(teaching).select('_id').lean() : [];
  const quizzes = teacher && mongoose.models.CourseQuiz ? await mongoose.models.CourseQuiz.find(teaching).select('_id').lean() : [];
  filters.AssignmentSubmission = own ? { student: { $in: students } } : teacher ? { assignment: { $in: assignments.map((item) => item._id) } } : none();
  filters.CourseQuizAttempt = own ? { student: { $in: students } } : teacher ? { quiz: { $in: quizzes.map((item) => item._id) } } : none();
  filters.QuizAttempt = own ? { student: { $in: students } } : teacher ? { student: { $in: students }, course: { $in: courseIds } } : none();
  if (context.accountType === 'qualifier' && context.qualifierId) {
    filters.InterviewPanel = { $or: [{ status: { $in: ['active', 'scheduled', 'in_progress'] } },
      { 'schedules.booked_user_id': self }, { 'schedules.booked_qualifier_id': oid(context.qualifierId) }] };
    filters.InterviewEvaluation = { qualifier_id: oid(context.qualifierId) };
  }
  if (context.panelistId) {
    const assignedPanels = { 'members.panelist_id': oid(context.panelistId) };
    const qualifierPanels = context.accountType==='qualifier' && context.qualifierId && ['getInterviewPanels','getInterviewPanel','getInterviewEvaluationDetails','bookInterviewSlot'].includes(route.handler) ? filters.InterviewPanel : null;
    filters.InterviewPanel = qualifierPanels ? union([qualifierPanels,assignedPanels]) : assignedPanels;
    const panels = mongoose.models.InterviewPanel ? await mongoose.models.InterviewPanel.find(assignedPanels).select('schedules members').lean() : [];
    if(route.handler==='getInterviewEvaluationDetails')filters.Panelist={_id:{$in:ids(panels.flatMap(p=>(p.members||[]).map(m=>m.panelist_id)))}};
    filters.Qualifier = { _id: { $in: ids([context.qualifierId,...panels.flatMap((panel) => (panel.schedules || []).map((slot) => slot.booked_qualifier_id))]) } };
    const ownEvaluation={ panel_id: { $in: panels.map((panel) => panel._id) }, ...(route.handler === 'getInterviewEvaluationDetails' ? {} : { panelist_id: oid(context.panelistId) }) };
    filters.InterviewEvaluation=context.qualifierId&&route.handler==='getInterviewEvaluationDetails'?union([ownEvaluation,{qualifier_id:oid(context.qualifierId)}]):ownEvaluation;
  }
  return filters;
}
