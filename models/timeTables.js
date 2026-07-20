import mongoose from "mongoose";

const timetableSchema = mongoose.Schema({
    batch: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Batch",
    },
    course: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Course",
    },
    start_time: String,
    end_time: String,
    day: String,
    teacher: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Teacher",
    },
    google_calendar_event_id: String,
    google_meet_link: String,
    google_calendar_html_link: String,
    google_synced_by: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    google_synced_at: Date,
});
const TimeTable = mongoose.model('TimeTable', timetableSchema);
export default TimeTable;
