import mongoose from "mongoose";

const studentRollCounterSchema = mongoose.Schema(
  {
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
      unique: true,
      index: true,
    },
    seq: {
      type: Number,
      default: 0,
      required: true,
      min: 0,
    },
  },
  { timestamps: true }
);

const StudentRollCounter = mongoose.model("StudentRollCounter", studentRollCounterSchema);
export default StudentRollCounter;

