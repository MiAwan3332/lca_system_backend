import dotenv from "dotenv";
import moment from "moment";
import Batch from "../models/batches.js";
import Student from "../models/students.js";
import Fee from "../models/fees.js";
import FeeLogs from "../models/feeLogs.js";
import Expense from "../models/expenses.js";
import Attendence from "../models/attendence.js";
import {
  isStudentRole,
  resolveStudentRecord,
} from "../utils/studentScope.js";
import {
  isTeacherRole,
  getTeacherScope,
  resolveTeacherRecord,
} from "../utils/lmsAccess.js";
import Assignment from "../models/assignments.js";
import AssignmentSubmission from "../models/assignmentSubmissions.js";
import CourseQuiz from "../models/courseQuizzes.js";
import TimeTable from "../models/timeTables.js";

dotenv.config();

const buildFeeLogMatch = async (action_type, { batch_id, start_date, end_date }) => {
  const match = { action_type };

  if (start_date || end_date) {
    match.action_date = {};
    if (start_date) match.action_date.$gte = new Date(start_date);
    if (end_date) match.action_date.$lte = new Date(`${end_date}T23:59:59.999Z`);
  }

  if (batch_id) {
    const feeIds = await Fee.find({ batch: batch_id }).distinct("_id");
    match.fee = { $in: feeIds };
  }

  return match;
};

const sumFeeLogAmount = async (action_type, dateFilter, feeIds) => {
  const match = { action_type, ...dateFilter };
  if (feeIds) match.fee = { $in: feeIds };

  const amountField =
    action_type === "Created" || action_type === "Deleted"
      ? "$amount"
      : "$action_amount";

  const result = await FeeLogs.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $toDouble: amountField } } } },
  ]);

  return result.length > 0 ? result[0].total : 0;
};

const sumApprovedExpenses = async (startDate, endDate, batch_id) => {
  const filter = {
    status: "Approved",
    expense_date: { $gte: startDate, $lte: endDate },
  };

  const result = await Expense.aggregate([
    { $match: filter },
    { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
  ]);

  return result.length > 0 ? result[0].total : 0;
};

const sumPendingExpenses = async (startDate, endDate) => {
  const filter = {
    status: "Pending",
    expense_date: { $gte: startDate, $lte: endDate },
  };

  const result = await Expense.aggregate([
    { $match: filter },
    { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
  ]);

  return result.length > 0 ? result[0].total : 0;
};

const getMonthlyFinanceTrend = async (filterParams, referenceYear) => {
  const months = Array.from({ length: 12 }, (_, index) =>
    moment().year(referenceYear).month(index)
  );

  const feeIds = filterParams.batch_id
    ? await Fee.find({ batch: filterParams.batch_id }).distinct("_id")
    : null;

  return Promise.all(
    months.map(async (month) => {
      const monthStart = month.clone().startOf("month");
      const monthEnd = month.clone().endOf("month");
      const dateFilter = {
        action_date: {
          $gte: monthStart.toDate(),
          $lte: monthEnd.toDate(),
        },
      };

      const recovered = await sumFeeLogAmount("Paid", dateFilter, feeIds);
      const expenses = await sumApprovedExpenses(
        monthStart.format("YYYY-MM-DD"),
        monthEnd.format("YYYY-MM-DD")
      );

      return {
        label: month.format("MMM"),
        recovered,
        expenses,
        net: recovered - expenses,
      };
    })
  );
};

const getExpenseCategoryBreakdown = async (startDate, endDate) => {
  const result = await Expense.aggregate([
    {
      $match: {
        status: "Approved",
        expense_date: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: "$category",
        total: { $sum: { $toDouble: "$amount" } },
      },
    },
    { $sort: { total: -1 } },
  ]);

  return result.map((item) => ({
    label: item._id || "Other",
    value: item.total,
  }));
};

export const getStatistics = async (req, res) => {
  try {
    if (isStudentRole(req)) {
      const student = await resolveStudentRecord(req);
      if (!student) {
        return res.status(404).json({ message: "Student profile not found" });
      }

      const batchId = student.batch?._id || student.batch;
      const fees = await Fee.find({ student: student._id });
      const pendingFees = fees.filter((fee) => fee.status === "Pending");
      const paidFees = fees.filter((fee) => fee.status === "Paid");
      const attendanceCount = await Attendence.countDocuments({
        student: student._id,
      });

      const totalPaidAmount = paidFees.reduce(
        (sum, fee) => sum + Number(fee.amount || 0),
        0
      );

      const batchFee =
        Number(student.batch?.batch_fee) || Number(student.total_fee) || 0;
      const paidAmount =
        Number(student.paid_fee) || totalPaidAmount || 0;
      const pendingAmount =
        student.pending_fee != null && student.pending_fee !== ""
          ? Number(student.pending_fee)
          : Math.max(batchFee - paidAmount, 0);

      const primaryPendingFee = pendingFees.find(
        (fee) => fee.due_date && Number(fee.amount) > 0
      );
      const feeDueDate = primaryPendingFee?.due_date || null;
      const feeIsOverdue =
        feeDueDate &&
        moment(feeDueDate).startOf("day").isBefore(moment().startOf("day"));
      const feeOverdueDays = feeIsOverdue
        ? moment().startOf("day").diff(moment(feeDueDate).startOf("day"), "days")
        : 0;

      return res.status(200).json({
        is_student_dashboard: true,
        student_name: student.name,
        batch_name: student.batch?.name || "Not assigned",
        total_fee_record: batchFee,
        total_fee_recovered: paidAmount,
        total_fee_pending: pendingAmount,
        total_fee_defaulters: pendingFees.length,
        fee_due_date: feeDueDate,
        fee_is_overdue: Boolean(feeIsOverdue),
        fee_overdue_days: feeOverdueDays,
        attendance_records_count: attendanceCount,
        current_batches_count: batchId ? 1 : 0,
        chart_data: {
          fee_overview: [
            { label: "Paid", value: paidAmount },
            { label: "Pending", value: pendingAmount },
          ],
        },
      });
    }

    if (isTeacherRole(req)) {
      const teacher = await resolveTeacherRecord(req);
      const scope = await getTeacherScope(req);
      if (!teacher || !scope?.batchIds?.length) {
        return res.status(200).json({
          is_teacher_dashboard: true,
          teacher_name: teacher?.name || "Teacher",
          assigned_courses_count: 0,
          assigned_batches_count: 0,
          assigned_students_count: 0,
          upcoming_classes_count: 0,
          pending_assignment_reviews: 0,
          active_quizzes_count: 0,
          attendance_records_count: 0,
          upcoming_assignment_deadlines: 0,
          recent_student_activity: [],
        });
      }

      const now = new Date();
      const assignedStudentsCount = await Student.countDocuments({
        batch: { $in: scope.batchIds },
      });

      const assignmentIds = await Assignment.find({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
      }).distinct("_id");

      const pendingAssignmentReviews = await AssignmentSubmission.countDocuments({
        assignment: { $in: assignmentIds },
        status: { $in: ["Submitted", "Late Submitted", "Under Review"] },
      });

      const activeQuizzesCount = await CourseQuiz.countDocuments({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
        start_datetime: { $lte: now },
        end_datetime: { $gte: now },
      });

      const upcomingClassesCount = await TimeTable.countDocuments({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
        teacher: teacher._id,
      });

      const attendanceRecordsCount = await Attendence.countDocuments({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
      });

      const upcomingAssignmentDeadlines = await Assignment.countDocuments({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
        visibility_status: "Published",
        has_deadline: true,
        submission_deadline: { $gte: now },
      });

      const recentSubmissions = await AssignmentSubmission.find({
        assignment: { $in: assignmentIds },
      })
        .sort({ submitted_at: -1 })
        .limit(5)
        .populate({ path: "student", select: "name" })
        .populate({ path: "assignment", select: "title" });

      const upcomingAssignments = await Assignment.find({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
        visibility_status: "Published",
        has_deadline: true,
        submission_deadline: { $gte: now },
      })
        .sort({ submission_deadline: 1 })
        .limit(5)
        .populate({ path: "course", select: "name" })
        .populate({ path: "batch", select: "name" });

      const upcomingQuizzes = await CourseQuiz.find({
        batch: { $in: scope.batchIds },
        course: { $in: scope.courseIds },
        end_datetime: { $gte: now },
      })
        .sort({ start_datetime: 1 })
        .limit(3)
        .populate({ path: "course", select: "name" })
        .populate({ path: "batch", select: "name" });

      return res.status(200).json({
        is_teacher_dashboard: true,
        teacher_name: teacher.name,
        assigned_courses_count: scope.courseIds.length,
        assigned_batches_count: scope.batchIds.length,
        assigned_students_count: assignedStudentsCount,
        upcoming_classes_count: upcomingClassesCount,
        pending_assignment_reviews: pendingAssignmentReviews,
        active_quizzes_count: activeQuizzesCount,
        attendance_records_count: attendanceRecordsCount,
        upcoming_assignment_deadlines: upcomingAssignmentDeadlines,
        recent_student_activity: recentSubmissions.map((item) => ({
          student_name: item.student?.name,
          assignment_title: item.assignment?.title,
          status: item.status,
          submitted_at: item.submitted_at,
        })),
        upcoming_events: [
          ...upcomingAssignments.map((item) => ({
            type: "assignment",
            title: item.title,
            subtitle: `${item.batch?.name || "Batch"} · ${item.course?.name || "Course"}`,
            date: item.submission_deadline,
          })),
          ...upcomingQuizzes.map((item) => ({
            type: "quiz",
            title: item.title || "Course Quiz",
            subtitle: `${item.batch?.name || "Batch"} · ${item.course?.name || "Course"}`,
            date: item.start_datetime,
          })),
        ],
        chart_data: {
          workload_overview: [
            { label: "Pending Reviews", value: pendingAssignmentReviews },
            { label: "Active Quizzes", value: activeQuizzesCount },
            { label: "Upcoming Deadlines", value: upcomingAssignmentDeadlines },
          ],
        },
      });
    }

    const { batch_id, start_date, end_date } = req.query;
    const reference_date = end_date || start_date || moment().format("YYYY-MM-DD");

    const batchFilter = batch_id ? { _id: batch_id } : {};

    // Batches Statistics
    const current_batches_count = await Batch.countDocuments({
      ...batchFilter,
      enddate: { $gte: reference_date },
    });

    const previous_batches_count = await Batch.countDocuments({
      ...batchFilter,
      enddate: { $lt: reference_date },
    });

    const total_batches_count = await Batch.countDocuments(batchFilter);

    // Students Statistics
    const studentFilter = {};
    if (batch_id) studentFilter.batch = batch_id;
    if (start_date || end_date) {
      studentFilter.admission_date = {};
      if (start_date) studentFilter.admission_date.$gte = start_date;
      if (end_date) studentFilter.admission_date.$lte = end_date;
    }

    const enrolledStudentFilter = { batch: { $ne: null }, ...studentFilter };
    if (studentFilter.batch) {
      enrolledStudentFilter.batch = studentFilter.batch;
    }

    const enrolled_students_count = await Student.countDocuments(enrolledStudentFilter);
    const total_students_count = await Student.countDocuments(studentFilter);
    const total_enrolled_students_count = enrolled_students_count + "/" + total_students_count;

    const filterParams = { batch_id, start_date, end_date };

    // Fees Statistics
    const total_fee_created_result = await FeeLogs.aggregate([
      { $match: await buildFeeLogMatch("Created", filterParams) },
      { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } }
    ]);
    const total_fee_created = total_fee_created_result.length > 0 ? total_fee_created_result[0].total : 0;

    const total_fee_discounted_result = await FeeLogs.aggregate([
      { $match: await buildFeeLogMatch("Discounted", filterParams) },
      { $group: { _id: null, total: { $sum: { $toDouble: "$action_amount" } } } }
    ]);
    const total_fee_discounted = total_fee_discounted_result.length > 0 ? total_fee_discounted_result[0].total : 0;

    const total_fee_deleted_result = await FeeLogs.aggregate([
      { $match: await buildFeeLogMatch("Deleted", filterParams) },
      { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } }
    ]);
    const total_fee_deleted = total_fee_deleted_result.length > 0 ? total_fee_deleted_result[0].total : 0;

    const total_fee_paid_result = await FeeLogs.aggregate([
      { $match: await buildFeeLogMatch("Paid", filterParams) },
      { $group: { _id: null, total: { $sum: { $toDouble: "$action_amount" } } } }
    ]);
    const total_fee_paid = total_fee_paid_result.length > 0 ? total_fee_paid_result[0].total : 0;

    const total_fee_record = total_fee_created - total_fee_discounted - total_fee_deleted;

    const total_fee_recovered = total_fee_paid;

    const total_fee_pending = total_fee_record - total_fee_recovered;

    // Fee Defaulters
    const defaulterFilter = { status: "Pending" };
    if (batch_id) defaulterFilter.batch = batch_id;
    if (end_date) defaulterFilter.due_date = { $lte: end_date };
    if (start_date) {
      defaulterFilter.due_date = {
        ...(defaulterFilter.due_date || {}),
        $gte: start_date,
      };
    }

    const total_fee_defaulters = await Fee.countDocuments(defaulterFilter);

    const expenseStart = start_date || moment().startOf("year").format("YYYY-MM-DD");
    const expenseEnd = end_date || moment().endOf("year").format("YYYY-MM-DD");

    const total_approved_expenses = await sumApprovedExpenses(
      expenseStart,
      expenseEnd
    );
    const total_pending_expenses = await sumPendingExpenses(
      expenseStart,
      expenseEnd
    );
    const net_balance = total_fee_recovered - total_approved_expenses;

    const referenceYear = end_date
      ? moment(end_date).year()
      : start_date
        ? moment(start_date).year()
        : moment().year();

    const monthly_finance = await getMonthlyFinanceTrend(
      filterParams,
      referenceYear
    );
    const expense_categories = await getExpenseCategoryBreakdown(
      expenseStart,
      expenseEnd
    );

    const now = new Date();
    const recentStudents = await Student.find({ batch: { $ne: null } })
      .sort({ admission_date: -1 })
      .limit(4)
      .select("name admission_date batch")
      .populate({ path: "batch", select: "name" });

    const recentSubmissions = await AssignmentSubmission.find()
      .sort({ submitted_at: -1 })
      .limit(4)
      .populate({ path: "student", select: "name" })
      .populate({ path: "assignment", select: "title" });

    const upcomingAssignments = await Assignment.find({
      visibility_status: "Published",
      has_deadline: true,
      submission_deadline: { $gte: now },
    })
      .sort({ submission_deadline: 1 })
      .limit(5)
      .populate({ path: "course", select: "name" })
      .populate({ path: "batch", select: "name" });

    const upcomingQuizzes = await CourseQuiz.find({
      end_datetime: { $gte: now },
    })
      .sort({ start_datetime: 1 })
      .limit(3)
      .populate({ path: "course", select: "name" })
      .populate({ path: "batch", select: "name" });

    const chart_data = {
      batch_status: [
        { label: "Current Batches", value: current_batches_count },
        { label: "Previous Batches", value: previous_batches_count },
      ],
      fee_overview: [
        { label: "Recovered", value: total_fee_recovered },
        { label: "Pending", value: Math.max(total_fee_pending, 0) },
        { label: "Discounted", value: total_fee_discounted },
      ],
      expense_overview: [
        { label: "Approved", value: total_approved_expenses },
        { label: "Pending", value: total_pending_expenses },
      ],
      enrollment_overview: [
        { label: "Enrolled", value: enrolled_students_count },
        {
          label: "Unenrolled",
          value: Math.max(total_students_count - enrolled_students_count, 0),
        },
      ],
      monthly_finance,
      expense_categories,
    };

    res.status(200).json({
      current_batches_count,
      previous_batches_count,
      total_batches_count,
      total_enrolled_students_count,
      total_fee_record,
      total_fee_recovered,
      total_fee_pending,
      total_fee_discounted,
      total_fee_defaulters,
      total_approved_expenses,
      total_pending_expenses,
      net_balance,
      chart_data,
      recent_activity: [
        ...recentStudents.map((item) => ({
          type: "enrollment",
          title: `${item.name} registered`,
          subtitle: item.batch?.name || "New enrollment",
          time: item.admission_date,
        })),
        ...recentSubmissions.map((item) => ({
          type: "assignment",
          title: `${item.student?.name || "Student"} submitted ${item.assignment?.title || "assignment"}`,
          subtitle: item.status,
          time: item.submitted_at,
        })),
      ],
      upcoming_events: [
        ...upcomingAssignments.map((item) => ({
          type: "assignment",
          title: item.title,
          subtitle: `${item.batch?.name || "Batch"} · ${item.course?.name || "Course"}`,
          date: item.submission_deadline,
        })),
        ...upcomingQuizzes.map((item) => ({
          type: "quiz",
          title: item.title || "Course Quiz",
          subtitle: `${item.batch?.name || "Batch"} · ${item.course?.name || "Course"}`,
          date: item.start_datetime,
        })),
      ],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
