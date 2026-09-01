import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const batchesSchema = mongoose.Schema({
  name: String,
  description: String,
  startdate: String,
  enddate: String,
  class_start_time: String,
  class_end_time: String,
  batch_fee: String,
  batch_type: String,
  is_special_batch: {
    type: Boolean,
    default: false,
  },
  is_interview_batch: {
    type: Boolean,
    default: false,
  },
  // Array of { key, label, fee } (legacy object shape still readable via helpers)
  special_fee_options: {
    type: mongoose.Schema.Types.Mixed,
    default: [],
  },
  is_active: {
    type: Boolean,
    default: true,
  },
  courses: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
    },
  ],
  teachers: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
    },
  ],
  teacher_course_assignments: [
    {
      teacher: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Teacher",
      },
      course: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
      },
    },
  ],
  google_classroom_course_id: String,
  google_classroom_course_url: String,
  google_synced_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  google_synced_at: Date,
});

batchesSchema.plugin(mongoosePaginate);

const Batch = mongoose.model("Batch", batchesSchema);
export default Batch;
