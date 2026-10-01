import mongoose from "mongoose";
import mongoosePaginate from "mongoose-paginate-v2";

const attendeeSchema = mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  city: String,
  qualification: String,
  age: String,
  seminar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seminar",
  },
});

attendeeSchema.plugin(mongoosePaginate);
attendeeSchema.index({ seminar: 1, _id: -1 });

const Attendee = mongoose.model("Attendee", attendeeSchema);
export default Attendee;
