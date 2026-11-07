import { accessCatalog } from './accessCatalog.js';
import { catalogDigest } from './accessMigrationPlan.js';

// Explicit reviewed operations: new endpoints are never inherited by a resource wildcard.
const operation = (resource, handlers, scope = 'all', extra = {}) => handlers.map((handler) => {
  const route = accessCatalog.routes.find((item) => item.resource === resource && item.handler === handler && !item.public && !item.blocked);
  if (!route) throw new Error(`Unclassified baseline operation: ${resource}/${handler}`);
  return { permission: route.permission, scope, ...extra };
});
const field = (group, action, fields) => ({ permission: `fields.${group}.${action}`, scope: 'all', ...(fields ? { fields } : {}) });
const output = (resource, action) => ({ permission: `${resource}.${action}`, scope: 'all' });
const unique = (grants) => [...new Map(grants.map((grant) => [`${grant.permission}:${grant.scope}`, grant])).values()];
const baseline = () => [
  ...operation('users', ['getUser', 'updateUser', 'changeAvatar', 'changePassword'], 'own'),
  ...operation('notifications', ['getNotifications', 'markAsRead', 'markAllAsRead'], 'own'),
  ...operation('statistics', ['getStatistics'], 'own'),
  field('general', 'read'), field('general', 'write'),
  field('contact', 'read'), field('contact', 'write', ['phone', 'address', 'city', 'father_phone', 'guardian_phone']),
  field('evidence', 'read'), field('evidence', 'write'),
  field('credentials', 'write', ['currentPassword', 'newPassword', 'password']), output('files', 'download'),
];
const googleOwn = () => operation('google', ['getGoogleStatus', 'getGoogleConnectUrl', 'disconnectGoogle'], 'own');
const studentReads = ['getStudents', 'getStudent', 'getStudentsByBatch', 'getStudentPaymentLogs', 'getStudentHistory', 'getQrCode', 'checkStudentFields', 'getStudentsGraph', 'getStudentsByBatchesGraph'];
const admissionCommands = ['lookupStudentIdentity', 'addStudent', 'updateStudent', 'basicStudentUpdate', 'bulkImportStudents',
  'editPaymentEvidence', 'getCreationByKey', 'getCreationStatus', 'retryCreation', 'ensureStudentRollNumber',
  'getPendingFeeSlip', 'getOrCreatePendingFeeSlip', 'latestFeeReceipt', 'listEvidencePayments'];
const batchReads = ['getBatches', 'getBatch', 'getBatchCourses', 'getBatchTeachers', 'getBatchTeacherAssignments'];
const feeReads = ['getFinanceReport', 'getStudentFeesReport', 'getFees', 'getFeeLogs', 'getFeesByStudentId', 'getFeeById'];
const teachingReads = () => [
  ...operation('courses', ['getCourses', 'getCourse', 'getBatchAndCourses']), ...operation('teachers', ['getTeachers', 'getTeacher']),
  ...operation('timetable', ['getAllTimeTables', 'getTimeTableById', 'getTimeTableByStudentId', 'getTodayTimeTables']),
  ...operation('attendence', ['getAttendences', 'getTodayAttendenceByStudentId']),
];
const qualifierOps = ['getQualifiers', 'getQualifier', 'addQualifier', 'bulkImportQualifiers', 'fillNullQualifierField', 'updateQualifier', 'toggleQualifierStatus'];
const financialFields = accessCatalog.fieldGroups.financial.filter((name) => !/discount|salary|expense|refund|profit|revenue|\bnet\b/i.test(name));
const writableFinance = accessCatalog.fieldGroups.financial.filter((name) => !/discount|salary/i.test(name));
const admission = () => [
  ...baseline(), field('contact', 'write'), ...googleOwn(), ...operation('users', ['getFeeCollectors']), ...operation('students', [...studentReads, ...admissionCommands]),
  ...operation('batches', batchReads), ...operation('courses', ['getCourses', 'getCourse']),
  ...operation('teachers', ['getTeachers', 'getTeacher']),
  ...operation('enrollments', ['getEnrollments', 'getEntrollmentbyStudent', 'createEnrollment']),
  ...operation('fees', [...feeReads, 'collectPendingFee', 'payFee']),
  ...operation('qualifiers', qualifierOps), ...operation('notifications', ['getFeeDueReport']),
  ...operation('statistics', ['getStatistics']),
  ...operation('announcements', ['getAnnouncements', 'getAnnouncementById', 'markAnnouncementAsRead']),
  ...operation('admission-slips', ['issueAdmissionSlipVerification']),
  ...operation('operations', ['getCreationCapabilities']),
  field('identity', 'read'), field('identity', 'write'), field('financial', 'read', financialFields),
  field('financial', 'write', writableFinance), field('internal', 'read', ['remarks', 'internal_notes']),
  field('internal', 'write', ['remarks', 'internal_notes']), field('integration', 'read'),
  ...['students', 'qualifiers', 'fees', 'admission-slips'].flatMap((resource) => [output(resource, 'export'), output(resource, 'print')]),
];
const oversight = () => [
  ...baseline(), field('contact', 'write'), ...googleOwn(), ...operation('students', [...studentReads, 'lookupStudentIdentity', 'addStudent', 'updateStudent',
    'basicStudentUpdate', 'bulkImportStudents', 'getCreationByKey', 'getCreationStatus', 'retryCreation', 'toggleStudentStatus',
    'transferStudentBatch', 'getBatchShifts', 'getPendingFeeSlip', 'getOrCreatePendingFeeSlip', 'latestFeeReceipt', 'listEvidencePayments']),
  ...operation('users', ['getUsers', 'getFeeCollectors', 'addUser', 'updateUser', 'deleteUser', 'getCreationByKey', 'getCreationStatus', 'retryCreation']),
  ...operation('batches', batchReads), ...teachingReads(), ...operation('qualifiers', qualifierOps),
  ...operation('panelists', ['getPanelists', 'getPanelist', 'addPanelist', 'updatePanelist']),
  ...operation('interview-panels', ['getInterviewPanels', 'getInterviewPanel', 'addInterviewPanel', 'updateInterviewPanel',
    'bookInterviewSlot', 'getConductInterview', 'getInterviewEvaluationDetails', 'startInterview', 'submitInterviewEvaluation']),
  ...operation('fees', [...feeReads, 'discountFee']),
  ...operation('enrollments', ['getEnrollments', 'getEntrollmentbyStudent', 'createEnrollment']),
  ...operation('refund-requests', ['getRefundRequests', 'createRefundRequest']),
  ...operation('refund-requests', ['approveRefundRequest', 'rejectRefundRequest'], 'all', { noSelfApproval: true }),
  ...operation('expenses', ['getExpenses', 'getExpense']),
  ...operation('expenses', ['approveExpense', 'rejectExpense'], 'all', { noSelfApproval: true }),
  ...operation('statistics', ['getStatistics', 'getBatchFinanceStats']), ...operation('notifications', ['getFeeDueReport']),
  ...operation('announcements', ['getAnnouncements', 'getAnnouncementById', 'createAnnouncement', 'updateAnnouncement', 'markAnnouncementAsRead']),
  ...operation('complaints', ['getComplaintMeta', 'getComplaints', 'getComplaintById', 'respondToComplaint']),
  ...operation('activity-logs', ['getActivityLogs', 'getActivityLogModules']), ...operation('operations', ['getCreationCapabilities']),
  ...operation('admission-slips', ['issueAdmissionSlipVerification']),
  ...['identity', 'financial', 'internal', 'integration'].map((group) => field(group, 'read')),
  field('identity', 'write'), field('financial', 'write', accessCatalog.fieldGroups.financial.filter((name) => /discount/i.test(name) || ['amount', 'requested_amount', 'fee', 'course_fee', 'batch_fee', 'special_fee_options', 'fee_options'].includes(name))),
  field('internal', 'write'), field('integration', 'write'),
  ...['students', 'qualifiers', 'fees', 'batches', 'admission-slips'].flatMap((resource) => [output(resource, 'export'), output(resource, 'print')]),
];
const academicManage = () => [
  ...operation('batches', ['addBatch', 'updateBatch', 'toggleBatchStatus', 'assignCoursesToBatch', 'assignTeachersToBatch', 'assignTeacherCoursesToBatch']),
  ...operation('courses', ['addCourse', 'updateCourse']), ...operation('teachers', ['addTeacher', 'updateTeacher']),
  ...operation('timetable', ['createTimeTable', 'updateTimeTable', 'deleteTimeTable']), ...operation('attendence', ['createAttendence']),
  ...operation('assignments', ['getAssignments', 'getAssignmentById', 'getBatchCoursesForAssignment', 'getAssignmentSubmissions',
    'createAssignment', 'updateAssignment', 'publishAssignment', 'gradeSubmission']),
  ...operation('course-quizzes', ['getCourseQuizzes', 'getCourseQuizById', 'getBatchCoursesForQuiz', 'getCourseQuizAttempts', 'getCourseQuizAttemptById',
    'createCourseQuiz', 'updateCourseQuiz', 'publishCourseQuiz', 'reviewCourseQuizAttempt', 'publishCourseQuizResults']),
  ...operation('mcqs', ['getAllMcqs', 'getMcqsByCourseId', 'getMcqById', 'createMcq', 'bulkImportMcqs', 'updateMcq']),
  ...operation('pastPapers', ['getAllPastPapers', 'getPastPaperById', 'createPastPaper', 'updatePastPaper', 'getPastPaperByCourseAndYear']),
  ...operation('seminars', ['getSeminars', 'getSeminar', 'addSeminar', 'updateSeminar', 'getTodaySeminars', 'getSeminarsWithAttendeeCounts', 'getallSeminarwithAttendees']),
  ...operation('attendees', ['getAttendees', 'getAttendee', 'createAttendee', 'updateAttendee', 'getAttendeesBySeminar']),
  ...operation('google', ['syncBatchClassroomCourse', 'syncAssignmentCoursework', 'syncTimetableCalendarEvent']),
];
const safeLearnerGeneral = accessCatalog.fieldGroups.general.filter((name) => !/^(correct_answers?|correct_option(_index)?|answer_key)$|booked_(for|phone|notes)|final_remarks|key_strength|major_weakness|internal|evaluator|verdict/i.test(name));
const learnerBaseline = () => [...baseline().filter((grant) => grant.permission !== 'fields.general.read'), field('general', 'read', safeLearnerGeneral)];

export function approvedBlueprints() {
  const executive = [...oversight(), ...academicManage().filter((grant) => {
    const route = accessCatalog.routes.find((item) => item.permission === grant.permission); return route?.method === 'GET';
  })];
  const principal = [...oversight(), ...academicManage()];
  const finance = [...admission().filter((grant) => grant.permission !== 'fields.financial.read'), field('financial', 'read'),
    ...operation('students', ['toggleStudentStatus', 'transferStudentBatch', 'getBatchShifts']),
    ...operation('refund-requests', ['getRefundRequests', 'createRefundRequest', 'processRefundRequest', 'updateRefundPayout']),
    ...operation('expenses', ['getExpenses', 'getExpense', 'addExpense', 'updateExpense']), ...operation('statistics', ['getBatchFinanceStats'])];
  const teacher = [...baseline(), ...googleOwn(), field('integration', 'read'), field('integration', 'write'),
    ...operation('teachers', ['getTeachers', 'getTeacher', 'updateTeacher'], 'own'),
    ...operation('students', ['getStudents', 'getStudent', 'getStudentsByBatch'], 'assigned'),
    ...operation('batches', batchReads, 'assigned'), ...operation('courses', ['getCourses', 'getCourse'], 'assigned'),
    ...operation('timetable', ['getAllTimeTables', 'getTimeTableById', 'getTodayTimeTables', 'createTimeTable', 'updateTimeTable'], 'assigned'),
    ...operation('attendence', ['getAttendences', 'createAttendence'], 'assigned'),
    ...academicManage().filter((grant) => /^(assignments|course-quizzes|mcqs|pastPapers|google)\./.test(grant.permission)).map((grant) => ({ ...grant, scope: 'assigned' })),
    ...operation('announcements', ['getAnnouncements', 'getAnnouncementById', 'markAnnouncementAsRead'], 'assigned')];
  const student = [...learnerBaseline(), ...googleOwn(), field('identity', 'read'), field('identity', 'write'), field('integration', 'read'),
    field('financial', 'read', financialFields),
    ...operation('students', ['getStudent', 'getStudents', 'updateStudentinfo', 'checkStudentFields', 'getQrCode', 'getStudentPaymentLogs',
      'getPendingFeeSlip', 'latestFeeReceipt', 'getStudentHistory'], 'own'),
    ...operation('batches', ['getBatches', 'getBatch', 'getBatchCourses', 'getBatchTeachers'], 'assigned'),
    ...operation('courses', ['getCourses', 'getCourse', 'getBatchAndCourses'], 'assigned'),
    ...operation('teachers', ['getTeacher', 'getTeachers'], 'assigned'),
    ...operation('timetable', ['getAllTimeTables', 'getTimeTableById', 'getTimeTableByStudentId', 'getTodayTimeTables'], 'assigned'),
    ...operation('attendence', ['getAttendences', 'getTodayAttendenceByStudentId'], 'own'),
    ...operation('enrollments', ['getEntrollmentbyStudent'], 'own'),
    ...operation('fees', ['getFeesByStudentId', 'getFeeById', 'getFeeLogs'], 'own'),
    ...operation('assignments', ['getAssignments', 'getAssignmentById', 'getMyAssignmentCourses', 'getAssignmentSubmissions', 'submitAssignment'], 'assigned'),
    ...operation('course-quizzes', ['getCourseQuizzes', 'getCourseQuizById', 'getCourseQuizAttempts', 'getCourseQuizAttemptById',
      'startCourseQuizAttempt', 'saveCourseQuizAnswer', 'submitCourseQuizAttempt'], 'assigned'),
    ...operation('quiz', ['getQuizSubjects', 'startQuiz', 'getQuizAttempts', 'getQuizAttemptLog', 'getQuizAttempt', 'saveQuizAnswer', 'submitQuiz'], 'assigned'),
    ...operation('announcements', ['getAnnouncements', 'getAnnouncementById', 'markAnnouncementAsRead'], 'assigned'), output('students', 'print'), output('fees', 'print')];
  const qualifier = [...learnerBaseline(), field('identity', 'read'), field('identity', 'write'),
    ...operation('qualifiers', ['getQualifiers', 'getQualifier', 'updateQualifier'], 'own'),
    ...operation('batches', ['getBatch'], 'own'),
    ...operation('interview-panels', ['getInterviewPanels', 'getInterviewPanel', 'bookInterviewSlot'], 'own'), output('qualifiers', 'print')];
  const panelist = [...baseline(), field('internal', 'read', ['final_remarks']), field('internal', 'write', ['final_remarks']),
    ...operation('panelists', ['getPanelist', 'getPanelists', 'updatePanelist'], 'own'),
    ...operation('interview-panels', ['getInterviewPanels', 'getInterviewPanel', 'getConductInterview', 'getInterviewEvaluationDetails',
      'startInterview', 'submitInterviewEvaluation'], 'assigned')];
  return [
    { code: 'lca-v1-executive', name: 'Executive Administrator', legacyNames: ['CEO'], grants: unique(executive) },
    { code: 'lca-v1-principal', name: 'Principal / Academic Administrator', legacyNames: ['Principal', 'Vice-Principal'], grants: unique(principal) },
    { code: 'lca-v1-finance', name: 'Finance and Admissions Officer', legacyNames: ['Accounts'], grants: unique(finance) },
    { code: 'lca-v1-admissions', name: 'Admissions Officer', legacyNames: ['Information Office'], grants: unique(admission()) },
    { code: 'lca-v1-teacher', name: 'Teacher', legacyNames: ['teacher', 'Teacher'], grants: unique(teacher) },
    { code: 'lca-v1-student', name: 'Student', legacyNames: ['student'], grants: unique(student) },
    { code: 'lca-v1-qualifier', name: 'Qualifier', legacyNames: ['qualifier'], grants: unique(qualifier) },
    { code: 'lca-v1-panelist', name: 'Interview Panelist', legacyNames: ['panelist'], grants: unique(panelist) },
    { code: 'lca-v1-pending-staff', name: 'Staff - Pending Assignment', legacyNames: [], grants: unique(baseline()) },
  ];
}

export function approvedMigrationPlan(users) {
  const owners = users.filter((user) => user.platformOwner && !user.disabledAt).map((user) => String(user._id));
  const defaults = { staff: 'lca-v1-pending-staff', student: 'lca-v1-student', teacher: 'lca-v1-teacher', qualifier: 'lca-v1-qualifier', panelist: 'lca-v1-panelist' };
  return { schemaVersion: 2, reviewed: true, activationReviewed: true, activateUsers: true, catalogDigest: catalogDigest(accessCatalog),
    ownerUserIds: owners, defaults, roles: approvedBlueprints().map((role) => ({ ...role, policyReviewed: true, unmapped: [],
      targets: users.filter((user) => !owners.includes(String(user._id)) && role.legacyNames.includes(user.role)).map((user) => ({
        userId: String(user._id), expectedRole: user.role, accountType: user.accountType || (['student', 'teacher', 'qualifier', 'panelist'].includes(String(user.role).toLowerCase()) ? String(user.role).toLowerCase() : 'staff'),
      })) })) };
}
