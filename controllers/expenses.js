import Expense from "../models/expenses.js";
import User from "../models/users.js";
import moment from "moment-timezone";

const buildExpenseFilter = (query = {}) => {
  const { search, category, status, start_date, end_date } = query;
  const filter = {};

  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { category: { $regex: search, $options: "i" } },
    ];
  }

  if (category) {
    filter.category = category;
  }

  if (status) {
    filter.status = status;
  }

  if (start_date || end_date) {
    filter.expense_date = {};
    if (start_date) filter.expense_date.$gte = start_date;
    if (end_date) filter.expense_date.$lte = end_date;
  }

  return filter;
};

const sumExpensesByStatus = async (filter, status) => {
  const match = { ...filter, status };
  const result = await Expense.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
  ]);
  return result.length > 0 ? result[0].total : 0;
};

export const getExpenses = async (req, res) => {
  const { query, category, status, start_date, end_date } = req.query;

  try {
    const filter = buildExpenseFilter({
      search: query || "",
      category,
      status,
      start_date,
      end_date,
    });

    const options = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { expense_date: -1, createdAt: -1 },
      populate: [
        { path: "created_by", select: "name email" },
        { path: "approved_by", select: "name email" },
        { path: "rejected_by", select: "name email" },
      ],
    };

    const expenses = await Expense.paginate(filter, options);

    const [total_amount, pending_amount, approved_amount, rejected_amount] =
      await Promise.all([
        Expense.aggregate([
          { $match: filter },
          { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
        ]).then((r) => (r[0]?.total ? r[0].total : 0)),
        sumExpensesByStatus(filter, "Pending"),
        sumExpensesByStatus(filter, "Approved"),
        sumExpensesByStatus(filter, "Rejected"),
      ]);

    res.status(200).json({
      ...expenses,
      total_amount,
      pending_amount,
      approved_amount,
      rejected_amount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getExpense = async (req, res) => {
  const { id } = req.params;

  try {
    const expense = await Expense.findById(id)
      .populate("created_by", "name email")
      .populate("approved_by", "name email")
      .populate("rejected_by", "name email");

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    res.status(200).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const addExpense = async (req, res) => {
  const { title, description, amount, category, expense_date, payment_method } =
    req.body;

  try {
    if (!title || !amount || amount <= 0) {
      return res
        .status(400)
        .json({ message: "Title and a valid amount are required" });
    }

    const actionUser = await User.findById(req.user.user.id);

    const newExpense = new Expense({
      title,
      description,
      amount,
      category: category || "Other",
      expense_date:
        expense_date || moment().tz("Asia/Karachi").format("YYYY-MM-DD"),
      payment_method: payment_method || "Cash",
      status: "Pending",
      created_by: actionUser?._id,
    });

    await newExpense.save();
    res.status(201).json(newExpense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateExpense = async (req, res) => {
  const { id } = req.params;
  const { title, description, amount, category, expense_date, payment_method } =
    req.body;

  try {
    const existingExpense = await Expense.findById(id);

    if (!existingExpense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    if (existingExpense.status !== "Pending") {
      return res.status(400).json({
        message: "Only pending expenses can be updated",
      });
    }

    if (!title || !amount || amount <= 0) {
      return res
        .status(400)
        .json({ message: "Title and a valid amount are required" });
    }

    const expense = await Expense.findByIdAndUpdate(
      id,
      {
        title,
        description,
        amount,
        category,
        expense_date,
        payment_method,
      },
      { new: true }
    );

    res.status(200).json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteExpense = async (req, res) => {
  const { id } = req.params;

  try {
    const expense = await Expense.findById(id);

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    if (expense.status === "Approved") {
      return res.status(400).json({
        message: "Approved expenses cannot be deleted",
      });
    }

    await Expense.findByIdAndDelete(id);
    res.status(200).json("Expense deleted successfully");
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const approveExpense = async (req, res) => {
  const { id } = req.params;

  try {
    const expense = await Expense.findById(id);

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    if (expense.status !== "Pending") {
      return res.status(400).json({
        message: "Only pending expenses can be approved",
      });
    }

    const approver = await User.findById(req.user.user.id);

    expense.status = "Approved";
    expense.approved_by = approver?._id;
    expense.approved_at = new Date();
    expense.rejected_by = undefined;
    expense.rejected_at = undefined;
    expense.rejection_reason = undefined;

    await expense.save();

    const updatedExpense = await Expense.findById(id)
      .populate("created_by", "name email")
      .populate("approved_by", "name email");

    res.status(200).json(updatedExpense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const rejectExpense = async (req, res) => {
  const { id } = req.params;
  const { rejection_reason } = req.body;

  try {
    const expense = await Expense.findById(id);

    if (!expense) {
      return res.status(404).json({ message: "Expense not found" });
    }

    if (expense.status !== "Pending") {
      return res.status(400).json({
        message: "Only pending expenses can be rejected",
      });
    }

    const rejector = await User.findById(req.user.user.id);

    expense.status = "Rejected";
    expense.rejected_by = rejector?._id;
    expense.rejected_at = new Date();
    expense.rejection_reason = rejection_reason || "";
    expense.approved_by = undefined;
    expense.approved_at = undefined;

    await expense.save();

    const updatedExpense = await Expense.findById(id)
      .populate("created_by", "name email")
      .populate("rejected_by", "name email");

    res.status(200).json(updatedExpense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const sumApprovedExpenses = async (startDate, endDate) => {
  const filter = {
    status: "Approved",
    expense_date: {
      $gte: startDate,
      $lte: endDate,
    },
  };

  const result = await Expense.aggregate([
    { $match: filter },
    { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } },
  ]);

  return result.length > 0 ? result[0].total : 0;
};
