import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

/**
 * Status values:
 * - in_queue: waiting to send
 * - sending: currently being sent
 * - sent: delivered to WhatsApp gateway
 * - failed: send error
 * - cancelled: removed from queue before send
 */
const whatsappQueuedMessageSchema = mongoose.Schema(
  {
    recipient_name: {
      type: String,
      default: "",
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["in_queue", "sending", "sent", "failed", "cancelled"],
      default: "in_queue",
      index: true,
    },
    source: {
      type: String,
      default: "manual",
      trim: true,
      index: true,
    },
    process: {
      type: String,
      default: "",
      trim: true,
    },
    template_key: {
      type: String,
      default: "",
      trim: true,
    },
    template_name: {
      type: String,
      default: "",
      trim: true,
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    batch_name: {
      type: String,
      default: "",
      trim: true,
    },
    recipient_type: {
      type: String,
      default: "",
      trim: true,
    },
    recipient_id: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    campaign_id: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    error: {
      type: String,
      default: "",
      trim: true,
    },
    sent_at: {
      type: Date,
      default: null,
    },
    cancelled_at: {
      type: Date,
      default: null,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    created_by_name: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

whatsappQueuedMessageSchema.index({ status: 1, createdAt: 1 });
whatsappQueuedMessageSchema.plugin(mongoosePaginate);

const WhatsAppQueuedMessage = mongoose.model(
  "WhatsAppQueuedMessage",
  whatsappQueuedMessageSchema
);

export default WhatsAppQueuedMessage;
