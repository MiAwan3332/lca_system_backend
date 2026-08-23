import InterviewPanel from "../models/interviewPanel.js";
import { getRequestUserId } from "../utils/lmsAccess.js";

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
      filter.date = {};
      if (start_date) filter.date.$gte = start_date;
      if (end_date) filter.date.$lte = end_date;
    }

    const panels = await InterviewPanel.paginate(filter, {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 10,
      sort: { date: -1, createdAt: -1 },
      populate: { path: "created_by", select: "name email" },
    });

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
      if (schedulesResult.schedules.length === 0) {
        return res
          .status(400)
          .json({ message: "Add at least one schedule for the panel" });
      }
      updatePayload.schedules = schedulesResult.schedules;
      Object.assign(
        updatePayload,
        syncPrimaryFromSchedules(schedulesResult.schedules)
      );
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

export const deleteInterviewPanel = async (req, res) => {
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
