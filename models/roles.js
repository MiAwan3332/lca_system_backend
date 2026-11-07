import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const roleSchema = mongoose.Schema({
  name: String,
  description: String,
  code: { type: String, immutable: true },
  active: { type: Boolean, default: true },
  managed: { type: Boolean, default: false },
  revision: { type: Number, default: 1 },
  profile: { type: String, default: null },
  grants: [{ _id: false, permission: { type: String, required: true },
    scope: { type: String, enum: ['all', 'own', 'assigned', 'selected'], default: 'all' },
    maxAmount: { type: Number, default: null }, noSelfApproval: { type: Boolean, default: false }, fields: [String] }],
  permissions: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Permission",
    },
  ],
});

roleSchema.plugin(mongoosePaginate);
roleSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });

const Role = mongoose.model("Role", roleSchema);
export default Role;
