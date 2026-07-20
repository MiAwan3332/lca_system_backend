import express from "express";
import {
  disconnectGoogle,
  getGoogleConnectUrl,
  getGoogleStatus,
  googleCallback,
  syncAssignmentCoursework,
  syncBatchClassroomCourse,
  syncTimetableCalendarEvent,
} from "../controllers/google.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

router.get("/status", auth, getGoogleStatus);
router.get("/connect-url", auth, getGoogleConnectUrl);
router.get("/callback", googleCallback);
router.delete("/disconnect", auth, disconnectGoogle);
router.post("/classroom/batches/:batchId/sync-course", auth, syncBatchClassroomCourse);
router.post("/classroom/assignments/:assignmentId/sync", auth, syncAssignmentCoursework);
router.post("/calendar/timetable/:timetableId/sync-event", auth, syncTimetableCalendarEvent);

export default router;
