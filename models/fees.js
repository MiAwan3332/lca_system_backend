import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const feeSchema = mongoose.Schema({
    amount: Number,
    due_date: String,
    status: {
        type: String,
        default: "Pending",
        enum: ["Pending", "Paid"]
    },
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Student",
    },
    batch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Batch",
    }
});

feeSchema.plugin(mongoosePaginate);
feeSchema.index({ student: 1, status: 1, due_date: 1 });
feeSchema.index({ batch: 1, status: 1, due_date: 1 });

const Fee = mongoose.model("Fee", feeSchema);
export default Fee;
