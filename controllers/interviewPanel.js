import InterviewPanel from "../models/interviewPanel.js";
import { getRequestUserId } from "../utils/lmsAccess.js";
import {
  isQualifierRole,
  resolveQualifierRecord,
  resolveQualifierByBooking,
  phonesMatch,
} from "../utils/qualifierScope.js";
import {
  isPanelistRole,
  resolvePanelistRecord,
} from "../utils/panelistScope.js";
import InterviewEvaluation, {
  SCORE_FIELDS,
} from "../models/interviewEvaluation.js";
import { serializeQualifierForInterview } from "../utils/qualifierEducation.js";
import {
  isQualifierProfileComplete,
  QUALIFIER_PROFILE_INCOMPLETE_MESSAGE,
  getQualifierProfileIncompleteFields,
} from "../utils/qualifierProfile.js";

const STATUS_VALUES = ["active", "inactive"];

const DEFAULT_MEMBER_ROLE = "Panelist";

const normalizeMembers = (members) => {
  if (!Array.isArray(members)) {
    return { members: [], error: null };
  }

  const normalized = [];
  for (const item of members) {
    if (!item) continue;
    if (typeof item === "string") {
      const name = item.trim();
      if (!name) continue;
      return {
        members: [],
        error: "Each panelist member requires a description",
      };
    }
    const name = String(item.name || "").trim();
    const description = String(item.description || "").trim();
    if (!name && !description) continue;
    if (!name) {
      return {
        members: [],
        error: "Each panelist member requires a name",
      };
    }
    if (!description) {
      return {
        members: [],
        error: "Each panelist member requires a description",
      };
    }
    normalized.push({
      panelist_id: item.panelist_id || null,
      name,
      role: String(item.role || "").trim() || DEFAULT_MEMBER_ROLE,
      description,
    });
  }
  return { members: normalized, error: null };
};

const normalizeStatus = (status) => {
  const value = String(status || "active")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");

  if (STATUS_VALUES.includes(value)) return value;
  // Legacy values from earlier interview-panel statuses
  if (["scheduled", "in_progress", "in-progress"].includes(value)) {
    return "active";
  }
  if (["completed", "cancelled", "canceled"].includes(value)) {
    return "inactive";
  }
  return "active";
};

const resolveTimeRange = (body = {}) => {
  const startTime = String(
    body.start_time || body.time || ""
  ).trim();
  const endTime = String(body.end_time || "").trim();

  if (startTime && endTime && String(endTime) <= String(startTime)) {
    return {
      error: "End time must be after start time",
    };
  }

  return {
    start_time: startTime,
    end_time: endTime,
    // Keep legacy `time` in sync with start for older clients/UI
    time: startTime,
  };
};

const normalizeSchedules = (schedules) => {
  if (!Array.isArray(schedules)) {
    return { schedules: [], error: null };
  }

  const normalized = [];
  for (const item of schedules) {
    if (!item) continue;
    const date = String(item.date || "").trim();
    const startTime = String(item.start_time || item.time || "").trim();
    const endTime = String(item.end_time || "").trim();
    const venue = String(item.venue || "").trim();
    const notes = String(item.notes || "").trim();
    const bookingStatus =
      String(item.booking_status || "available").toLowerCase() === "booked"
        ? "booked"
        : "available";
    const bookedFor = String(item.booked_for || "").trim();
    const bookedPhone = String(item.booked_phone || "").trim();
    const bookedNotes = String(item.booked_notes || "").trim();
    const bookedUserId = item.booked_user_id
      ? String(item.booked_user_id).trim()
      : "";

    if (
      !date &&
      !startTime &&
      !endTime &&
      !venue &&
      !notes &&
      bookingStatus !== "booked"
    ) {
      continue;
    }
    if (!date) {
      return { schedules: [], error: "Each schedule requires a date" };
    }
    if (startTime && endTime && String(endTime) <= String(startTime)) {
      return {
        schedules: [],
        error: "Schedule end time must be after start time",
      };
    }
    if (bookingStatus === "booked" && !bookedFor) {
      return {
        schedules: [],
        error: "Booked interviews require a candidate name",
      };
    }

    normalized.push({
      date,
      start_time: startTime,
      end_time: endTime,
      venue,
      notes,
      booking_status: bookingStatus,
      booked_for: bookingStatus === "booked" ? bookedFor : "",
      booked_phone: bookingStatus === "booked" ? bookedPhone : "",
      booked_notes: bookingStatus === "booked" ? bookedNotes : "",
      booked_user_id:
        bookingStatus === "booked" && bookedUserId ? bookedUserId : null,
      booked_at:
        bookingStatus === "booked"
          ? item.booked_at
            ? new Date(item.booked_at)
            : new Date()
          : null,
    });
  }

  return { schedules: normalized, error: null };
};

/** Keep primary date/time/venue in sync with the first schedule slot. */
const syncPrimaryFromSchedules = (schedules = []) => {
  const first = schedules[0];
  if (!first) return {};
  return {
    date: first.date,
    start_time: first.start_time || "",
    end_time: first.end_time || "",
    time: first.start_time || "",
    venue: first.venue || "",
  };
};

export const addInterviewPanel = async (req, res) => {
  if (isQualifierRole(req) || isPanelistRole(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { title, description, date, venue, status, members, schedules } =
      req.body;

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "Title is required" });
    }

    const timeRange = resolveTimeRange(req.body);
    if (timeRange.error) {
      return res.status(400).json({ message: timeRange.error });
    }

    const membersResult = normalizeMembers(members);
    if (membersResult.error) {
      return res.status(400).json({ message: membersResult.error });
    }

    let schedulesResult = normalizeSchedules(schedules);
    if (schedulesResult.error) {
      return res.status(400).json({ message: schedulesResult.error });
    }

    const primaryDate = String(date || "").trim();
    // Only seed a schedule when a primary date was provided
    if (schedulesResult.schedules.length === 0 && primaryDate) {
      schedulesResult = normalizeSchedules([
        {
          date: primaryDate,
          start_time: timeRange.start_time,
          end_time: timeRange.end_time,
          venue: String(venue || "").trim(),
        },
      ]);
      if (schedulesResult.error) {
        return res.status(400).json({ message: schedulesResult.error });
      }
    }

    const primary = syncPrimaryFromSchedules(schedulesResult.schedules);

    const panel = new InterviewPanel({
      title: String(title).trim(),
      description: String(description || "").trim(),
      date: primary.date || primaryDate || "",
      time: primary.time || timeRange.time || "",
      start_time: primary.start_time || timeRange.start_time || "",
      end_time: primary.end_time || timeRange.end_time || "",
      venue: primary.venue || String(venue || "").trim(),
      status: normalizeStatus(status),
      members: membersResult.members,
      schedules: schedulesResult.schedules,
      created_by: getRequestUserId(req) || undefined,
    });

    await panel.save();
    const populated = await InterviewPanel.findById(panel._id).populate(
      "created_by",
      "name email"
    );
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getInterviewPanels = async (req, res) => {
  try {
    const { query, status, start_date, end_date } = req.query;
    const searchQuery = String(query || "").trim();

    const filter = {};
    if (searchQuery) {
      filter.$or = [
        { title: { $regex: searchQuery, $options: "i" } },
        { description: { $regex: searchQuery, $options: "i" } },
        { venue: { $regex: searchQuery, $options: "i" } },
        { "members.name": { $regex: searchQuery, $options: "i" } },
      ];
    }

    if (status && STATUS_VALUES.includes(String(status))) {
      if (status === "active") {
        filter.status = { $in: ["active", "scheduled", "in_progress"] };
      } else if (status === "inactive") {
        filter.status = { $in: ["inactive", "completed", "cancelled", "canceled"] };
      } else {
        filter.status = status;
      }
    }

    if (start_date || end_date) {
      const dateClause = {};
      if (start_date) dateClause.$gte = start_date;
      if (end_date) dateClause.$lte = end_date;
      // Match primary panel date OR any schedule slot date
      const dateMatch = {
        $or: [
          { date: dateClause },
          { "schedules.date": dateClause },
        ],
      };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, dateMatch];
        delete filter.$or;
      } else {
        Object.assign(filter, dateMatch);
      }
    }

    const panels = await InterviewPanel.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { date: -1, createdAt: -1 },
      populate: { path: "created_by", select: "name email" },
    });

    if (isQualifierRole(req)) {
      const qualifier = await resolveQualifierRecord(req);
      if (!qualifier) {
        return res.status(404).json({ message: "Qualifier profile not found" });
      }

      const scopedDocs = (panels.docs || [])
        .map((panel) => {
          const plain = panel.toObject ? panel.toObject() : { ...panel };
          const schedules = (plain.schedules || []).filter((slot) => {
            const status = String(slot.booking_status || "available");
            // Qualifiers can see available slots (to book) and their own bookings
            if (status !== "booked") return true;
            return (
              phonesMatch(slot.booked_phone, qualifier.phone) ||
              String(slot.booked_for || "")
                .trim()
                .toLowerCase() ===
                String(qualifier.name || "").trim().toLowerCase()
            );
          });
          if (!schedules.length) return null;
          return { ...plain, schedules };
        })
        .filter(Boolean);

      return res.status(200).json({
        ...panels,
        docs: scopedDocs,
        totalDocs: scopedDocs.length,
        totalPages: 1,
        page: 1,
        pagingCounter: 1,
        hasPrevPage: false,
        hasNextPage: false,
        prevPage: null,
        nextPage: null,
      });
    }

    res.status(200).json(panels);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getInterviewPanel = async (req, res) => {
  try {
    const panel = await InterviewPanel.findById(req.params.id).populate(
      "created_by",
      "name email"
    );
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    res.status(200).json(panel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateInterviewPanel = async (req, res) => {
  if (isQualifierRole(req) || isPanelistRole(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id } = req.params;
    const existing = await InterviewPanel.findById(id);
    if (!existing) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    const { title, description, date, venue, status, members, schedules } =
      req.body;

    if (title !== undefined && !String(title || "").trim()) {
      return res.status(400).json({ message: "Title is required" });
    }
    if (date !== undefined && !String(date || "").trim()) {
      return res.status(400).json({ message: "Date is required" });
    }

    const updatePayload = {};
    if (title !== undefined) updatePayload.title = String(title).trim();
    if (description !== undefined) {
      updatePayload.description = String(description || "").trim();
    }
    if (date !== undefined) updatePayload.date = String(date).trim();
    if (venue !== undefined) updatePayload.venue = String(venue || "").trim();
    if (status !== undefined) updatePayload.status = normalizeStatus(status);
    if (members !== undefined) {
      const membersResult = normalizeMembers(members);
      if (membersResult.error) {
        return res.status(400).json({ message: membersResult.error });
      }
      updatePayload.members = membersResult.members;
    }

    if (schedules !== undefined) {
      const schedulesResult = normalizeSchedules(schedules);
      if (schedulesResult.error) {
        return res.status(400).json({ message: schedulesResult.error });
      }

      const shouldAppend =
        req.body.append_schedules === true ||
        req.body.append_schedules === "true" ||
        req.body.append_schedules === 1 ||
        req.body.append_schedules === "1";

      let nextSchedules = schedulesResult.schedules;
      if (shouldAppend) {
        if (schedulesResult.schedules.length === 0) {
          return res
            .status(400)
            .json({ message: "Add at least one schedule for the panel" });
        }
        const current = normalizeSchedules(existing.schedules || []).schedules;
        nextSchedules = [...current, ...schedulesResult.schedules];
      } else if (schedulesResult.schedules.length === 0) {
        return res
          .status(400)
          .json({ message: "Add at least one schedule for the panel" });
      }

      updatePayload.schedules = nextSchedules;
      Object.assign(updatePayload, syncPrimaryFromSchedules(nextSchedules));
    } else if (
      req.body.start_time !== undefined ||
      req.body.end_time !== undefined ||
      req.body.time !== undefined
    ) {
      const timeRange = resolveTimeRange({
        start_time:
          req.body.start_time !== undefined
            ? req.body.start_time
            : existing.start_time || existing.time,
        end_time:
          req.body.end_time !== undefined
            ? req.body.end_time
            : existing.end_time,
        time: req.body.time,
      });
      if (timeRange.error) {
        return res.status(400).json({ message: timeRange.error });
      }
      updatePayload.time = timeRange.time;
      updatePayload.start_time = timeRange.start_time;
      updatePayload.end_time = timeRange.end_time;
    }

    const updated = await InterviewPanel.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    }).populate("created_by", "name email");

    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const bookInterviewSlot = async (req, res) => {
  if (isPanelistRole(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id } = req.params;
    const scheduleIndex = Number(req.body?.schedule_index);
    const bookedNotes = String(req.body?.booked_notes || "").trim();

    if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0) {
      return res.status(400).json({ message: "Invalid schedule slot" });
    }

    const panel = await InterviewPanel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    const schedules = Array.isArray(panel.schedules) ? [...panel.schedules] : [];
    if (scheduleIndex >= schedules.length) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }

    const slot = schedules[scheduleIndex];
    if (!slot) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }

    if (String(slot.booking_status || "available") === "booked") {
      return res.status(400).json({ message: "This slot is already booked" });
    }

    let bookedFor = "";
    let bookedPhone = "";
    let bookedQualifierId = null;
    let bookedUserId = getRequestUserId(req) || null;

    if (isQualifierRole(req)) {
      const qualifier = await resolveQualifierRecord(req);
      if (!qualifier) {
        return res.status(404).json({ message: "Qualifier profile not found" });
      }
      if (!isQualifierProfileComplete(qualifier)) {
        const missing = getQualifierProfileIncompleteFields(qualifier);
        return res.status(400).json({
          message: QUALIFIER_PROFILE_INCOMPLETE_MESSAGE,
          missing_fields: missing,
        });
      }

      bookedFor = String(qualifier.name || "").trim();
      bookedPhone = String(qualifier.phone || "").trim();
      bookedQualifierId = qualifier._id;

      // One active booking per qualifier
      const panelsWithBooking = await InterviewPanel.find({
        schedules: {
          $elemMatch: {
            booking_status: "booked",
          },
        },
      }).select("schedules title");

      const hasExisting = panelsWithBooking.some((p) =>
        (p.schedules || []).some((s) => {
          if (String(s.booking_status || "") !== "booked") return false;
          return (
            phonesMatch(s.booked_phone, qualifier.phone) ||
            String(s.booked_for || "")
              .trim()
              .toLowerCase() ===
              String(qualifier.name || "").trim().toLowerCase()
          );
        })
      );

      if (hasExisting) {
        return res.status(400).json({
          message: "You already have an interview booked",
        });
      }
    } else {
      bookedFor = String(req.body?.booked_for || "").trim();
      bookedPhone = String(req.body?.booked_phone || "").trim();
      if (req.body?.booked_user_id) {
        bookedUserId = String(req.body.booked_user_id).trim();
      }
      if (!bookedFor) {
        return res.status(400).json({ message: "Candidate name is required" });
      }
      const resolvedQualifier = await resolveQualifierByBooking({
        booked_phone: bookedPhone,
        booked_for: bookedFor,
        booked_user_id: bookedUserId,
      });
      if (resolvedQualifier?._id) {
        bookedQualifierId = resolvedQualifier._id;
      }
    }

    schedules[scheduleIndex] = {
      ...(slot.toObject ? slot.toObject() : slot),
      booking_status: "booked",
      booked_for: bookedFor,
      booked_phone: bookedPhone,
      booked_notes: bookedNotes,
      booked_user_id: bookedUserId || null,
      booked_qualifier_id: bookedQualifierId || null,
      booked_at: new Date(),
      interview_status: "not_started",
      interview_started_at: null,
      interview_started_by: null,
    };

    panel.schedules = schedules;
    await panel.save();

    const populated = await InterviewPanel.findById(panel._id).populate(
      "created_by",
      "name email"
    );
    res.status(200).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteInterviewPanel = async (req, res) => {
  if (isQualifierRole(req) || isPanelistRole(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const deleted = await InterviewPanel.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Interview panel not found" });
    }
    res.status(200).json({ message: "Interview panel deleted successfully", id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const canConductInterview = (req) => !isQualifierRole(req);

const getScheduleSlot = (panel, scheduleIndex) => {
  const schedules = Array.isArray(panel?.schedules) ? panel.schedules : [];
  if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0) return null;
  return schedules[scheduleIndex] || null;
};

const slotToPlain = (slot) => (slot?.toObject ? slot.toObject() : { ...slot });

const validateEvaluationScores = (body) => {
  for (const [field, meta] of Object.entries(SCORE_FIELDS)) {
    const raw = body[field];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > meta.max) {
      return `${field.replace(/_/g, " ")} must be between 0 and ${meta.max}`;
    }
  }
  return null;
};

/** POST /interview-panels/start-interview/:id */
export const startInterview = async (req, res) => {
  if (!canConductInterview(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id } = req.params;
    const scheduleIndex = Number(req.body?.schedule_index);
    if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0) {
      return res.status(400).json({ message: "Invalid schedule slot" });
    }

    const panel = await InterviewPanel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    const slot = getScheduleSlot(panel, scheduleIndex);
    if (!slot) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }
    if (String(slot.booking_status || "") !== "booked") {
      return res.status(400).json({ message: "This slot is not booked" });
    }

    const plainSlot = slotToPlain(slot);
    let panelistId = null;
    if (isPanelistRole(req)) {
      const panelist = await resolvePanelistRecord(req);
      if (!panelist) {
        return res.status(404).json({ message: "Panelist profile not found" });
      }
      panelistId = panelist._id;
    }

    const schedules = [...panel.schedules];
    const currentStatus = String(plainSlot.interview_status || "not_started");
    if (currentStatus === "not_started") {
      schedules[scheduleIndex] = {
        ...plainSlot,
        interview_status: "in_progress",
        interview_started_at: new Date(),
        interview_started_by: panelistId || plainSlot.interview_started_by || null,
      };
      panel.schedules = schedules;
      await panel.save();
    }

    let qualifier = null;
    if (plainSlot.booked_qualifier_id) {
      qualifier = await resolveQualifierByBooking({
        booked_qualifier_id: plainSlot.booked_qualifier_id,
      });
    }
    if (!qualifier) {
      qualifier = await resolveQualifierByBooking({
        booked_phone: plainSlot.booked_phone,
        booked_for: plainSlot.booked_for,
        booked_user_id: plainSlot.booked_user_id,
      });
      if (qualifier?._id && !plainSlot.booked_qualifier_id) {
        schedules[scheduleIndex] = {
          ...(schedules[scheduleIndex]?.toObject
            ? schedules[scheduleIndex].toObject()
            : schedules[scheduleIndex]),
          booked_qualifier_id: qualifier._id,
        };
        panel.schedules = schedules;
        await panel.save();
      }
    }

    let evaluation = await InterviewEvaluation.findOne({
      panel_id: panel._id,
      schedule_index: scheduleIndex,
    });
    if (!evaluation) {
      evaluation = await InterviewEvaluation.create({
        panel_id: panel._id,
        schedule_index: scheduleIndex,
        qualifier_id: qualifier?._id || null,
        panelist_id: panelistId,
        started_by_user_id: getRequestUserId(req) || null,
        status: "in_progress",
      });
    }

    const updatedPanel = await InterviewPanel.findById(id).populate(
      "created_by",
      "name email"
    );

    res.status(200).json({
      panel: updatedPanel,
      schedule_index: scheduleIndex,
      slot: slotToPlain(updatedPanel.schedules[scheduleIndex]),
      qualifier: serializeQualifierForInterview(qualifier),
      evaluation,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** GET /interview-panels/conduct/:id/:scheduleIndex */
export const getConductInterview = async (req, res) => {
  if (!canConductInterview(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id, scheduleIndex: scheduleIndexRaw } = req.params;
    const scheduleIndex = Number(scheduleIndexRaw);
    if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0) {
      return res.status(400).json({ message: "Invalid schedule slot" });
    }

    const panel = await InterviewPanel.findById(id).populate(
      "created_by",
      "name email"
    );
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    const slot = getScheduleSlot(panel, scheduleIndex);
    if (!slot) {
      return res.status(404).json({ message: "Schedule slot not found" });
    }
    if (String(slot.booking_status || "") !== "booked") {
      return res.status(400).json({ message: "This slot is not booked" });
    }

    const plainSlot = slotToPlain(slot);
    const qualifier = await resolveQualifierByBooking({
      booked_qualifier_id: plainSlot.booked_qualifier_id,
      booked_phone: plainSlot.booked_phone,
      booked_for: plainSlot.booked_for,
      booked_user_id: plainSlot.booked_user_id,
    });

    const evaluation = await InterviewEvaluation.findOne({
      panel_id: panel._id,
      schedule_index: scheduleIndex,
    });

    res.status(200).json({
      panel,
      schedule_index: scheduleIndex,
      slot: plainSlot,
      qualifier: serializeQualifierForInterview(qualifier),
      evaluation,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** POST /interview-panels/submit-evaluation/:id */
export const submitInterviewEvaluation = async (req, res) => {
  if (!canConductInterview(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id } = req.params;
    const scheduleIndex = Number(req.body?.schedule_index);
    if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0) {
      return res.status(400).json({ message: "Invalid schedule slot" });
    }

    const scoreError = validateEvaluationScores(req.body);
    if (scoreError) {
      return res.status(400).json({ message: scoreError });
    }

    const verdict = String(req.body?.verdict || "").trim();
    const allowedVerdicts = [
      "ready_final_css",
      "needs_more_mock",
      "intensive_coaching",
    ];
    if (!allowedVerdicts.includes(verdict)) {
      return res.status(400).json({ message: "Lead panelist verdict is required" });
    }

    const panel = await InterviewPanel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    const slot = getScheduleSlot(panel, scheduleIndex);
    if (!slot) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }
    if (String(slot.booking_status || "") !== "booked") {
      return res.status(400).json({ message: "This slot is not booked" });
    }

    let panelistId = null;
    if (isPanelistRole(req)) {
      const panelist = await resolvePanelistRecord(req);
      panelistId = panelist?._id || null;
    }

    const plainSlot = slotToPlain(slot);
    const qualifier = await resolveQualifierByBooking({
      booked_qualifier_id: plainSlot.booked_qualifier_id,
      booked_phone: plainSlot.booked_phone,
      booked_for: plainSlot.booked_for,
      booked_user_id: plainSlot.booked_user_id,
    });

    const scorePayload = {};
    for (const field of Object.keys(SCORE_FIELDS)) {
      const raw = req.body[field];
      scorePayload[field] =
        raw === null || raw === undefined || raw === "" ? null : Number(raw);
    }

    const evaluationPayload = {
      ...scorePayload,
      key_strength: String(req.body?.key_strength || "").trim(),
      major_weakness: String(req.body?.major_weakness || "").trim(),
      improvement_since_last_mock: String(
        req.body?.improvement_since_last_mock || ""
      ).trim(),
      verdict,
      final_remarks: String(req.body?.final_remarks || "").trim(),
      qualifier_id: qualifier?._id || null,
      panelist_id: panelistId,
      status: "completed",
      completed_at: new Date(),
    };

    let evaluation = await InterviewEvaluation.findOne({
      panel_id: panel._id,
      schedule_index: scheduleIndex,
    });

    if (evaluation) {
      Object.assign(evaluation, evaluationPayload);
      await evaluation.save();
    } else {
      evaluation = await InterviewEvaluation.create({
        panel_id: panel._id,
        schedule_index: scheduleIndex,
        started_by_user_id: getRequestUserId(req) || null,
        started_at: new Date(),
        ...evaluationPayload,
      });
    }

    const schedules = [...panel.schedules];
    schedules[scheduleIndex] = {
      ...plainSlot,
      interview_status: "completed",
      interview_started_at:
        plainSlot.interview_started_at || evaluation.started_at || new Date(),
      interview_started_by:
        plainSlot.interview_started_by || panelistId || null,
    };
    panel.schedules = schedules;
    await panel.save();

    res.status(200).json({ evaluation, message: "Mock evaluation submitted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
