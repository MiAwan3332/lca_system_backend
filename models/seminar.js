import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const seminarSchema = mongoose.Schema({
  name: String,
  date: String,
  time: String,
  description: String,
});

seminarSchema.plugin(mongoosePaginate);
seminarSchema.index({ date: -1 });

const Seminar = mongoose.model("Seminar", seminarSchema);
export default Seminar;
