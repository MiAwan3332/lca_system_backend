import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const expenseSchema = mongoose.Schema(
  {
    title: String,
    description: String,
    amount: Number,
    category: {
      type: String,
      default: "Other",
      enum: [
        "Rent",
        "Salary",
        "Utilities",
        "Supplies",
        "Marketing",
        "Maintenance",
        "Transport",
        "Other",
      ],
    },
    expense_date: String,
    payment_method: {
      type: String,
      default: "Cash",
      enum: ["Cash", "Bank", "Card", "Other"],
    },
    status: {
      type: String,
      default: "Pending",
      enum: ["Pending", "Approved", "Rejected"],
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approved_at: Date,
    rejected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    rejected_at: Date,
    rejection_reason: String,
  },
  { timestamps: true }
);

expenseSchema.plugin(mongoosePaginate);

const Expense = mongoose.model("Expense", expenseSchema);
export default Expense;
