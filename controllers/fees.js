import Fee from "../models/fees.js";
import FeeLog from "../models/feeLogs.js";
import User from "../models/users.js";
import dotenv from "dotenv";
import Student from "../models/students.js";
import moment from "moment-timezone";
dotenv.config();

export const getFees = async (req, res) => {
    const { query, status } = req.query;

    try {
        const searchQuery = query ? query : '';

        const filter = {};

        if (status) {
            filter.status = status;
        }

        const options = {
            page: parseInt(req.query.page, 10) || 1,
            limit: parseInt(req.query.limit, 10) || 10,
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

        // Filter out fees where student is null (didn't match the regex)
        fees.docs = fees.docs.filter((f) => f.student != null);

        res.status(200).json(fees);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const getFeeById = async (req, res) => {
    const { id } = req.params;
    try {
        const fee = await Fee.findById(id).populate("student");
        if (!fee) {
            return res.status(404).json({ message: "Fee not found" });
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
    const { amount } = req.body;
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
            action_type: "Discounted",
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
        const feeLogs = await FeeLog.find({ fee: id }).populate("action_by").populate("fee").populate("student");
        res.status(200).json(feeLogs);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

export const getFeesByStudentId = async (req, res) => {
    const { id } = req.params;
    try {
        const fees = await Fee.find({ student: id });
        res.status(200).json(fees);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}