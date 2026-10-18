import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

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
  avatar: String,
});

userSchema.plugin(mongoosePaginate);
userSchema.index({ email: 1 });
userSchema.index({ role: 1, _id: -1 });

const User = mongoose.model("User", userSchema);
export default User;
