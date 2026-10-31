import {accessContext} from '../utils/accessContext.js';
import { interviewMutation, interviewError } from '../utils/interviewLock.js';
import { mergeInterviewSchedules, assertInterviewConflicts, validatePanelMembers, panelMode, slotIndex, migrateEvaluationSlotLinks, finalizeInterviewProgress, activeSlot, requireInterviewAction, evaluationSlotQuery, evaluatorForRequest } from '../utils/interviewIntegrity.js';
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

const isSlotBooked = (slot) =>
  String(slot?.booking_status || "available").toLowerCase() === "booked";

const idsMatch = (a, b) => Boolean(a && b && String(a) === String(b));

/** Normalize schedule date strings to YYYY-MM-DD for same-day comparisons. */
const normalizeScheduleDateKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${month}-${day}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return raw.toLowerCase();
};

const isOwnQualifierBooking = (slot, qualifier) => {
  if (!qualifier || !isSlotBooked(slot)) return false;
  const slotQualifierId =
    slot.booked_qualifier_id?._id || slot.booked_qualifier_id;
  if (idsMatch(slotQualifierId, qualifier._id)) return true;
  if (phonesMatch(slot.booked_phone, qualifier.phone)) return true;
  const slotName = String(slot.booked_for || "").trim().toLowerCase();
  const qualifierName = String(qualifier.name || "").trim().toLowerCase();
  return Boolean(slotName && qualifierName && slotName === qualifierName);
};

/**
 * Returns an existing booked slot for this qualifier on the same calendar day,
 * or null if none. Optionally skip one panel (e.g. the panel being updated).
 */
const findQualifierSameDayBooking = async ({
  qualifier,
  date,
  excludePanelId = null,
} = {}) => {
  if (!qualifier) return null;
  const targetDateKey = normalizeScheduleDateKey(date);
  if (!targetDateKey) return null;

  const panels = await accessContext.run(undefined,async()=>await InterviewPanel.find({
    schedules: {
      $elemMatch: {
        booking_status: "booked",
      },
    },
  }).select("schedules title"));

  for (const panel of panels) {
    if (excludePanelId && idsMatch(panel._id, excludePanelId)) continue;
    const list = panel.schedules || [];
    for (let i = 0; i < list.length; i += 1) {
      const slot = list[i];
      if (!activeSlot(slot) || !isOwnQualifierBooking(slot, qualifier)) continue;
      if (normalizeScheduleDateKey(slot.date) !== targetDateKey) continue;
      return {
        panel,
        slot,
        scheduleIndex: i,
        dateKey: targetDateKey,
      };
    }
  }
  return null;
};

const sameDayBookingMessage = (dateKey, { forSelf = false } = {}) => {
  const dateLabel = dateKey || "this day";
  if (forSelf) {
    return `You can only book one interview per day. You already have an interview on ${dateLabel}.`;
  }
  return `This qualifier can only book one interview per day. They already have an interview on ${dateLabel}.`;
};

/** Ensure booked slots in a schedules payload don't double-book a qualifier on one day. */
const assertNoQualifierSameDayDoubleBooking = async ({
  schedules,
  excludePanelId = null,
} = {}) => {
  const list = Array.isArray(schedules) ? schedules : [];
  const seen = new Map();

  for (let i = 0; i < list.length; i += 1) {
    const slot = list[i];
    if (!activeSlot(slot) || !isSlotBooked(slot)) continue;

    const qualifier = await resolveQualifierByBooking({
      booked_qualifier_id: slot.booked_qualifier_id,
      booked_phone: slot.booked_phone,
      booked_for: slot.booked_for,
      booked_user_id: slot.booked_user_id,
    });
    if (!qualifier?._id) continue;

    const dateKey = normalizeScheduleDateKey(slot.date);
    if (!dateKey) continue;

    const localKey = `${String(qualifier._id)}|${dateKey}`;
    if (seen.has(localKey)) {
      return {
        error: sameDayBookingMessage(dateKey, { forSelf: false }),
      };
    }
    seen.set(localKey, i);

    const existing = await findQualifierSameDayBooking({
      qualifier,
      date: slot.date,
      excludePanelId,
    });
    if (existing) {
      return {
        error: sameDayBookingMessage(existing.dateKey || dateKey, {
          forSelf: false,
        }),
      };
    }
  }

  return { error: null };
};

/** Qualifiers see available slots plus their own booked / in-progress / completed ones. */
const sanitizeSchedulesForQualifier = (schedules, qualifier) =>
  (Array.isArray(schedules) ? schedules : [])
    .map((slot, originalIndex) => {
      const plain = slot?.toObject ? slot.toObject() : { ...slot };
      const booked = isSlotBooked(plain);
      if (booked && !isOwnQualifierBooking(plain, qualifier)) {
        return null;
      }
      return {
        ...plain,
        booking_status: booked ? "booked" : "available",
        schedule_array_index: originalIndex,
      };
    })
    .filter(Boolean);

const sanitizePanelForQualifier = (panel, qualifier, { dropEmpty = false } = {}) => {
  if (!panel) return panel;
  const plain = panel?.toObject ? panel.toObject() : { ...panel };
  const schedules = sanitizeSchedulesForQualifier(plain.schedules, qualifier);
  if (!schedules.length && dropEmpty) return null;
  return {
    ...plain,
    schedules,
  };
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

export const addInterviewPanel = interviewMutation(async (req,res) => {
  try {
    const body=req.body || {};if(!String(body.title||'').trim())throw interviewError(400,'Title is required');
    const parsed=normalizeMembers(body.members);if(parsed.error)throw interviewError(400,parsed.error);
    const mode=body.panel_type || (parsed.members.length===1?'solo':'team');await validatePanelMembers(parsed.members,mode);
    const panel=new InterviewPanel({title:String(body.title).trim(),description:body.description || '',status:normalizeStatus(body.status),panel_type:mode,members:parsed.members,created_by:getRequestUserId(req)});
    let rows=body.schedules || [];if(!rows.length&&body.date)rows=[{date:body.date,start_time:body.start_time||body.time,end_time:body.end_time,venue:body.venue}];
    if(rows.length)requireInterviewAction(req,'interview-panels.add.interview.schedules');
    panel.schedules=await mergeInterviewSchedules(req,panel,rows,{creating:true});
    const candidateConflict=await accessContext.run(undefined,async()=>await assertNoQualifierSameDayDoubleBooking({schedules:panel.schedules,excludePanelId:panel._id}));if(candidateConflict.error)throw interviewError(409,candidateConflict.error);
    if(panel.status==='active')await assertInterviewConflicts(panel,panel.schedules);
    Object.assign(panel,syncPrimaryFromSchedules(panel.schedules));await panel.save();res.json(panel);
  }catch(error){res.status(error.status || 500).json({message:error.message});}
});

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
        .map((panel) =>
          (req.access?.panelistId && panel.members?.some(m=>String(m.panelist_id)===String(req.access.panelistId)) ? panel : sanitizePanelForQualifier(panel, qualifier, { dropEmpty: true }))
        )
        .filter(Boolean);

      return res.status(200).json({
        ...panels,
        docs: scopedDocs,
      });
    }

    res.status(200).json(panels);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
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

    if (isQualifierRole(req) && !(req.access?.panelistId && panel.members.some(m=>String(m.panelist_id)===String(req.access.panelistId)))) {
      const qualifier = await resolveQualifierRecord(req);
      if (!qualifier) {
        return res.status(404).json({ message: "Qualifier profile not found" });
      }
      return res.status(200).json(sanitizePanelForQualifier(panel, qualifier));
    }

    res.status(200).json(panel);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

export const updateInterviewPanel = interviewMutation(async(req,res)=>{
  try{
    const panel=await InterviewPanel.findById(req.params.id);if(!panel)throw interviewError(404,'Interview panel not found');
    const body=req.body || {};if(body.expected_revision!==undefined && Number(body.expected_revision)!==panel.__v)throw interviewError(409,'This panel changed. Refresh before saving.');
    const parsed=body.members===undefined?{members:panel.members}:normalizeMembers(body.members);if(parsed.error)throw interviewError(400,parsed.error);
    const mode=body.panel_type || panelMode(panel);
    const membersChanged=JSON.stringify(parsed.members.map(m=>String(m.panelist_id)).sort())!==JSON.stringify(panel.members.map(m=>String(m.panelist_id)).sort()) || mode!==panelMode(panel);
    if(membersChanged&&panel.schedules.some(s=>s.booking_status==='booked'&&activeSlot(s)))throw interviewError(409,'This panel has booked interviews. Keep its membership or create another panel for a different team.');
    if(membersChanged || body.members!==undefined)await validatePanelMembers(parsed.members,mode);
    if(body.title!==undefined){if(!String(body.title).trim())throw interviewError(400,'Title is required');panel.title=String(body.title).trim();}
    if(body.description!==undefined)panel.description=String(body.description);
    if(body.status!==undefined)panel.status=normalizeStatus(body.status);
    if(body.members!==undefined)panel.members=parsed.members;panel.panel_type=mode;
    if(body.schedules!==undefined){await migrateEvaluationSlotLinks(panel);panel.schedules=await mergeInterviewSchedules(req,panel,body.schedules,{append:body.append_schedules===true||body.append_schedules==='true'});}
    else if(['date','start_time','end_time','time'].some(k=>body[k]!==undefined&&String(body[k])!==String(panel[k]||'')))throw interviewError(400,'Use the schedule editor to change interview dates and times');
    const candidateConflict=await accessContext.run(undefined,async()=>await assertNoQualifierSameDayDoubleBooking({schedules:panel.schedules,excludePanelId:panel._id}));if(candidateConflict.error)throw interviewError(409,candidateConflict.error);
    if(panel.status==='active')await assertInterviewConflicts(panel,panel.schedules);
    Object.assign(panel,syncPrimaryFromSchedules(panel.schedules));await panel.save();res.json(panel);
  }catch(error){res.status(error.status || (error.name==='VersionError'?409:500)).json({message:error.message});}
});

export const addInterviewSchedules = interviewMutation(async(req,res)=>{
  try{
    const panel=await InterviewPanel.findById(req.params.id);if(!panel)throw interviewError(404,'Panel not found');
    if(req.body.expected_revision!==undefined&&Number(req.body.expected_revision)!==panel.__v)throw interviewError(409,'Schedules changed. Refresh before adding slots.');
    if(!Array.isArray(req.body.schedules)||!req.body.schedules.length)throw interviewError(400,'Add at least one schedule');
    await validatePanelMembers(panel.members,panelMode(panel));await migrateEvaluationSlotLinks(panel);
    panel.schedules=await mergeInterviewSchedules(req,panel,req.body.schedules,{append:true});
    const candidateConflict=await accessContext.run(undefined,async()=>await assertNoQualifierSameDayDoubleBooking({schedules:panel.schedules,excludePanelId:panel._id}));if(candidateConflict.error)throw interviewError(409,candidateConflict.error);
    if(panel.status==='active')await assertInterviewConflicts(panel,panel.schedules);
    Object.assign(panel,syncPrimaryFromSchedules(panel.schedules));await panel.save();res.json(panel);
  }catch(error){res.status(error.status||500).json({message:error.message});}
});
export const updateInterviewSchedules = interviewMutation(async(req,res)=>{
  try{
    const panel=await InterviewPanel.findById(req.params.id);if(!panel)throw interviewError(404,'Panel not found');
    if(req.body.expected_revision!==undefined&&Number(req.body.expected_revision)!==panel.__v)throw interviewError(409,'Schedules changed. Refresh before saving.');
    await migrateEvaluationSlotLinks(panel);panel.schedules=await mergeInterviewSchedules(req,panel,req.body.schedules);
    const candidateConflict=await accessContext.run(undefined,async()=>await assertNoQualifierSameDayDoubleBooking({schedules:panel.schedules,excludePanelId:panel._id}));if(candidateConflict.error)throw interviewError(409,candidateConflict.error);
    if(panel.status==='active')await assertInterviewConflicts(panel,panel.schedules);
    Object.assign(panel,syncPrimaryFromSchedules(panel.schedules));await panel.save();res.json(panel);
  }catch(error){res.status(error.status||500).json({message:error.message});}
});
export const cancelInterviewSchedule = interviewMutation(async(req,res)=>{
  try{
    const panel=await InterviewPanel.findById(req.params.id);if(!panel)throw interviewError(404,'Panel not found');
    const index=slotIndex(panel,req.params.scheduleId);if(index<0)throw interviewError(404,'Schedule not found');
    if(req.body.expected_revision!==undefined&&Number(req.body.expected_revision)!==panel.__v)throw interviewError(409,'Schedules changed. Refresh before cancelling.');
    const slot=panel.schedules[index];if(['in_progress','completed'].includes(slot.interview_status))throw interviewError(409,'An interview which has started cannot be cancelled');
    if(!String(req.body.cancellation_reason||'').trim())throw interviewError(400,'Enter a cancellation reason');
    await migrateEvaluationSlotLinks(panel);slot.interview_status='cancelled';slot.cancelled_at=new Date();slot.cancelled_by=getRequestUserId(req);slot.cancellation_reason=String(req.body.cancellation_reason).trim();
    await panel.save();res.json(panel);
  }catch(error){res.status(error.status||500).json({message:error.message});}
});

export const bookInterviewSlot = interviewMutation(async (req, res) => {
  if (!req.access?.enforced && isPanelistRole(req)) return res.status(403).json({message:"Not allowed"});
  try {
    const { id } = req.params;
    let scheduleIndex = req.body?.schedule_id || req.body?.schedule_index;
    const bookedNotes = String(req.body?.booked_notes || "").trim();

    if (scheduleIndex === undefined || scheduleIndex === null || scheduleIndex === '') {
      return res.status(400).json({ message: "Invalid schedule slot" });
    }

    const panel = await InterviewPanel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    scheduleIndex=slotIndex(panel,scheduleIndex);
    if(scheduleIndex<0)return res.status(404).json({message:'Schedule slot not found'});
    if(panel.status==='inactive'||!activeSlot(panel.schedules[scheduleIndex]))return res.status(409).json({message:'This schedule is inactive or cancelled'});
    const schedules = Array.isArray(panel.schedules) ? [...panel.schedules] : [];
    if (scheduleIndex >= schedules.length) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }

    const slot = schedules[scheduleIndex];
    if (!slot) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }

    if (isSlotBooked(slot)) {
      return res.status(400).json({ message: "This slot is already booked" });
    }

    const requestedDate = String(req.body?.date || "").trim();
    const requestedStart = String(req.body?.start_time || "").trim();
    if (requestedDate && String(slot.date || "").trim() !== requestedDate) {
      return res.status(409).json({
        message: "This slot has changed. Refresh the page and try again.",
      });
    }
    if (
      requestedStart &&
      String(slot.start_time || slot.time || "").trim() !== requestedStart
    ) {
      return res.status(409).json({
        message: "This slot has changed. Refresh the page and try again.",
      });
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

      // One interview booking per qualifier per calendar day
      const existingSameDay = await findQualifierSameDayBooking({
        qualifier,
        date: slot.date,
      });
      if (existingSameDay) {
        return res.status(400).json({
          message: sameDayBookingMessage(existingSameDay.dateKey, {
            forSelf: true,
          }),
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
        booked_qualifier_id: req.body?.qualifier_id,
        booked_phone: bookedPhone,
        booked_for: bookedFor,
        booked_user_id: bookedUserId,
      });
      if(!resolvedQualifier)throw interviewError(400,'Select an existing candidate or enter the phone number from their Qualifier profile');
      bookedFor=resolvedQualifier.name;bookedPhone=resolvedQualifier.phone;
      bookedUserId=resolvedQualifier.user || null;
      if (resolvedQualifier?._id) {
        bookedQualifierId = resolvedQualifier._id;
        const existingSameDay = await findQualifierSameDayBooking({
          qualifier: resolvedQualifier,
          date: slot.date,
        });
        if (existingSameDay) {
          return res.status(400).json({
            message: sameDayBookingMessage(existingSameDay.dateKey, {
              forSelf: false,
            }),
          });
        }
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
      required_panelist_ids: panel.members.map(m=>m.panelist_id),
      interview_started_at: null,
      interview_started_by: null,
    };

    panel.schedules = schedules;
    await panel.save();

    const populated = await InterviewPanel.findById(panel._id).populate(
      "created_by",
      "name email"
    );

    if (isQualifierRole(req)) {
      const qualifier = await resolveQualifierRecord(req);
      return res
        .status(200)
        .json(sanitizePanelForQualifier(populated, qualifier));
    }

    res.status(200).json(populated);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

export const deleteInterviewPanel = interviewMutation(async (req, res) => {
  if (!req.access?.enforced && (isQualifierRole(req) || isPanelistRole(req))) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const historical=await InterviewPanel.findById(req.params.id);
    if(historical?.schedules?.some(s=>s.booking_status==='booked') || await InterviewEvaluation.exists({panel_id:req.params.id}))throw interviewError(409,'This panel has interview history. Deactivate it instead of deleting it.');
    const deleted = await InterviewPanel.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Interview panel not found" });
    }
    res.status(200).json({ message: "Interview panel deleted successfully", id: req.params.id });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

const canConductInterview = (req) => req.access?.enforced ? req.access.routeAllowed : !isQualifierRole(req);

const getScheduleSlot = (panel,reference) => { const index=slotIndex(panel,reference);return index<0?null:panel.schedules[index]; };

const slotToPlain = (slot) => (slot?.toObject ? slot.toObject() : { ...slot });

const SCORE_MAX_TOTAL = Object.values(SCORE_FIELDS).reduce(
  (sum, meta) => sum + (meta.max || 0),
  0
);

const getEvaluatorKey = (req, panelistId) => {
  if (panelistId) return `panelist:${panelistId}`;
  const userId = getRequestUserId(req);
  return userId ? `user:${userId}` : "";
};

const evaluationScoreSummary = (evaluation) => {
  let total = 0;
  const scores = {};
  for (const [field, meta] of Object.entries(SCORE_FIELDS)) {
    const raw = evaluation?.[field];
    const value =
      raw === null || raw === undefined || raw === ""
        ? null
        : Number(raw);
    const numeric = Number.isFinite(value) ? value : null;
    scores[field] = numeric;
    if (numeric != null) total += numeric;
  }
  return {
    scores,
    total: Math.round(total * 10) / 10,
    max_total: SCORE_MAX_TOTAL,
  };
};

const averageEvaluations = (evaluations = []) => {
  const completed = (evaluations || []).filter(
    (item) => String(item.status || "") === "completed"
  );
  const fieldAverages = {};
  for (const field of Object.keys(SCORE_FIELDS)) {
    const values = completed
      .map((item) => Number(item[field]))
      .filter((value) => Number.isFinite(value));
    fieldAverages[field] = values.length
      ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) /
        10
      : null;
  }
  const totals = completed.map((item) => evaluationScoreSummary(item).total);
  const overallAverage = totals.length
    ? Math.round((totals.reduce((sum, value) => sum + value, 0) / totals.length) * 10) /
      10
    : null;
  return {
    field_averages: fieldAverages,
    overall_average: overallAverage,
    overall_max: SCORE_MAX_TOTAL,
    evaluator_count: completed.length,
  };
};

const serializeEvaluationForDetails = (evaluation, panel) => {
  const plain = evaluation?.toObject ? evaluation.toObject() : { ...evaluation };
  const panelistDoc = plain.panelist_id && typeof plain.panelist_id === "object"
    ? plain.panelist_id
    : null;
  const panelistId = panelistDoc?._id || plain.panelist_id || null;
  const member = (panel?.members || []).find((item) => {
    const memberId = item.panelist_id?._id || item.panelist_id;
    return panelistId && memberId && String(memberId) === String(panelistId);
  });
  const summary = evaluationScoreSummary(plain);
  return {
    ...plain,
    panelist_id: panelistId,
    panelist_name: panelistDoc?.name || member?.name || "Panelist",
    panelist_role: member?.role || "Panelist",
    total_score: summary.total,
    max_total: summary.max_total,
  };
};

const findEvaluatorEvaluation = async ({
  panelId,
  scheduleIndex,
  scheduleId,
  evaluatorKey,
  panelistId,
  userId,
}) => {
  if (evaluatorKey) {
    const byKey = await InterviewEvaluation.findOne({
      panel_id: panelId,
      ...evaluationSlotQuery(scheduleId,scheduleIndex),
      evaluator_key: evaluatorKey,
    });
    if (byKey) return byKey;
  }
  if (panelistId) {
    const byPanelist = await InterviewEvaluation.findOne({
      panel_id: panelId,
      ...evaluationSlotQuery(scheduleId,scheduleIndex),
      panelist_id: panelistId,
    });
    if (byPanelist) return byPanelist;
  }
  if (userId) {
    const byUser = await InterviewEvaluation.findOne({
      panel_id: panelId,
      ...evaluationSlotQuery(scheduleId,scheduleIndex),
      started_by_user_id: userId,
    });
    if (byUser) return byUser;
  }
  return null;
};

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
export const startInterview = interviewMutation(async (req, res) => {
  if (!canConductInterview(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id } = req.params;
    let scheduleIndex = req.body?.schedule_id || req.body?.schedule_index;
    if (scheduleIndex === undefined || scheduleIndex === null || scheduleIndex === '') {
      return res.status(400).json({ message: "Invalid schedule slot" });
    }

    const panel = await InterviewPanel.findById(id);
    if (!panel) {
      return res.status(404).json({ message: "Interview panel not found" });
    }

    const slot = getScheduleSlot(panel, scheduleIndex);
    scheduleIndex=slotIndex(panel,scheduleIndex);
    if (!slot) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }
    if (String(slot.booking_status || "") !== "booked") {
      return res.status(400).json({ message: "This slot is not booked" });
    }

    if(!activeSlot(slot))throw interviewError(409,'This interview schedule is cancelled');
    const plainSlot = slotToPlain(slot);
    const panelistId = await evaluatorForRequest(req,panel);

    const schedules = [...panel.schedules];
    const currentStatus = String(plainSlot.interview_status || "not_started");
    if(panel.status==='inactive')throw interviewError(409,'This panel is inactive');
    if (currentStatus === "not_started") {
      schedules[scheduleIndex] = {
        ...plainSlot,
        interview_status: "in_progress",
        interview_started_at: new Date(),
        interview_started_by: panelistId || plainSlot.interview_started_by || null,
        required_panelist_ids: panel.members.map(m=>m.panelist_id),
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

    let evaluation = await findEvaluatorEvaluation({
      panelId: panel._id,
      scheduleIndex,
      scheduleId:slot._id,
      evaluatorKey: getEvaluatorKey(req, panelistId),
      panelistId,
      userId: getRequestUserId(req),
    });
    if (!evaluation) {
      if(currentStatus==='completed')throw interviewError(409,'This interview is complete. Open its results to review it.');
      evaluation = await InterviewEvaluation.create({
        panel_id: panel._id,
        schedule_index: scheduleIndex,
        schedule_id:slot._id,
        qualifier_id: qualifier?._id || null,
        panelist_id: panelistId,
        started_by_user_id: getRequestUserId(req) || null,
        evaluator_key: getEvaluatorKey(req, panelistId),
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
    res.status(error.status || 500).json({ message: error.message });
  }
});

/** GET /interview-panels/conduct/:id/:scheduleIndex */
export const getConductInterview = async (req, res) => {
  if (!canConductInterview(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id, scheduleIndex: scheduleIndexRaw } = req.params;
    let scheduleIndex = scheduleIndexRaw;
    if (scheduleIndex === undefined || scheduleIndex === null || scheduleIndex === '') {
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
    scheduleIndex=slotIndex(panel,scheduleIndex);
    if (!slot) {
      return res.status(404).json({ message: "Schedule slot not found" });
    }
    if (String(slot.booking_status || "") !== "booked") {
      return res.status(400).json({ message: "This slot is not booked" });
    }

    if(!activeSlot(slot))throw interviewError(409,'This interview schedule is cancelled');
    const plainSlot = slotToPlain(slot);
    const qualifier = await resolveQualifierByBooking({
      booked_qualifier_id: plainSlot.booked_qualifier_id,
      booked_phone: plainSlot.booked_phone,
      booked_for: plainSlot.booked_for,
      booked_user_id: plainSlot.booked_user_id,
    });

    const panelistId = await evaluatorForRequest(req,panel);

    const evaluation = await findEvaluatorEvaluation({
      panelId: panel._id,
      scheduleIndex,
      scheduleId:slot._id,
      evaluatorKey: getEvaluatorKey(req, panelistId),
      panelistId,
      userId: getRequestUserId(req),
    });

    res.status(200).json({
      panel,
      schedule_index: scheduleIndex,
      slot: plainSlot,
      qualifier: serializeQualifierForInterview(qualifier),
      evaluation,
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};

/** POST /interview-panels/submit-evaluation/:id */
export const submitInterviewEvaluation = interviewMutation(async (req, res) => {
  if (!canConductInterview(req)) {
    return res.status(403).json({ message: "Not allowed" });
  }
  try {
    const { id } = req.params;
    let scheduleIndex = req.body?.schedule_id || req.body?.schedule_index;
    if (scheduleIndex === undefined || scheduleIndex === null || scheduleIndex === '') {
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
    scheduleIndex=slotIndex(panel,scheduleIndex);
    if (!slot) {
      return res.status(400).json({ message: "Schedule slot not found" });
    }
    if (String(slot.booking_status || "") !== "booked") {
      return res.status(400).json({ message: "This slot is not booked" });
    }

    const panelistId = await evaluatorForRequest(req,panel);

    if(!activeSlot(slot))throw interviewError(409,'This interview schedule is cancelled');
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
      evaluator_key: getEvaluatorKey(req, panelistId),
      status: "completed",
      schedule_id:slot._id,
      completed_at: new Date(),
    };

    let evaluation = await findEvaluatorEvaluation({
      panelId: panel._id,
      scheduleIndex,
      scheduleId:slot._id,
      evaluatorKey: getEvaluatorKey(req, panelistId),
      panelistId,
      userId: getRequestUserId(req),
    });

    if (evaluation) {
      if(evaluation.status==='completed')throw interviewError(409,'Your submitted evaluation is already complete and cannot be overwritten');
      Object.assign(evaluation, evaluationPayload);
      await evaluation.save();
    } else {
      throw interviewError(409,'Start or continue your interview before submitting its evaluation');
    }

    const schedules = [...panel.schedules];
    schedules[scheduleIndex] = {
      ...plainSlot,
      interview_status: "in_progress",
      required_panelist_ids: plainSlot.required_panelist_ids?.length ? plainSlot.required_panelist_ids : panel.members.map(m=>m.panelist_id),
      interview_started_at:
        plainSlot.interview_started_at || evaluation.started_at || new Date(),
      interview_started_by:
        plainSlot.interview_started_by || panelistId || null,
    };
    panel.schedules = schedules;
    await finalizeInterviewProgress(panel,scheduleIndex);
    await panel.save();

    res.status(200).json({ evaluation, message: "Mock evaluation submitted" });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

/** GET /interview-panels/evaluation-details/:id/:scheduleIndex */
export const getInterviewEvaluationDetails = async (req, res) => {
  try {
    const { id, scheduleIndex: scheduleIndexRaw } = req.params;
    let scheduleIndex = scheduleIndexRaw;
    if (scheduleIndex === undefined || scheduleIndex === null || scheduleIndex === '') {
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
    scheduleIndex=slotIndex(panel,scheduleIndex);
    if (!slot) {
      return res.status(404).json({ message: "Schedule slot not found" });
    }

    if(!activeSlot(slot))throw interviewError(409,'This interview schedule is cancelled');
    const plainSlot = slotToPlain(slot);
    if (isQualifierRole(req) && !(req.access?.panelistId && panel.members.some(m=>String(m.panelist_id)===String(req.access.panelistId)))) {
      const qualifier = await resolveQualifierRecord(req);
      if (!qualifier || !isOwnQualifierBooking(plainSlot, qualifier)) {
        return res.status(403).json({ message: "Not allowed" });
      }
    }

    const qualifier = await resolveQualifierByBooking({
      booked_qualifier_id: plainSlot.booked_qualifier_id,
      booked_phone: plainSlot.booked_phone,
      booked_for: plainSlot.booked_for,
      booked_user_id: plainSlot.booked_user_id,
    });

    const evaluations = await InterviewEvaluation.find({
      panel_id: panel._id,
      ...evaluationSlotQuery(slot._id,scheduleIndex),
    })
      .populate("panelist_id", "name phone")
      .sort({ completed_at: 1, createdAt: 1 });

    const serialized = evaluations.map((item) =>
      serializeEvaluationForDetails(item, panel)
    );

    res.status(200).json({
      panel,
      schedule_index: scheduleIndex,
      slot: plainSlot,
      qualifier: serializeQualifierForInterview(qualifier),
      evaluations: serialized,
      averages: averageEvaluations(serialized),
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};
