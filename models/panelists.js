import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const panelistSchema = mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    access_assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'AccessAssignment' },
    access_role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
    normalized_phone: { type: String },
    login_setup_required: { type: Boolean, default: false },
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
panelistSchema.index({ is_active: 1, createdAt: -1 });
panelistSchema.index({ phone: 1 });
panelistSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
panelistSchema.index({ normalized_phone: 1 }, { unique: true, partialFilterExpression: { normalized_phone: { $type: 'string' } } });

const Panelist = mongoose.model("Panelist", panelistSchema);
export default Panelist;
