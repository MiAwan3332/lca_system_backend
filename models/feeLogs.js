import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const feeLogSchema = mongoose.Schema({
    amount: Number,
    action_amount: Number,
    action_date: Date,
    description: String,
    action_type: {
        type: String,
        default: "Paid",
        enum: ["Created", "Paid", "Discounted", "Deleted"]
    },
    action_by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    fee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Fee",
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Student",
    },
    payment_method: {
        type: String,
        enum: ["Cash", "Online"],
    },
    payment_evidence: {
        type: String,
        default: "",
    },
});

feeLogSchema.plugin(mongoosePaginate);

const FeeLog = mongoose.model("FeeLog", feeLogSchema);
export default FeeLog;
