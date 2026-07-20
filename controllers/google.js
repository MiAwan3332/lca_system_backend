import moment from "moment-timezone";
import Assignment from "../models/assignments.js";
import Batch from "../models/batches.js";
import GoogleAccount from "../models/googleAccounts.js";
import Student from "../models/students.js";
import TimeTable from "../models/timeTables.js";
import {
  canAccessBatch,
  canAccessCourse,
  canManageLmsContent,
  getRequestUserId,
} from "../utils/lmsAccess.js";
import {
  exchangeGoogleCode,
  getGoogleAuthUrl,
  getGoogleServices,
  verifyGoogleState,
} from "../utils/googleClient.js";

const appRedirect = (key) =>
  process.env[key] || process.env.GOOGLE_OAUTH_SUCCESS_REDIRECT || "https://lca-portal.com/google-workspace";

const redirectWithStatus = (res, key, query) => {
  const target = new URL(appRedirect(key));
  Object.entries(query).forEach(([name, value]) => target.searchParams.set(name, value));
  return res.redirect(target.toString());
};

const ensureGoogleConfigured = () => {
  const missing = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
  ].filter((name) => !process.env[name]);
  if (missing.length) {
    const error = new Error(`Google integration is missing env values: ${missing.join(", ")}`);
    error.status = 503;
    throw error;
  }
};

const sendError = (res, error) =>
  res.status(error.status || 500).json({ message: error.message });

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));

export const getGoogleStatus = async (req, res) => {
  try {
    const account = await GoogleAccount.findOne({
      user: getRequestUserId(req),
      is_connected: true,
    }).select("email name scopes expiry_date connected_at updatedAt");

    res.status(200).json({
      configured: Boolean(
        process.env.GOOGLE_CLIENT_ID &&
          process.env.GOOGLE_CLIENT_SECRET &&
          process.env.GOOGLE_REDIRECT_URI &&
          process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
      ),
      connected: Boolean(account),
      account,
    });
  } catch (error) {
    sendError(res, error);
  }
};

export const getGoogleConnectUrl = async (req, res) => {
  try {
    ensureGoogleConfigured();
    res.status(200).json({ url: getGoogleAuthUrl(getRequestUserId(req)) });
  } catch (error) {
    sendError(res, error);
  }
};

export const googleCallback = async (req, res) => {
  try {
    if (req.query.error) {
      return redirectWithStatus(res, "GOOGLE_OAUTH_ERROR_REDIRECT", {
        google: "error",
        reason: req.query.error,
      });
    }

    ensureGoogleConfigured();
    const { userId } = verifyGoogleState(req.query.state);
    await exchangeGoogleCode(req.query.code, userId);
    return redirectWithStatus(res, "GOOGLE_OAUTH_SUCCESS_REDIRECT", {
      google: "connected",
    });
  } catch (error) {
    return redirectWithStatus(res, "GOOGLE_OAUTH_ERROR_REDIRECT", {
      google: "error",
      reason: error.message,
    });
  }
};

export const disconnectGoogle = async (req, res) => {
  try {
    await GoogleAccount.findOneAndUpdate(
      { user: getRequestUserId(req) },
      {
        access_token: null,
        refresh_token: null,
        expiry_date: null,
        is_connected: false,
        disconnected_at: new Date(),
      }
    );
    res.status(200).json({ message: "Google account disconnected" });
  } catch (error) {
    sendError(res, error);
  }
};

export const syncBatchClassroomCourse = async (req, res) => {
  try {
    if (!canManageLmsContent(req)) {
      return res.status(403).json({ message: "You do not have permission to sync batches" });
    }

    const batch = await Batch.findById(req.params.batchId).populate("courses");
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    if (!(await canAccessBatch(req, batch._id))) {
      return res.status(403).json({ message: "You cannot access this batch" });
    }

    if (batch.google_classroom_course_id) {
      return res.status(200).json({ batch, reused: true });
    }

    const { classroom } = await getGoogleServices(getRequestUserId(req));
    const { data: course } = await classroom.courses.create({
      requestBody: {
        name: batch.name,
        section: batch.batch_type || undefined,
        descriptionHeading: batch.name,
        description: batch.description || `LCA batch ${batch.name}`,
        ownerId: "me",
        courseState: "PROVISIONED",
      },
    });

    batch.google_classroom_course_id = course.id;
    batch.google_classroom_course_url = course.alternateLink;
    batch.google_synced_by = getRequestUserId(req);
    batch.google_synced_at = new Date();
    await batch.save();

    res.status(200).json({ batch, course });
  } catch (error) {
    sendError(res, error);
  }
};

export const syncAssignmentCoursework = async (req, res) => {
  try {
    if (!canManageLmsContent(req)) {
      return res.status(403).json({ message: "You do not have permission to sync assignments" });
    }

    const assignment = await Assignment.findById(req.params.assignmentId)
      .populate("batch")
      .populate("course");
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });

    if (!(await canAccessCourse(req, assignment.course?._id, assignment.batch?._id))) {
      return res.status(403).json({ message: "You cannot access this assignment" });
    }

    if (assignment.google_classroom_coursework_id) {
      return res.status(200).json({ assignment, reused: true });
    }

    if (!assignment.batch?.google_classroom_course_id) {
      return res.status(400).json({
        message: "Sync the assignment batch to Google Classroom before syncing coursework",
      });
    }

    const { classroom } = await getGoogleServices(getRequestUserId(req));
    const due = assignment.submission_deadline
      ? moment(assignment.submission_deadline).tz("Asia/Karachi")
      : null;
    const materials = (assignment.attachments || [])
      .filter((attachment) => attachment.file_url)
      .map((attachment) => ({
        link: {
          url: attachment.file_url,
          title: attachment.file_name || "Attachment",
        },
      }));

    const { data: courseWork } = await classroom.courses.courseWork.create({
      courseId: assignment.batch.google_classroom_course_id,
      requestBody: {
        title: assignment.title,
        description: [assignment.description, assignment.instructions].filter(Boolean).join("\n\n"),
        materials,
        workType: "ASSIGNMENT",
        state: assignment.visibility_status === "Published" ? "PUBLISHED" : "DRAFT",
        maxPoints: Number(assignment.max_marks) || 100,
        dueDate: due
          ? {
              year: due.year(),
              month: due.month() + 1,
              day: due.date(),
            }
          : undefined,
        dueTime: due
          ? {
              hours: due.hour(),
              minutes: due.minute(),
              seconds: 0,
            }
          : undefined,
      },
    });

    assignment.google_classroom_coursework_id = courseWork.id;
    assignment.google_classroom_alternate_link = courseWork.alternateLink;
    assignment.google_synced_by = getRequestUserId(req);
    assignment.google_synced_at = new Date();
    await assignment.save();

    res.status(200).json({ assignment, courseWork });
  } catch (error) {
    sendError(res, error);
  }
};

export const syncTimetableCalendarEvent = async (req, res) => {
  try {
    if (!canManageLmsContent(req)) {
      return res.status(403).json({ message: "You do not have permission to sync timetable events" });
    }

    const timetable = await TimeTable.findById(req.params.timetableId)
      .populate("batch")
      .populate("course")
      .populate("teacher");
    if (!timetable) return res.status(404).json({ message: "Timetable entry not found" });

    if (!(await canAccessCourse(req, timetable.course?._id, timetable.batch?._id))) {
      return res.status(403).json({ message: "You cannot access this timetable entry" });
    }

    if (timetable.google_calendar_event_id) {
      return res.status(200).json({ timetable, reused: true });
    }

    const start = moment.tz(
      `${timetable.day} ${timetable.start_time}`,
      ["YYYY-MM-DD HH:mm", "YYYY-MM-DD h:mm A", "YYYY-MM-DD hh:mm A"],
      "Asia/Karachi"
    );
    const end = moment.tz(
      `${timetable.day} ${timetable.end_time}`,
      ["YYYY-MM-DD HH:mm", "YYYY-MM-DD h:mm A", "YYYY-MM-DD hh:mm A"],
      "Asia/Karachi"
    );

    if (!start.isValid() || !end.isValid()) {
      return res.status(400).json({ message: "Timetable date or time is invalid" });
    }

    const students = await Student.find({ batch: timetable.batch?._id }).select("email");
    const attendeeEmails = [
      timetable.teacher?.email,
      ...students.map((student) => student.email),
    ].filter(isEmail);

    const { calendar } = await getGoogleServices(getRequestUserId(req));
    const { data: event } = await calendar.events.insert({
      calendarId: "primary",
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody: {
        summary: `${timetable.course?.name || "Class"} - ${timetable.batch?.name || "LCA Batch"}`,
        description: "Created from LCA Portal timetable.",
        start: {
          dateTime: start.toISOString(),
          timeZone: "Asia/Karachi",
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: "Asia/Karachi",
        },
        attendees: attendeeEmails.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: `lca-${timetable._id}-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      },
    });

    timetable.google_calendar_event_id = event.id;
    timetable.google_meet_link = event.hangoutLink;
    timetable.google_calendar_html_link = event.htmlLink;
    timetable.google_synced_by = getRequestUserId(req);
    timetable.google_synced_at = new Date();
    await timetable.save();

    res.status(200).json({ timetable, event });
  } catch (error) {
    sendError(res, error);
  }
};
