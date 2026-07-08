import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const announcementSchema = mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    batches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Batch",
        required: true,
      },
    ],
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recipient_count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

announcementSchema.plugin(mongoosePaginate);

const Announcement = mongoose.model("Announcement", announcementSchema);
export default Announcement;
