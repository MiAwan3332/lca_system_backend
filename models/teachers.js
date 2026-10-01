import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const teacherSchema = mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  resume: String,
  image: String,
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
});

teacherSchema.plugin(mongoosePaginate);
teacherSchema.index({ user: 1 });
teacherSchema.index({ email: 1 });

const Teacher = mongoose.model("Teacher", teacherSchema);
export default Teacher;
