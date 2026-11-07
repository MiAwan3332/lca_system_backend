import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const feeLogSchema = mongoose.Schema({
    evidence_status: { type: String, enum: ['pending', 'complete', 'failed'], default: 'complete' },
    evidence_edit_request: { type: mongoose.Schema.Types.ObjectId, ref: 'CreationRequest' },
    creation_worker_epoch: { type: Number, default: 0 },
    // Shared by every entry, receipt and slip of one collection, so the whole payment can be reverted together.
    payment_id: { type: String, index: true },
    amount: Number,
    action_amount: Number,
    action_date: Date,
    description: String,
    action_type: {
        type: String,
        default: "Paid",
        enum: ["Created", "Paid", "Discounted", "Deleted", "Refund"]
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
        enum: [
            "Cash",
            "Bank Transfer",
            "Online Payment",
            "Cheque",
            "Online", // legacy
        ],
    },
    payment_evidence: {
        type: mongoose.Schema.Types.Mixed,
        default: "",
    },
});

feeLogSchema.plugin(mongoosePaginate);

const FeeLog = mongoose.model("FeeLog", feeLogSchema);
export default FeeLog;
