import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const studentSchema = mongoose.Schema({
  roll_number: {
    type: String,
    default: "",
    index: true,
  },
  name: String,
  email: String,
  phone: String,
  cnic: String,
  admission_date: String,
  date_of_birth: String,
  father_name: String,
  father_phone: String,
  latest_degree: String,
  university: String,
  city: String,
  completion_year: String,
  marks_cgpa: String,
  cnic_image: String,
  cnic_back_image: String,
  image: String,
  latest_degree_image: String,
  qrcode: String,
  batch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Batch",
  },
  paid_fee: {
    type: Number,
    default: 0,
  },
  pending_fee: {
    type: Number,
    default: 0,
  },
  total_fee: {
    type: Number,
    default: 0,
  },
  profile_updated_once: {
    type: Boolean,
    default: false,
  },
  skip_profile_completion: {
    type: Boolean,
    default: false,
  },
  remarks: {
    type: String,
    default: "",
  },
  is_active: {
    type: Boolean,
    default: true,
  },
});

studentSchema.plugin(mongoosePaginate);

const Student = mongoose.model("Student", studentSchema);
export default Student;
