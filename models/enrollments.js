import mongoose from "mongoose";

const enrollmentSchema = mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Student",
  },
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
  },
  courses: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
    },
  ],
  fees: [
    {
      type: Number,
    },
  ],
});
enrollmentSchema.index({ student: 1, batch: 1 });
const Enrollment = mongoose.model("Enrollment", enrollmentSchema);

export default Enrollment;
