import mongoose from "mongoose";

const googleAccountSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    google_user_id: String,
    email: String,
    name: String,
    scopes: [String],
    access_token: String,
    refresh_token: String,
    expiry_date: Number,
    token_type: String,
    connected_at: Date,
    disconnected_at: Date,
    is_connected: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const GoogleAccount = mongoose.model("GoogleAccount", googleAccountSchema);
export default GoogleAccount;
