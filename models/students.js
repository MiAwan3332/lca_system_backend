import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const studentSchema = mongoose.Schema({
  creation_pending: { type: Boolean, default: false },
  creation_worker_epoch: { type: Number, default: 0 },
  creation_request: { type: mongoose.Schema.Types.ObjectId, ref: 'CreationRequest' },
  processing_status: { type: String, enum: ['pending', 'processing', 'complete', 'failed'], default: 'complete' },
  roll_number: {
    type: String,
    default: "",
    index: true,
  },
  name: String,
  email: String,
  phone: String,
  normalized_phone: String,
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  admission_request: { type: mongoose.Schema.Types.ObjectId, ref: 'CreationRequest' },
  cnic: String,
  admission_date: String,
  date_of_birth: String,
  father_name: String,
  father_phone: String,
  latest_degree: String,
  university: String,
  city: String,
  province: {
    type: String,
    default: "",
  },
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
  online_amount: {
    type: Number,
    default: 0,
  },
  cash_amount: {
    type: Number,
    default: 0,
  },
  is_special_batch: {
    type: Boolean,
    default: false,
  },
  // Map of optionKey -> { selected, fee, label } (supports dynamic options)
  special_fee_options: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
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
  /** Admission / fee discount reason captured at add or later discounts. */
  discount_remarks: {
    type: String,
    default: "",
  },
  is_active: {
    type: Boolean,
    default: true,
  },
});

studentSchema.pre('validate', function () {
  const digits = String(this.phone || '').replace(/\D/g, '');
  if (digits.length >= 10) this.normalized_phone = digits.slice(-10);
});
for (const operation of ['updateOne', 'findOneAndUpdate', 'updateMany']) studentSchema.pre(operation, function () {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) return;
  const phone = update.$set?.phone ?? update.phone;
  if (phone === undefined) return;
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) throw Object.assign(new Error('Enter a valid student phone number'), { status: 400 });
  if (update.$set) update.$set.normalized_phone = digits.slice(-10);
  else update.normalized_phone = digits.slice(-10);
});
studentSchema.plugin(mongoosePaginate);
studentSchema.index({ batch: 1, is_active: 1, _id: -1 });
studentSchema.index({ pending_fee: 1, batch: 1 });
studentSchema.index({ email: 1 });
studentSchema.index({ phone: 1 });
studentSchema.index({ normalized_phone: 1 }, { unique: true, partialFilterExpression: { normalized_phone: { $type: 'string' } } });
studentSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });

const Student = mongoose.model("Student", studentSchema);
export default Student;
