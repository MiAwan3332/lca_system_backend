import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const mcqsSchema = mongoose.Schema(
  {
    question: { type: String, required: true },
    option1: { type: String, required: true },
    option2: { type: String, required: true },
    option3: { type: String, required: true },
    option4: { type: String, required: true },
    correct_option: { type: String, required: true },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
    },
  },
  { timestamps: true }
);

mcqsSchema.plugin(mongoosePaginate);

const Mcqs = mongoose.model("Mcqs", mcqsSchema);
export default Mcqs;

