import mongoose from 'mongoose';
export default mongoose.model('AccessDefaults', new mongoose.Schema({
  _id: String,
  roles: { type: Map, of: mongoose.Schema.Types.ObjectId },
  revision: { type: Number, default: 1 },
}, { timestamps: true }));
