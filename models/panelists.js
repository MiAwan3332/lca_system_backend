import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const panelistSchema = mongoose.Schema(
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
    description: {
      type: String,
      required: true,
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
    /** Internal login email (phone-based) when a User account is created */
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
  },
  { timestamps: true }
);

panelistSchema.plugin(mongoosePaginate);

const Panelist = mongoose.model("Panelist", panelistSchema);
export default Panelist;
