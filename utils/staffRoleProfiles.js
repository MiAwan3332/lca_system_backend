import { accessCatalog } from './accessCatalog.js';

export const STAFF_ROLE_CODES = {
  principle: 'lca-staff-principle', vice: 'lca-staff-vice-principle',
  accounts: 'lca-staff-account-officer', desk: 'lca-staff-information-desk',
};
export const staffProfileNames = {
  [STAFF_ROLE_CODES.principle]: 'Principle', [STAFF_ROLE_CODES.vice]: 'Vice Principle',
  [STAFF_ROLE_CODES.accounts]: 'Account Officer', [STAFF_ROLE_CODES.desk]: 'Information Desk',
};
const ops = (resource, handlers, scope = 'all') => handlers.map((handler) => {
  const route = accessCatalog.routes.find((item) => item.resource === resource && item.handler === handler && !item.public && !item.blocked);
  if (!route) throw new Error(`Unknown staff operation: ${resource}/${handler}`);
  return { permission: route.permission, scope };
});
const field = (group, action, fields) => ({ permission: `fields.${group}.${action}`, scope: 'all', ...(fields ? { fields } : {}) });
const output = (resource, ...actions) => actions.map((action) => {
  const permission = `${resource}.${action}`;
  if (!accessCatalog.permissions.some((item) => item.key === permission)) throw new Error(`Unknown output: ${permission}`);
  return { permission, scope: 'all' };
});
const unique = (grants) => [...new Map(grants.map((grant) => [`${grant.permission}:${grant.scope}`, grant])).values()];
const self = () => [
  ...ops('users', ['getUser', 'updateUser', 'changeAvatar', 'changePassword'], 'own'),
  ...ops('notifications', ['getNotifications', 'markAsRead', 'markAllAsRead'], 'own'),
  field('credentials', 'write', ['currentPassword', 'newPassword', 'password']),
  ...ops('operations', ['getCreationCapabilities']), ...output('files', 'download'),
];
const studentReads = ['getStudents', 'getStudent', 'getStudentsByBatch', 'getStudentHistory', 'getStudentPaymentLogs',
  'getQrCode', 'checkStudentFields', 'lookupStudentIdentity', 'getStudentsGraph', 'getStudentsByBatchesGraph',
  'getPendingFeeSlip', 'latestFeeReceipt', 'listEvidencePayments'];
const batchReads = ['getBatches', 'getBatch', 'getBatchCourses', 'getBatchTeachers', 'getBatchTeacherAssignments'];
const courseReads = ['getCourses', 'getCourse', 'getBatchAndCourses'];
const teacherReads = ['getTeachers', 'getTeacher'];
const feeReads = ['getFees', 'getFeeLogs', 'getFeesByStudentId', 'getFeeById', 'getFinanceReport', 'getStudentFeesReport'];
const admissions = ['addStudent', 'updateStudent', 'basicStudentUpdate', 'getCreationByKey', 'getCreationStatus', 'retryCreation', 'ensureStudentRollNumber'];
const qualifierReads = ['getQualifiers', 'getQualifier'];
const qualifierWrites = ['addQualifier', 'updateQualifier', 'toggleQualifierStatus'];
const academicReads = () => [
  ...ops('batches', batchReads), ...ops('courses', courseReads), ...ops('teachers', teacherReads),
  ...ops('timetable', ['getAllTimeTables', 'getTimeTableById', 'getTimeTableByStudentId', 'getTodayTimeTables']),
  ...ops('attendence', ['getAttendences', 'getTodayAttendenceByStudentId']),
];
const academicManage = () => [
  ...ops('batches', ['addBatch', 'updateBatch', 'toggleBatchStatus', 'assignCoursesToBatch', 'assignTeachersToBatch', 'assignTeacherCoursesToBatch', 'getBatchAssignmentOptions']),
  ...ops('courses', ['addCourse', 'updateCourse']), ...ops('teachers', ['addTeacher', 'updateTeacher']),
  ...ops('timetable', ['createTimeTable', 'updateTimeTable', 'deleteTimeTable']), ...ops('attendence', ['createAttendence']),
  ...ops('assignments', ['getAssignments', 'getAssignmentById', 'getBatchCoursesForAssignment', 'getAssignmentSubmissions', 'createAssignment', 'updateAssignment', 'publishAssignment', 'gradeSubmission', 'deleteAssignment']),
  ...ops('course-quizzes', ['getCourseQuizzes', 'getCourseQuizById', 'getBatchCoursesForQuiz', 'getCourseQuizAttempts', 'getCourseQuizAttemptById', 'createCourseQuiz', 'updateCourseQuiz', 'publishCourseQuiz', 'reviewCourseQuizAttempt', 'publishCourseQuizResults', 'deleteCourseQuiz']),
  ...ops('mcqs', ['getAllMcqs', 'getMcqsByCourseId', 'getMcqById', 'createMcq', 'updateMcq', 'bulkImportMcqs', 'deleteMcq']),
  ...ops('pastPapers', ['getAllPastPapers', 'getPastPaperById', 'getPastPaperByCourseAndYear', 'createPastPaper', 'updatePastPaper', 'deletePastPaper']),
  ...ops('quiz', ['getQuizSubjects', 'getQuizAttempts', 'getQuizAttemptLog', 'getQuizAttempt']),
];
const messageOps = () => ops('whatsapp', ['listWhatsAppQueue', 'getWhatsAppQueueStats', 'listWhatsAppTemplates', 'getWhatsAppTemplate', 'listWhatsAppTemplateTags', 'previewWhatsAppTemplate', 'enqueueBulkWhatsApp']);
const financialSummary = ['amount', 'action_amount', 'batch_fee', 'course_fee', 'fee', 'is_paid_batch', 'special_fee_options',
  'total_fee', 'paid_fee', 'pending_fee', 'remaining_fee', 'pending_amount', 'total_pending_amount', 'total_amount', 'total_fee_pending',
  'total_fee_recovered', 'total_fee_created', 'total_fee_defaulters', 'total_fee_discounted', 'discount_amount', 'discount_remarks',
  'overallFeeStatistics', 'batchWiseFeeStatistics', 'fee_overview', 'finance', 'due_date', 'pending_due_amount'];
const pricingWrites = ['amount', 'expense_date', 'payment_method', 'batch_fee', 'course_fee', 'fee', 'is_paid_batch', 'special_fee_options', 'assign_new_fee'];
const accountWrites = ['amount', 'paymentAmount', 'payment_method', 'payment_option', 'expense_date', 'requested_amount', 'refund_payment_method', 'fee_due_date'];
const deskGeneral = ['student_name', 'batch_name', 'class_time', 'authorized_by', 'slip_type', 'verify_base_url', 'student_id', 'name', 'father_name', 'batch', 'batch_id', 'student_id', 'studentId', 'course', 'course_id', 'courses', 'admission_date',
  'latest_degree', 'university', 'completion_year', 'marks_cgpa', 'province', 'exam_type', 'class_type', 'css_pms_roll_no', 'education_entries',
  'education_background', 'optional_subjects', 'special_selected_options', 'reuse_existing', 'qualifier_id', 'schedule_index', 'booked_for',
  'booked_notes', 'forSelf', 'source', 'template_key', 'template_id', 'audience', 'body', 'recipients', 'vars', 'notification_id', 'reason',
  'subject', 'category', 'target_role', 'description'];
const accountGeneral = ['payment_log_id', 'receipt_id', 'student_name', 'batch_name', 'class_time', 'authorized_by', 'slip_type', 'verify_base_url', 'name', 'student_id', 'studentId', 'batch', 'batch_id', 'description', 'title', 'category', 'next_installment_date', 'reason',
  'payment_option', 'source', 'template_key', 'template_id', 'audience', 'body', 'recipients', 'vars', 'notification_id', 'keep_evidence', 'replace_evidence'];

// Initial role templates omit approvals and discounts; administrators can grant them through role permissions.
export function staffRoleProfiles() {
  const commonReads = [field('general', 'read'), field('contact', 'read'), field('identity', 'read'),
    ...ops('announcements', ['getAnnouncements', 'getAnnouncementById', 'markAnnouncementAsRead']), ...ops('statistics', ['getStatistics'])];
  const academic = [
    ...self(), ...commonReads, field('general', 'write'), field('contact', 'write'), field('identity', 'write'),
    field('evidence', 'read'), field('evidence', 'write'), field('integration', 'read'), field('integration', 'write'),
    field('internal', 'read'), field('internal', 'write'), field('financial', 'read', financialSummary), field('financial', 'write', pricingWrites),
    ...ops('students', [...studentReads, ...admissions, 'toggleStudentStatus', 'toggleBatchStudentsStatus', 'transferStudentBatch', 'getBatchShifts']),
    ...academicReads(), ...academicManage(), ...ops('statistics', ['getBatchFinanceStats']), ...ops('qualifiers', [...qualifierReads, ...qualifierWrites]),
    ...ops('panelists', ['getPanelists', 'getPanelist', 'addPanelist', 'updatePanelist']),
    ...ops('interview-panels', ['getInterviewPanels', 'getInterviewPanel', 'addInterviewPanel', 'updateInterviewPanel', 'bookInterviewSlot', 'getConductInterview', 'getInterviewEvaluationDetails', 'startInterview', 'submitInterviewEvaluation']),
    ...ops('enrollments', ['getEnrollments', 'getEntrollmentbyStudent']), ...ops('admission-slips', ['issueAdmissionSlipVerification']),
    ...ops('users', ['getUsers', 'getFeeCollectors']), ...ops('fees', feeReads),
    ...ops('complaints', ['getComplaintMeta', 'getComplaints', 'getComplaintById', 'createComplaint', 'respondToComplaint']),
    ...ops('announcements', ['createAnnouncement', 'updateAnnouncement']),
    ...ops('seminars', ['getSeminars', 'getSeminar', 'getTodaySeminars', 'getSeminarsWithAttendeeCounts', 'getallSeminarwithAttendees', 'addSeminar', 'updateSeminar']),
    ...ops('attendees', ['getAttendees', 'getAttendee', 'getAttendeesBySeminar', 'createAttendee', 'updateAttendee']),
    ...ops('expenses', ['getExpenses', 'getExpense', 'addExpense'], 'own'), ...messageOps(),
    ...['students', 'qualifiers', 'batches', 'courses', 'teachers', 'timetable', 'attendence', 'assignments', 'course-quizzes', 'mcqs', 'fees', 'enrollments', 'admission-slips'].flatMap((resource) => output(resource, 'print', 'export')),
  ];
  const principle = [...academic.filter((grant) => !['fields.financial.read', 'expenses.get.expenses', 'expenses.get.expense'].includes(grant.permission)),
    field('financial', 'read'), ...ops('expenses', ['getExpenses', 'getExpense']), ...ops('refund-requests', ['getRefundRequests']),
    ...ops('statistics', ['getBatchFinanceStats']), ...ops('notifications', ['getFeeDueReport']),
    ...['access.read', 'access.audit', 'access.explain'].map((permission) => ({ permission, scope: 'all' })),
    ...ops('whatsapp', ['createWhatsAppTemplate', 'updateWhatsAppTemplate']), ...output('expenses', 'print', 'export'), ...output('refund-requests', 'print', 'export')];
  const accounts = [...self(), ...commonReads, field('general', 'write', accountGeneral), field('contact', 'write'),
    field('financial', 'read'), field('financial', 'write', accountWrites),
    field('evidence', 'read', ['image', 'avatar', 'payment_evidence', 'refund_evidence', 'evidence_status', 'evidence_edit_request']),
    field('evidence', 'write', ['image', 'avatar', 'payment_evidence', 'refund_evidence', 'keep_evidence', 'replace_evidence']),
    field('internal', 'read', ['remarks', 'approval_comment', 'rejection_comment', 'rejection_reason']), field('internal', 'write', ['remarks']),
    ...ops('students', [...studentReads, 'basicStudentUpdate', 'getBatchShifts', 'getOrCreatePendingFeeSlip', 'editPaymentEvidence', 'getCreationStatus', 'getCreationByKey']),
    ...ops('batches', batchReads), ...ops('courses', courseReads), ...ops('users', ['getFeeCollectors']),
    ...ops('fees', [...feeReads, 'payFee', 'collectPendingFee', 'createFee']), ...ops('statistics', ['getBatchFinanceStats']),
    ...ops('notifications', ['getFeeDueReport']), ...ops('qualifiers', qualifierReads),
    ...ops('expenses', ['getExpenses', 'getExpense', 'addExpense', 'updateExpense']),
    ...ops('refund-requests', ['getRefundRequests', 'createRefundRequest', 'processRefundRequest', 'updateRefundPayout']),
    ...ops('enrollments', ['getEnrollments', 'getEntrollmentbyStudent']), ...ops('admission-slips', ['issueAdmissionSlipVerification']),
    ...ops('complaints', ['getComplaintMeta']), ...ops('complaints', ['getComplaints', 'getComplaintById', 'createComplaint'], 'own'),
    ...messageOps(), ...['students', 'fees', 'expenses', 'refund-requests', 'admission-slips', 'enrollments'].flatMap((resource) => output(resource, 'print', 'export'))];
  const desk = [...self(), ...commonReads, field('general', 'write', deskGeneral), field('contact', 'write'), field('identity', 'write'),
    field('financial', 'read', ['batch_fee', 'course_fee', 'fee', 'is_paid_batch', 'special_fee_options', 'total_fee', 'paid_fee', 'pending_fee', 'discount_amount', 'discount_remarks']),
    field('evidence', 'read', ['image', 'avatar', 'photo', 'cnic_image', 'cnic_back_image', 'latest_degree_image', 'resume']),
    field('evidence', 'write', ['image', 'avatar', 'photo', 'cnic_image', 'cnic_back_image', 'latest_degree_image', 'resume']),
    field('internal', 'read', ['remarks']), field('internal', 'write', ['remarks']), field('integration', 'read'),
    ...ops('students', [...studentReads.filter((handler) => !['getStudentHistory', 'getStudentPaymentLogs', 'listEvidencePayments'].includes(handler)), ...admissions]),
    ...academicReads().filter((grant) => !grant.permission.startsWith('attendence.')),
    ...ops('qualifiers', [...qualifierReads, 'addQualifier', 'updateQualifier']),
    ...ops('interview-panels', ['getInterviewPanels', 'getInterviewPanel', 'bookInterviewSlot']),
    ...ops('enrollments', ['getEnrollments', 'getEntrollmentbyStudent']), ...ops('admission-slips', ['issueAdmissionSlipVerification']),
    ...ops('complaints', ['getComplaintMeta']), ...ops('complaints', ['getComplaints', 'getComplaintById', 'createComplaint'], 'own'),
    ...messageOps(), ...output('admission-slips', 'print'), ...output('students', 'print'), ...output('qualifiers', 'print')];
  return [
    { code: STAFF_ROLE_CODES.principle, name: 'Principle', description: 'Institution-wide oversight and academic operations. Approvals and discounts follow assigned permissions.', grants: unique(principle) },
    { code: STAFF_ROLE_CODES.vice, name: 'Vice Principle', description: 'Institution-wide academic operations, student administration and financial summaries; no collections by default. Approvals and discounts follow assigned permissions.', grants: unique(academic) },
    { code: STAFF_ROLE_CODES.accounts, name: 'Account Officer', description: 'Institution-wide collections, receipts, financial reporting, pending expenses and approved refund payouts; no approvals by default and no ledger rewrites.', grants: unique(accounts) },
    { code: STAFF_ROLE_CODES.desk, name: 'Information Desk', description: 'Institution-wide admissions, profile information, schedules and interview bookings; no collections or financial changes.', grants: unique(desk) },
  ];
}

// A role follows a profile through its built-in code or, for copies, its stored profile, so cloning keeps the same safeguards.
export const roleProfile = (role) => [role?.code, role?.profile].find((code) => Object.values(STAFF_ROLE_CODES).includes(code)) || null;
export function staffProfileCodes(context) {
  return context?.owner ? [] : [...new Set((context?.roles || []).map(roleProfile).filter(Boolean))];
}
// Plain-language summary of the safeguards each profile adds on top of its permissions (see staffRoleGuards.js).
export function staffProfileRules() {
  const slips = 'Admission slips are issued from the saved student record';
  const discounts = 'Approvals and discounts follow the permissions and limits assigned to this role';
  return [
    { code: STAFF_ROLE_CODES.principle, name: staffProfileNames[STAFF_ROLE_CODES.principle], rules: [discounts, 'WhatsApp: custom, admission, qualifier welcome and fee messages', slips] },
    { code: STAFF_ROLE_CODES.vice, name: staffProfileNames[STAFF_ROLE_CODES.vice], rules: [discounts, 'WhatsApp: custom messages only', slips] },
    { code: STAFF_ROLE_CODES.accounts, name: staffProfileNames[STAFF_ROLE_CODES.accounts], rules: [discounts, 'Cannot move a student to another batch while editing',
      'WhatsApp: fee payment, reminder and overdue messages from saved templates, to students only', slips] },
    { code: STAFF_ROLE_CODES.desk, name: staffProfileNames[STAFF_ROLE_CODES.desk], rules: [discounts, 'Cannot move a student to another batch while editing',
      'WhatsApp: admission and qualifier welcome messages from saved templates', slips] },
  ];
}
export function staffCommunication(context) {
  const codes = staffProfileCodes(context);
  if (!codes.length) return null;
  const processes = new Set();
  if (codes.includes(STAFF_ROLE_CODES.principle)) ['custom', 'student_admission', 'qualifier_welcome', 'fee_payment', 'fee_reminder', 'fee_overdue'].forEach((p) => processes.add(p));
  if (codes.includes(STAFF_ROLE_CODES.vice)) processes.add('custom');
  if (codes.includes(STAFF_ROLE_CODES.accounts)) ['fee_payment', 'fee_reminder', 'fee_overdue'].forEach((p) => processes.add(p));
  if (codes.includes(STAFF_ROLE_CODES.desk)) ['student_admission', 'qualifier_welcome'].forEach((p) => processes.add(p));
  const savedTemplatesOnly = !codes.some((code) => [STAFF_ROLE_CODES.principle, STAFF_ROLE_CODES.vice].includes(code));
  return { processes: [...processes], savedTemplatesOnly };
}
