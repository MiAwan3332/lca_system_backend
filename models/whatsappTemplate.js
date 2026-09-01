import mongoose from "mongoose";

/**
 * process values:
 * - student_admission: when a student is added
 * - user_welcome: when a staff/admin user is added
 * - panelist_welcome: when a panelist is added
 * - qualifier_welcome: when a qualifier is added
 * - fee_payment: when a fee payment is recorded
 * - fee_reminder: pending fee reminders (manual / future automation)
 * - custom: not auto-sent by the system
 */
const whatsappTemplateSchema = mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    process: {
      type: String,
      required: true,
      enum: [
        "student_admission",
        "user_welcome",
        "panelist_welcome",
        "qualifier_welcome",
        "fee_payment",
        "fee_reminder",
        "custom",
      ],
      default: "custom",
      index: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

const WhatsAppTemplate = mongoose.model(
  "WhatsAppTemplate",
  whatsappTemplateSchema
);

export default WhatsAppTemplate;
