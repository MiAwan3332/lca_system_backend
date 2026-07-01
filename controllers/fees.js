import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import Expense from "../models/expenses.js";
import User from "../models/users.js";
import Student from "../models/students.js";
import Batch from "../models/batches.js";
import {
  isStudentRole,
  resolveStudentId,
  denyUnlessOwnStudent,
} from "../utils/studentScope.js";
import dotenv from "dotenv";
import moment from "moment-timezone";
dotenv.config();

export const getFees = async (req, res) => {
    const { query, status, date } = req.query;

    try {
        const searchQuery = query ? query : '';

        const filter = {};

        if (isStudentRole(req)) {
            const studentId = await resolveStudentId(req);
            if (!studentId) {
                return res.status(404).json({ message: "Student profile not found" });
            }
            filter.student = studentId;
        }

        if (status) {
            filter.status = status;
        }

        if (date) {
            var fileter_date = moment(date).tz("Asia/Karachi").format("YYYY-MM-DD");
            console.log(fileter_date);
            filter.due_date = fileter_date;
        }

        const options = {
            page: parseInt(req.query.page, 10) || 1,
            limit: parseInt(req.query.limit, 10) || 10,
            sort: { due_date: -1 },
            populate: [
                {
                    path: "student",
                    match: {
                        name: { $regex: searchQuery, $options: "i" },
                    },
                },
                { path: "batch" },
            ],
        };

        const fees = await Fee.paginate(filter, options);

        // Filter out fees with null students when search query is applied
        fees.docs = fees.docs.filter(fee => fee.student !== null);

        res.status(200).json(fees);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const getFeeById = async (req, res) => {
    const { id } = req.params;
    try {
        const fee = await Fee.findById(id).populate("student").populate("batch");
        if (!fee) {
            return res.status(404).json({ message: "Fee not found" });
        }

        if (isStudentRole(req)) {
            const studentId = await resolveStudentId(req);
            if (!studentId || fee.student?._id?.toString() !== studentId) {
                return res.status(403).json({ message: "Access denied" });
            }
        }

        res.status(200).json(fee);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const createFee = async (req, res) => {
    const { student_id, batch_id, amount } = req.body;
    try {
        if (amount <= 0) {
            return res.status(400).json({ message: "Amount must be greater than 0" });
        }

        const student = await Student.findById(student_id);
        if (!student) {
            return res.status(404).json({ message: "Student not found" });
        }

        const fee = await Fee.findOne({ student: student_id, batch: batch_id });
        if (fee) {
            return res.status(400).json({ message: "Fee already exists" });
        }

        const newFee = new Fee({
            student: student_id,
            batch: batch_id,
            amount,
            due_date: moment().tz("Asia/Karachi").format("YYYY-MM-DD"),
        });

        const actionUser = await User.findById(req.user.user.id);

        const feeLog = new FeeLog({
            amount,
            action_amount: amount,
            action_date: new Date(),
            action_type: "Created",
            action_by: actionUser._id,
            fee: newFee._id,
        });

        await newFee.save();
        await feeLog.save();
        res.status(201).json(newFee);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const payFee = async (req, res) => {
    const { id } = req.params;
    const { student_id, amount } = req.body;
    try {
        let fee = await Fee.findById(id);
        if (!fee) {
            const response = await createFee(req, res);
            if (response.status === 201) {
                fee = await Fee.findById(id);
            } else {
                return res.status(404).json({ message: "Something went wrong while creating a new fee record" });
            }
        }

        if (amount > fee.amount) {
            return res.status(400).json({ message: "Amount exceeds the fee amount" });
        }

        if (amount <= 0) {
            return res.status(400).json({ message: "Amount must be greater than 0" });
        }

        if (amount > fee.amount) {
            return res.status(400).json({ message: "Amount exceeds the fee amount" });
        }

        if (fee.status === "Paid") {
            return res.status(400).json({ message: "Fee already paid" });
        }

        const orignalAmount = fee.amount;
        fee.amount -= amount;

        if (fee.amount <= 0) {
            fee.status = "Paid";
        }

        const actionUser = await User.findById(req.user.user.id);

        const feeLog = new FeeLog({
            amount: orignalAmount,
            action_amount: amount,
            action_date: new Date(),
            action_type: "Paid",
            action_by: actionUser._id,
            fee: id,
        });

        await feeLog.save();
        await fee.save();

        res.status(200).json(fee);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const discountFee = async (req, res) => {
    const { id } = req.params;
    const { amount, description } = req.body;

    try {
        const trimmedDescription = description?.trim();
        if (!trimmedDescription) {
            return res.status(400).json({ message: "Description is required for discount" });
        }

        let fee = await Fee.findById(id);
        if (!fee) {
            const response = await createFee(req, res);
            if (response.status === 201) {
                fee = await Fee.findById(id);
            } else {
                return res.status(404).json({ message: "Something went wrong while creating a new fee record" });
            }
        }

        if (amount > fee.amount) {
            return res.status(400).json({ message: "Amount exceeds the fee amount" });
        }

        if (amount <= 0) {
            return res.status(400).json({ message: "Amount must be greater than 0" });
        }

        if (fee.status === "Paid") {
            return res.status(400).json({ message: "Fee already paid" });
        }

        const orignalAmount = fee.amount;
        fee.amount -= amount;

        if (fee.amount <= 0) {
            fee.status = "Paid";
        }

        const actionUser = await User.findById(req.user.user.id);

        const feeLog = new FeeLog({
            amount: orignalAmount,
            action_amount: amount,
            action_date: new Date(),
            action_type: "Discounted",
            action_by: actionUser._id,
            fee: id,
            description: trimmedDescription,
        });

        await feeLog.save();
        await fee.save();

        res.status(200).json(fee);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const deleteFee = async (req, res) => {
    const { id } = req.params;
    try {
        const fee = await Fee.findById(id);
        if (!fee) {
            return res.status(404).json({ message: "Fee not found" });
        }
        await Fee.findByIdAndDelete(id);

        const actionUser = await User.findById(req.user.user.id);

        const feeLog = new FeeLog({
            amount: fee.amount,
            action_amount: fee.amount,
            action_date: new Date(),
            action_type: "Deleted",
            action_by: actionUser._id,
            fee: id,
        });

        await feeLog.save();

        res.status(200).json("Fee deleted successfully");
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const getFeeLogs = async (req, res) => {
    const { id } = req.params;
    try {
        const fee = await Fee.findById(id);
        if (!fee) {
            return res.status(404).json({ message: "Fee not found" });
        }

        if (isStudentRole(req)) {
            const studentId = await resolveStudentId(req);
            if (!studentId || fee.student?.toString() !== studentId) {
                return res.status(403).json({ message: "Access denied" });
            }
        }

        const feeLogs = await FeeLog.find({ fee: id }).populate("action_by").populate("fee").populate("student");
        res.status(200).json(feeLogs);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const getFeesByStudentId = async (req, res) => {
    const { id } = req.params;
    try {
        if (!(await denyUnlessOwnStudent(req, res, id))) {
            return;
        }

        const student = await Student.findById(id);
        if (!student) {
            return res.status(404).json({ message: "Student not found" });
        }

        const fees = await Fee.find({ student: id }).populate("student").populate("batch");

        if (!fees || fees.length === 0) {
            return res.status(404).json({ message: "No fees found for the student" });
        }

        const uniqueBatchIds = [...new Set(fees.map(fee => fee.batch._id))];

        const feeLogs = await Promise.all(uniqueBatchIds.map(async (batchId) => {
            const batchFeeLogs = await FeeLog.find({ fee: { $in: fees.filter(fee => fee.batch._id === batchId) } });
            const batch = await Batch.findById(batchId);
            return { batch, feeLogs: batchFeeLogs };
        }));

        // total fee amount in feeLogs where action_type is "Paid"
        const totalPaidFeeAmount = feeLogs.reduce((acc, curr) => {
            const paidFeeLogs = curr.feeLogs.filter(log => log.action_type === "Paid");
            return acc + paidFeeLogs.reduce((acc, curr) => acc + curr.action_amount, 0);
        }, 0);

        // total fee amount in feeLogs where action_type is "Discounted"
        const totalDiscountedFeeAmount = feeLogs.reduce((acc, curr) => {
            const discountedFeeLogs = curr.feeLogs.filter(log => log.action_type === "Discounted");
            return acc + discountedFeeLogs.reduce((acc, curr) => acc + curr.action_amount, 0);
        }, 0);

        // total fee amount in feeLogs where action_type is "Created"
        const totalCreatedFeeAmount = feeLogs.reduce((acc, curr) => {
            const createdFeeLogs = curr.feeLogs.filter(log => log.action_type === "Created");
            return acc + createdFeeLogs.reduce((acc, curr) => acc + curr.amount, 0);
        }, 0);

        // total pending fee amount
        const totalPendingFeeAmount = fees.reduce((acc, curr) => {
            if (curr.status === "Pending") {
                return acc + curr.amount;
            }
            return acc;
        }, 0);

        const overallFeeStatistics = {
            totalPaidFeeAmount,
            totalDiscountedFeeAmount,
            totalCreatedFeeAmount,
            totalPendingFeeAmount
        };

        const batchWiseFeeStatistics = [];

        for (const fee of fees) {
            const batchFeeLogs = feeLogs.find(log => log.batch.toString() === fee.batch.toString());
            if (batchFeeLogs) {
                batchWiseFeeStatistics.push({
                    batch: {
                        _id: fee.batch._id,
                        name: fee.batch.name
                    },
                    totalPaidFeeAmount: batchFeeLogs.feeLogs.filter(log => log.action_type === "Paid").reduce((acc, curr) => acc + curr.action_amount, 0),
                    totalDiscountedFeeAmount: batchFeeLogs.feeLogs.filter(log => log.action_type === "Discounted").reduce((acc, curr) => acc + curr.action_amount, 0),
                    totalCreatedFeeAmount: batchFeeLogs.feeLogs.filter(log => log.action_type === "Created").reduce((acc, curr) => acc + curr.amount, 0),
                    totalPendingFeeAmount: batchFeeLogs.feeLogs.filter(log => log.action_type === "Pending").reduce((acc, curr) => acc + curr.amount, 0),
                });
            }
        }

        res.status(200).json({ overallFeeStatistics, batchWiseFeeStatistics });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

const getPeriodRange = (period, date) => {
    const refDate = date
        ? moment(date).tz("Asia/Karachi")
        : moment().tz("Asia/Karachi");

    switch (period) {
        case "weekly":
            return {
                start: refDate.clone().startOf("isoWeek"),
                end: refDate.clone().endOf("isoWeek"),
            };
        case "monthly":
            return {
                start: refDate.clone().startOf("month"),
                end: refDate.clone().endOf("month"),
            };
        case "yearly":
            return {
                start: refDate.clone().startOf("year"),
                end: refDate.clone().endOf("year"),
            };
        case "daily":
        default:
            return {
                start: refDate.clone().startOf("day"),
                end: refDate.clone().endOf("day"),
            };
    }
};

const sumFeeLogs = async (action_type, dateFilter, feeIds, changed_by) => {
    const match = { action_type, ...dateFilter };
    if (feeIds) {
        match.fee = { $in: feeIds };
    }
    if (changed_by) {
        match.action_by = changed_by;
    }

    const amountField = action_type === "Created" || action_type === "Deleted"
        ? "$amount"
        : "$action_amount";

    const result = await FeeLog.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: { $toDouble: amountField } } } },
    ]);

    return result.length > 0 ? result[0].total : 0;
};

const getBreakdownBuckets = (period, start, end) => {
    const buckets = [];

    if (period === "daily") {
        buckets.push({
            label: start.format("MMM D"),
            start: start.clone(),
            end: end.clone(),
        });
        return buckets;
    }

    if (period === "yearly") {
        for (let month = 0; month < 12; month += 1) {
            const monthStart = start.clone().month(month).startOf("month");
            const monthEnd = start.clone().month(month).endOf("month");
            buckets.push({
                label: monthStart.format("MMM"),
                start: monthStart,
                end: monthEnd,
            });
        }
        return buckets;
    }

    const cursor = start.clone().startOf("day");
    const lastDay = end.clone().endOf("day");

    while (cursor.isSameOrBefore(lastDay, "day")) {
        buckets.push({
            label: period === "weekly" ? cursor.format("ddd") : cursor.format("D"),
            start: cursor.clone().startOf("day"),
            end: cursor.clone().endOf("day"),
        });
        cursor.add(1, "day");
    }

    return buckets;
};

const getBucketTotals = async (bucket, feeIds, changed_by) => {
    const dateFilter = {
        action_date: {
            $gte: bucket.start.toDate(),
            $lte: bucket.end.toDate(),
        },
    };

    const [created, recovered, discounted] = await Promise.all([
        sumFeeLogs("Created", dateFilter, feeIds, changed_by),
        sumFeeLogs("Paid", dateFilter, feeIds, changed_by),
        sumFeeLogs("Discounted", dateFilter, feeIds, changed_by),
    ]);

    return {
        label: bucket.label,
        created,
        recovered,
        discounted,
    };
};

const sumApprovedExpensesInRange = async (startDate, endDate) => {
    const result = await Expense.aggregate([
        {
            $match: {
                status: "Approved",
                expense_date: {
                    $gte: startDate,
                    $lte: endDate,
                },
            },
        },
        { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
    ]);

    return result.length > 0 ? result[0].total : 0;
};

const getApprovedExpensesBreakdown = async (period, start, end) => {
    const buckets = getBreakdownBuckets(period, start, end);

    return Promise.all(
        buckets.map(async (bucket) => {
            const expenses = await sumApprovedExpensesInRange(
                bucket.start.format("YYYY-MM-DD"),
                bucket.end.format("YYYY-MM-DD")
            );

            return expenses;
        })
    );
};

export const getFinanceReport = async (req, res) => {
    try {
        if (isStudentRole(req)) {
            return res.status(403).json({ message: "Access denied" });
        }

        const { period = "daily", date, batch_id, changed_by } = req.query;
        const { start, end } = getPeriodRange(period, date);

        const dateFilter = {
            action_date: {
                $gte: start.toDate(),
                $lte: end.toDate(),
            },
        };

        const feeIds = batch_id
            ? await Fee.find({ batch: batch_id }).distinct("_id")
            : null;

        const [
            total_fee_created,
            total_fee_recovered,
            total_fee_discounted,
            total_fee_deleted,
        ] = await Promise.all([
            sumFeeLogs("Created", dateFilter, feeIds, changed_by),
            sumFeeLogs("Paid", dateFilter, feeIds, changed_by),
            sumFeeLogs("Discounted", dateFilter, feeIds, changed_by),
            sumFeeLogs("Deleted", dateFilter, feeIds, changed_by),
        ]);

        const total_fee_record = total_fee_created - total_fee_discounted - total_fee_deleted;
        const total_fee_pending = total_fee_record - total_fee_recovered;

        let total_pending_amount = 0;
        let total_fee_defaulters = 0;

        if (!changed_by) {
            const pendingFilter = { status: "Pending" };
            if (batch_id) pendingFilter.batch = batch_id;

            const pendingFees = await Fee.find(pendingFilter);
            total_pending_amount = pendingFees.reduce(
                (sum, fee) => sum + (fee.amount || 0),
                0
            );

            const defaulterFilter = {
                status: "Pending",
                due_date: { $lte: end.format("YYYY-MM-DD") },
            };
            if (batch_id) defaulterFilter.batch = batch_id;

            total_fee_defaulters = await Fee.countDocuments(defaulterFilter);
        }

        const buckets = getBreakdownBuckets(period, start, end);
        const feeBreakdown = await Promise.all(
            buckets.map((bucket) => getBucketTotals(bucket, feeIds, changed_by))
        );
        const expenseBreakdown = await getApprovedExpensesBreakdown(period, start, end);

        const breakdown = feeBreakdown.map((item, index) => ({
            ...item,
            expenses: expenseBreakdown[index] || 0,
            net: (item.recovered || 0) - (expenseBreakdown[index] || 0),
        }));

        const total_approved_expenses = await sumApprovedExpensesInRange(
            start.format("YYYY-MM-DD"),
            end.format("YYYY-MM-DD")
        );

        const pending_expenses = await Expense.aggregate([
            {
                $match: {
                    status: "Pending",
                    expense_date: {
                        $gte: start.format("YYYY-MM-DD"),
                        $lte: end.format("YYYY-MM-DD"),
                    },
                },
            },
            { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
        ]);
        const total_pending_expenses =
            pending_expenses.length > 0 ? pending_expenses[0].total : 0;

        const net_balance = total_fee_recovered - total_approved_expenses;

        const transactionFilter = { ...dateFilter };
        if (feeIds) {
            transactionFilter.fee = { $in: feeIds };
        }
        if (changed_by) {
            transactionFilter.action_by = changed_by;
        }

        const transactions = await FeeLog.find(transactionFilter)
            .populate("action_by", "name email")
            .populate({
                path: "fee",
                populate: [
                    { path: "student", select: "name _id email" },
                    { path: "batch", select: "name" },
                ],
            })
            .sort({ action_date: -1 })
            .limit(100);

        const approvedExpenseRecords = await Expense.find({
            status: "Approved",
            expense_date: {
                $gte: start.format("YYYY-MM-DD"),
                $lte: end.format("YYYY-MM-DD"),
            },
        })
            .populate("created_by", "name email")
            .populate("approved_by", "name email")
            .sort({ approved_at: -1 })
            .limit(100);

        const feeTransactions = transactions.map((log) => ({
            _id: log._id,
            type: "fee",
            action_type: log.action_type,
            amount: log.amount,
            action_amount: log.action_amount,
            action_date: log.action_date,
            action_by: log.action_by?.name || "N/A",
            student_name: log.fee?.student?.name || "N/A",
            student_id: log.fee?.student?._id?.toString() || "N/A",
            batch_name: log.fee?.batch?.name || "N/A",
            program: log.fee?.batch?.name || "N/A",
            title: null,
            category: null,
            description: log.description || "",
            fee_description: log.description || `${log.action_type || "Fee"} transaction`,
            due_date: log.fee?.due_date || null,
            payment_method: null,
        }));

        const expenseTransactions = approvedExpenseRecords.map((expense) => ({
            _id: expense._id,
            type: "expense",
            action_type: "Expense",
            amount: expense.amount,
            action_amount: expense.amount,
            action_date: expense.approved_at || expense.expense_date,
            action_by: expense.approved_by?.name || "N/A",
            student_name: expense.title,
            student_id: "N/A",
            batch_name: expense.category,
            program: expense.category || "Institutional Expense",
            title: expense.title,
            category: expense.category,
            description: expense.description || "",
            fee_description: expense.description || expense.title || "Approved expense",
            due_date: expense.expense_date || null,
            payment_method: expense.payment_method || "N/A",
        }));

        const mergedTransactions = [...feeTransactions, ...expenseTransactions]
            .sort((a, b) => new Date(b.action_date) - new Date(a.action_date))
            .slice(0, 100);

        res.status(200).json({
            period,
            start_date: start.format("YYYY-MM-DD"),
            end_date: end.format("YYYY-MM-DD"),
            summary: {
                total_fee_created,
                total_fee_recovered,
                total_fee_discounted,
                total_fee_deleted,
                total_fee_record,
                total_fee_pending,
                total_pending_amount,
                total_fee_defaulters,
                total_approved_expenses,
                total_pending_expenses,
                net_balance,
            },
            breakdown,
            transactions: mergedTransactions,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};