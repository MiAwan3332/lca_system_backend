import mongoose from 'mongoose';
import User from '../models/users.js';
import Role from '../models/roles.js';
import Assignment from '../models/accessAssignment.js';
import { repairDefaultAccess } from './defaultAccess.js';
import { accessContext } from './accessContext.js';
import { creationAudit } from './creationAudit.js';
import { accessCatalog, classifyAccessRoute, FIELD_GROUPS, canAccessField, redactAccessFields } from './accessCatalog.js';
import { effectiveGrants, permissionGrants, evaluateAccess, legacyAccountType, legacyOwner, legacyStaffManager } from './accessPolicy.js';

export const accessMode = () => ['legacy', 'observe', 'enforce'].includes(process.env.AUTHORIZATION_MODE) ? process.env.AUTHORIZATION_MODE : 'legacy';
const denied = (message = 'Permission denied') => Object.assign(new Error(message), { status: 403, code: 'ACCESS_DENIED' });
const objectId = (id) => new mongoose.Types.ObjectId(String(id));
export async function loadAccessContext(user) {
  if (!user.accessManaged && !user.platformOwner && accessMode() === 'enforce') await repairDefaultAccess(user);
  const owner = Boolean(user.platformOwner || (accessMode() !== 'enforce' && !user.accessManaged && legacyOwner(user.role)));
  const resolveGrants = !owner && (user.accessManaged || accessMode() !== 'legacy');
  const assignments = resolveGrants ? await Assignment.find({ user: user._id, revokedAt: null }).lean() : [];
  const roles = assignments.length ? await Role.find({ _id: { $in: assignments.map((item) => item.role) }, managed: true, active: true }).lean() : [];
  const context = { userId: String(user._id), owner,
    accountType: user.accountType || legacyAccountType(user.role), disabled: Boolean(user.disabledAt),
    enforced: Boolean(user.accessManaged || accessMode() === 'enforce'), grants: effectiveGrants(assignments, roles),
    roles: roles.map(({ _id, name, revision }) => ({ _id, name, revision })), assignedBatchIds: [], assignedCourseIds: [] };
  if (context.accountType === 'teacher' && mongoose.models.Teacher && mongoose.models.Batch) {
    const teacher = await mongoose.models.Teacher.findOne({ $or: [{ user: user._id }, { email: user.email }] }).select('_id').lean();
    if (teacher) {
      const batches = await mongoose.models.Batch.find({ $or: [{ teachers: teacher._id }, { 'teacher_course_assignments.teacher': teacher._id }] }).select('_id courses teachers teacher_course_assignments').lean();
      context.teacherId = String(teacher._id);
      context.assignedBatchIds = batches.map((batch) => String(batch._id));
      context.assignedPairs = batches.flatMap((batch) => {
        const explicit = (batch.teacher_course_assignments || []).filter((item) => String(item.teacher) === String(teacher._id));
        const courses = explicit.length ? explicit.flatMap((item) => item.courses || (item.course ? [item.course] : [])) :
          (batch.teachers || []).some((id) => String(id) === String(teacher._id)) ? batch.courses || [] : [];
        return courses.map((course) => ({ batchId: String(batch._id), courseId: String(course) }));
      });
      context.assignedCourseIds = [...new Set(context.assignedPairs.map((pair) => pair.courseId))];
    }
  }
  if (context.accountType === 'student' && mongoose.models.Student) {
    const student = await mongoose.models.Student.findOne({ $or: [{ user: user._id }, { email: user.email }] }).select('_id batch is_active').lean();
    if (!student || student.is_active === false) context.disabled = true;
    else {
      context.studentId = String(student._id); context.assignedBatchIds = student.batch ? [String(student.batch)] : [];
      const batch = student.batch && mongoose.models.Batch ? await mongoose.models.Batch.findById(student.batch).select('courses').lean() : null;
      context.assignedCourseIds = (batch?.courses || []).map(String);
      context.assignedPairs = context.assignedCourseIds.map((courseId) => ({ batchId: String(student.batch), courseId }));
    }
  }
  for (const [category, modelName, key] of [['qualifier', 'Qualifier', 'qualifierId'], ['panelist', 'Panelist', 'panelistId']]) {
    if (!context.enforced && accessMode() === 'legacy') continue;
    if (context.accountType !== category || !mongoose.models[modelName] || !String(user.email || '').trim()) continue;
    const profiles = await mongoose.models[modelName].find({ email: user.email }).select('_id').limit(2).lean();
    if (profiles.length === 1) context[key] = String(profiles[0]._id);
  }
  return context;
}

const primaryModels = {
  students: ['Student', 'Fee', 'FeeLog', 'Enrollment', 'StudentBatchShift', 'FeeReceipt', 'PendingFeeSlip', 'CreationRequest'],
  users: ['User', 'CreationRequest'], batches: ['Batch'], courses: ['Course'], teachers: ['Teacher'],
  fees: ['Fee', 'FeeLog', 'Student', 'FeeReceipt'], 'refund-requests': ['RefundRequest'], expenses: ['Expense'],
  timetable: ['TimeTable'], attendence: ['Attendence'], enrollments: ['Enrollment'], assignments: ['Assignment', 'AssignmentSubmission'],
  'course-quizzes': ['CourseQuiz', 'CourseQuizAttempt'], quiz: ['QuizAttempt'], complaints: ['Complaint'],
  notifications: ['Notification'], announcements: ['Announcement'], panelists: ['Panelist'], qualifiers: ['Qualifier'],
  'interview-panels': ['InterviewPanel', 'InterviewEvaluation'], seminars: ['Seminar'], attendees: ['Attendee'],
  mcqs: ['Mcqs'], pastPapers: ['pastPapers'],
};
export async function buildModelFilters(context, route, grants) {
  if (grants.some((grant) => grant.scope === 'all')) return {};
  if (!primaryModels[route.resource]) throw denied('This operation currently requires an all-records grant');
  if (/Archive|Deleted/.test(route.handler) || route.handler === 'latestFeeReceipt' || (route.resource === 'refund-requests' && grants.some((grant) => grant.scope !== 'own'))) {
    throw denied('Historical archives and cross-batch snapshots require an all-records grant');
  }
  const journalRoute = /Creation/.test(route.handler);
  const models = [...new Set(Object.values(primaryModels).flat())].filter((name) =>
    (name !== 'User' || route.resource === 'users') && (name !== 'CreationRequest' || journalRoute));
  const filters = {};
  for (const name of models) {
    const model = mongoose.models[name]; if (!model) continue;
    const clauses = [];
    for (const grant of grants) {
      if (grant.scope === 'own') {
        if (name === 'User') clauses.push({ _id: objectId(context.userId) });
        else if (name === 'CreationRequest' && context.studentId && route.resource === 'students') clauses.push({ recordId: objectId(context.studentId) });
        else if (name === 'CreationRequest' && route.resource === 'users') clauses.push({ recordId: objectId(context.userId) });
        else if (name === 'Batch' && context.assignedBatchIds.length) clauses.push({ _id: { $in: context.assignedBatchIds.map(objectId) } });
        else if (name === 'Course' && context.assignedCourseIds.length) clauses.push({ _id: { $in: context.assignedCourseIds.map(objectId) } });
        else if (name === 'Student' && context.studentId) clauses.push({ _id: objectId(context.studentId) });
        else if (name === 'Teacher' && context.teacherId) clauses.push({ _id: objectId(context.teacherId) });
        else if (name === 'Qualifier' && context.qualifierId) clauses.push({ _id: objectId(context.qualifierId) });
        else if (name === 'Panelist' && context.panelistId) clauses.push({ _id: objectId(context.panelistId) });
        else if (model.schema.path('student') && context.studentId) clauses.push({ student: objectId(context.studentId) });
        else {
          const ownerField = ['created_by', 'submitted_by', 'user', 'actor', 'requested_by'].find((field) => model.schema.path(field));
          if (ownerField) clauses.push({ [ownerField]: objectId(context.userId) });
        }
      } else {
        const ids = (grant.scope === 'assigned' ? context.assignedBatchIds : grant.batchIds).map(objectId);
        const courses = (grant.scope === 'assigned' ? context.assignedCourseIds : grant.courseIds).map(objectId);
        if (name === 'Batch') clauses.push({ _id: { $in: ids } });
        else if (name === 'Course') clauses.push({ _id: { $in: courses } });
        else if (model.schema.path('batch')) {
          if (grant.scope === 'assigned' && model.schema.path('course') && context.assignedPairs) {
            clauses.push({ $or: context.assignedPairs.length ? context.assignedPairs.map((pair) => ({ batch: objectId(pair.batchId), course: objectId(pair.courseId) })) : [{ _id: { $in: [] } }] });
          } else clauses.push({ batch: { $in: ids }, ...(model.schema.path('course') && courses.length ? { course: { $in: courses } } : {}) });
        }
        else if (name === 'FeeLog') {
          const fees = await mongoose.models.Fee.find({ batch: { $in: ids } }).select('_id').lean();
          clauses.push({ fee: { $in: fees.map((fee) => fee._id) } });
        }
        else if (name === 'Teacher') {
          const batches = await mongoose.models.Batch.find({ _id: { $in: ids } }).select('teachers teacher_course_assignments').lean();
          const teachers = [...new Set(batches.flatMap((batch) => [...(batch.teachers || []), ...(batch.teacher_course_assignments || []).map((item) => item.teacher)]).filter(Boolean).map(String))];
          clauses.push({ _id: { $in: teachers.map(objectId) } });
        }
        else if (name === 'RefundRequest' || name === 'FeeReceipt' || name === 'StudentBatchShift') continue;
        else if (model.schema.path('student')) {
          const students = await mongoose.models.Student.find({ batch: { $in: ids } }).select('_id').lean();
          clauses.push({ student: { $in: students.map((item) => item._id) } });
        } else if (model.schema.path('course')) clauses.push({ course: { $in: courses } });
        else if (name === 'CreationRequest' && route.resource === 'students') {
          const students = await mongoose.models.Student.find({ batch: { $in: ids } }).select('_id').lean();
          clauses.push({ recordId: { $in: students.map((item) => item._id) } });
        }
      }
    }
    filters[name] = clauses.length ? { $or: clauses } : { _id: { $in: [] } };
  }
  return filters;
}

export async function authorizeApplicationRequest(req, res, next) {
  const context = req.access;
  if (context.disabled) throw denied('Account is disabled');
  const path = req.originalUrl.split('?')[0];
  if (path.startsWith('/access/')) return next();
  const route = classifyAccessRoute(req.method, path);
  if (!context.enforced) {
    if (accessMode() === 'observe' && route && !route.public) creationAudit('access_shadow_decision', {
      userId: context.userId, permission: route.permission, allowed: permissionGrants(context, route.permission).length > 0,
      requestId: req.requestId, mode: 'observe' });
    const staffManager = context.accountType === 'staff' && legacyStaffManager(req.accessUser?.role);
    const compatibleStaffAction = staffManager && (
      (req.method === 'GET' && path === '/roles') ||
      (req.method === 'POST' && (/^\/users\/(add|update\/[^/]+)$/.test(path) || /^\/users\/[^/]+\/processing\/retry$/.test(path))) ||
      (req.method === 'DELETE' && /^\/users\/delete\/[^/]+$/.test(path)));
    if (!compatibleStaffAction && (path.startsWith('/roles') || path.startsWith('/permissions') ||
      (path.startsWith('/users') && !['GET', 'HEAD'].includes(req.method) && !['/users/avatar', '/users/changePassword'].includes(path))) && !context.owner) {
      throw denied('Access management is restricted to authorized administrators');
    }
    return next();
  }
  if (!route || route.public || route.blocked) throw denied('Endpoint has no protected permission classification');
  const grants = permissionGrants(context, route.permission);
  if (!grants.length) throw denied(`Missing permission: ${route.permission}`);
  if (['1', 'true'].includes(String(req.query.export).toLowerCase()) && !permissionGrants(context, `${route.resource}.export`).length) throw denied('Export permission is required');
  context.permission = route.permission;
  context.routeAllowed = true;
  context.route = route;
  const all = grants.some((grant) => grant.scope === 'all');
  context.scopeBatchIds = all ? null : [...new Set(grants.flatMap((grant) => grant.scope === 'selected' ? grant.batchIds : context.assignedBatchIds))];
  context.scopeCourseIds = all ? null : [...new Set(grants.flatMap((grant) => grant.scope === 'selected' ? grant.courseIds : context.assignedCourseIds))];
  context.modelFilters = await buildModelFilters(context, route, grants);
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (Object.keys(req.body || {}).some((key) => accessCatalog.readOnlyFields.includes(key))) throw denied('Server-managed record metadata cannot be changed through this operation');
    for (const key of [...Object.keys(req.body || {}), ...Object.keys(req.files || {})]) {
      const group = Object.entries(FIELD_GROUPS).find(([, fields]) => fields.has(key))?.[0] || 'general';
      if (!canAccessField(context, group, key, 'write')) throw denied(`Missing field permission: ${group} write (${key})`);
    }
    const amount = Number(req.body?.amount ?? req.body?.paymentAmount ?? req.body?.requested_amount);
    if (Number.isFinite(amount) && !grants.some((grant) => grant.maxAmount == null || Math.abs(amount) <= grant.maxAmount)) throw denied('Amount exceeds your authorization limit');
    const requestedBatch = req.body?.batch || req.body?.batchId;
    if (requestedBatch && !grants.some((grant) => grant.scope === 'all' ||
      (grant.scope === 'assigned' ? context.assignedBatchIds : grant.batchIds || []).includes(String(requestedBatch)))) throw denied('Destination batch is outside your scope');
    const requestedCourse = req.body?.course || req.body?.courseId;
    if (requestedBatch || requestedCourse) {
      if (!evaluateAccess(context, route.permission, { batchId: requestedBatch, courseId: requestedCourse,
        amount: Number.isFinite(amount) ? amount : undefined }).allowed) throw denied('The batch/course combination is outside your grant');
    }
    const routeParts = route.path.split('/'), actualParts = path.split('/');
    const params = Object.fromEntries(routeParts.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1), actualParts[index]]] : []));
    const targetId = params.studentId || params.student_id || params.id || params.assignmentId || params.timetableId || params.attemptId ||
      (route.handler === 'changeAvatar' ? req.body?.id : null);
    if (targetId && mongoose.isValidObjectId(targetId)) {
      const models = primaryModels[route.resource] || [];
      let modelName = (params.studentId || params.student_id) ? 'Student' : models[0];
      if (route.handler.toLowerCase().includes('submission')) modelName = 'AssignmentSubmission';
      if (route.handler.toLowerCase().includes('attempt')) modelName = route.resource === 'quiz' ? 'QuizAttempt' : 'CourseQuizAttempt';
      const model = mongoose.models[modelName];
      if (model) {
        const record = await accessContext.run(context, () => model.findById(targetId).lean());
        if (!record) throw denied('Record not found within your authorized scope');
        const createdBy = record.created_by || record.requested_by || record.submitted_by;
        const recordAmount = Number(record.amount ?? record.requested_amount);
        if (!grants.some((grant) => (!grant.noSelfApproval || (createdBy && String(createdBy) !== context.userId)) &&
          (grant.maxAmount == null || !Number.isFinite(recordAmount) || Math.abs(recordAmount) <= grant.maxAmount))) throw denied('Approval constraints are not satisfied');
      } else if (!all) throw denied('This operation requires an explicit record-scope adapter');
    } else if (!all && route.handler !== 'changePassword' && (!requestedBatch || !mongoose.models[primaryModels[route.resource]?.[0]]?.schema.path('batch'))) {
      throw denied('Scoped creation requires an explicit destination batch; this operation needs an all-records grant');
    }
    if (route.resource === 'users' && ['role', 'accountType', 'accessManaged', 'platformOwner', 'disabledAt'].some((key) => req.body?.[key] !== undefined) && route.handler !== 'addUser') {
      throw denied('Account category and access assignments require their dedicated administration procedure');
    }
  }
  const json = res.json.bind(res);
  res.json = (body) => json(redactAccessFields(body, context));
  return accessContext.run(context, next);
}

export async function freshAccessUser(req) {
  const user = await User.findById(req.user?.user?.id).select('-password').lean();
  if (!user || user.disabledAt) throw denied('Account is disabled or no longer exists');
  req.user.user.role = user.accountType && user.accountType !== 'staff' ? user.accountType : user.role;
  req.access = await loadAccessContext(user);
  req.accessUser = user;
  return user;
}
