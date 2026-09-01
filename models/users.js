import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const userSchema = mongoose.Schema({
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

const User = mongoose.model("User", userSchema);
export default User;
