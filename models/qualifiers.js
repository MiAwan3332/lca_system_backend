import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const qualifierSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    cnic: {
      type: String,
      default: "",
      trim: true,
    },
    city: {
      type: String,
      default: "",
      trim: true,
    },
    province: {
      type: String,
      default: "",
      trim: true,
    },
    father_name: {
      type: String,
      default: "",
      trim: true,
    },
    father_phone: {
      type: String,
      default: "",
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },
    total_fee: {
      type: Number,
      default: 0,
    },
    discount_amount: {
      type: Number,
      default: 0,
    },
    discount_description: {
      type: String,
      default: "",
      trim: true,
    },
    paid_fee: {
      type: Number,
      default: 0,
    },
    pending_fee: {
      type: Number,
      default: 0,
    },
    payment_method: {
      type: String,
      default: "",
      trim: true,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    photo: {
      type: String,
      default: "",
    },
    optional_subjects: {
      type: [String],
      default: [],
    },
    /** CSS / exam attempt count */
    no_of_attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    latest_degree: {
      type: String,
      default: "",
      trim: true,
    },
    /** Array of qualification sections (legacy plain string still accepted by app layer). */
    education_background: {
      type: mongoose.Schema.Types.Mixed,
      default: [],
    },
  },
  { timestamps: true }
);

qualifierSchema.plugin(mongoosePaginate);

const Qualifier = mongoose.model("Qualifier", qualifierSchema);
export default Qualifier;
