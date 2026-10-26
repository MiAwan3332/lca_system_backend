import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";
import { defaultAccessPlan, applyDefaultAccess } from '../utils/defaultAccess.js';

const userSchema = mongoose.Schema({
  creation_pending: { type: Boolean, default: false },
  creation_worker_epoch: { type: Number, default: 0 },
  creation_request: { type: mongoose.Schema.Types.ObjectId, ref: 'CreationRequest' },
  processing_status: { type: String, enum: ['pending', 'processing', 'complete', 'failed'], default: 'complete' },
  name: String,
  email: String,
  phone: {
    type: String,
    default: "",
    trim: true,
  },
  password: String,
  role: String,
  accountType: { type: String, enum: ['staff', 'student', 'teacher', 'qualifier', 'panelist'] },
  accessManaged: { type: Boolean, default: false },
  platformOwner: { type: Boolean, default: false },
  disabledAt: Date,
  accessOnboardingRole: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', select: false },
  avatar: String,
});

userSchema.pre('save', async function () {
  if (this.isNew) {
    this.$locals.defaultAccess = await defaultAccessPlan(this);
    if (this.$locals.defaultAccess) this.accessOnboardingRole = this.$locals.defaultAccess.role;
  }
});
userSchema.post('save', async function () { if (this.$locals.defaultAccess) await applyDefaultAccess(this, this.$locals.defaultAccess); });
userSchema.plugin(mongoosePaginate);
userSchema.index({ email: 1 });
userSchema.index({ role: 1, _id: -1 });

const User = mongoose.model("User", userSchema);
export default User;
