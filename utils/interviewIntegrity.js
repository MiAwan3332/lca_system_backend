import mongoose from 'mongoose';
import Panelist from '../models/panelists.js';
import Panel from '../models/interviewPanel.js';
import Evaluation from '../models/interviewEvaluation.js';
import { accessContext } from './accessContext.js';
import { evaluateAccess } from './accessPolicy.js';
import { interviewError } from './interviewLock.js';
import { resolvePanelistRecord } from './panelistScope.js';

export const evaluationSlotQuery = (id,index) => id ? { $or: [{schedule_id:id},{schedule_id:{$exists:false},schedule_index:index},{schedule_id:null,schedule_index:index}] } : {schedule_index:index};
export async function evaluatorForRequest(req,panel) {
  const person=await resolvePanelistRecord(req);
  if(person?.is_active!==false && person && panel.members.some(m=>String(m.panelist_id)===String(person._id)))return person._id;
  const all=req.access?.owner || req.access?.grants.some(g=>g.permission===req.access.permission && g.scope==='all');
  if(!all || ['startInterview','submitInterviewEvaluation'].includes(req.access?.route?.handler))throw interviewError(403,'Only active assigned panelists can conduct or evaluate this interview');
  return null;
}

export function requireInterviewAction(req, permission) {
  if (req.access?.enforced && !evaluateAccess(req.access, permission, { ownerId: req.access.userId }).allowed) throw interviewError(403, `Missing permission: ${permission}`);
}
export const plainSlot = slot => slot?.toObject ? slot.toObject() : { ...slot };
export const activeSlot = slot => slot.interview_status !== 'cancelled';
export const panelMode = panel => panel.panel_type || (panel.members?.length === 1 ? 'solo' : 'team');
export function slotIndex(panel, reference) {
  if (mongoose.isValidObjectId(String(reference))) return panel.schedules.findIndex(s => String(s._id) === String(reference));
  const index = Number(reference);
  return Number.isInteger(index) && index >= 0 && index < panel.schedules.length ? index : -1;
}
export async function validatePanelMembers(members, mode) {
  const ids = (members || []).map(m => String(m.panelist_id || ''));
  if (!['solo', 'team'].includes(mode)) throw interviewError(400, 'Choose Solo or Team');
  if (mode === 'solo' && ids.length !== 1) throw interviewError(400, 'A Solo panel requires exactly one panelist');
  if (mode === 'team' && ids.length < 2) throw interviewError(400, 'A Team panel requires at least two panelists');
  if (new Set(ids).size !== ids.length || ids.some(id => !mongoose.isValidObjectId(id))) throw interviewError(400, 'Select distinct existing panelists');
  const people = await accessContext.run(undefined, async () => await Panelist.find({ _id: { $in: ids }, is_active: true }).select('_id user').lean());
  if (people.length !== ids.length || people.some(p => !p.user)) throw interviewError(400, 'Every panel member must be an active panelist with a linked login');
}
function validateTimes(slot) {
  const date = String(slot.date || ''), start = String(slot.start_time || slot.time || ''), end = String(slot.end_time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw interviewError(400, 'Each schedule requires a valid date');
  if (![start, end].every(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || end <= start) throw interviewError(400, 'Each schedule needs a valid start and end time, with end after start');
}
const changedTime = (a,b) => ['date','start_time','end_time','venue'].some(k => String(a[k] || '') !== String(b[k] || ''));

// Stable subdocument IDs are never replaced by client-generated row IDs or array positions.
export async function mergeInterviewSchedules(req, panel, rows, { append = false, creating = false } = {}) {
  if (!Array.isArray(rows)) throw interviewError(400, 'Schedules must be a list');
  const existing = (panel.schedules || []).map(plainSlot), seen = new Set();
  const next = append ? existing.map(s => ({...s})) : [];
  for (const [index,row] of rows.entries()) {
    if (!row) continue;
    const suppliedId = row._id || row.schedule_id;
    let old = suppliedId ? existing.find(s => String(s._id) === String(suppliedId)) : null;
    if(append && suppliedId)throw interviewError(400,'The add schedule action accepts new slots only');
    if (suppliedId && !old) throw interviewError(409, 'This schedule no longer exists. Refresh before editing.');
    // Older cached forms omitted IDs. Only accept unchanged slots in their original positions.
    if (!suppliedId && !append && !creating && existing[index] && !changedTime(existing[index], row)) old = existing[index];
    if (!old && !creating) requireInterviewAction(req, 'interview-panels.add.interview.schedules');
    const value = { ...(old || {}), _id: old?._id || new mongoose.Types.ObjectId(),
      date: String(row.date || '').trim(), start_time: String(row.start_time || row.time || '').trim(), end_time: String(row.end_time || '').trim(),
      venue: String(row.venue || '').trim(), notes: String(row.notes || '').trim() };
    const id = String(value._id);
    if (seen.has(id)) throw interviewError(400, 'The same schedule cannot be submitted twice');
    seen.add(id);
    if (!old) {
      if (row.booking_status === 'booked' || row.booked_qualifier_id || row.booked_user_id || row.interview_status && row.interview_status !== 'not_started') throw interviewError(400, 'Create an available slot, then book the candidate through the booking action');
      Object.assign(value, { booking_status: 'available', interview_status: 'not_started', required_panelist_ids: [] });
    } else {
      if (changedTime(old,value)) {
        requireInterviewAction(req, 'interview-panels.update.interview.schedules');
        if (old.interview_status !== 'not_started' || await accessContext.run(undefined, async()=>await Evaluation.exists({panel_id:panel._id,...evaluationSlotQuery(old._id,existing.indexOf(old))}))) throw interviewError(409, 'Started, evaluated or cancelled interviews cannot be rescheduled');
      }
      for (const key of ['booking_status','booked_for','booked_phone','booked_user_id','booked_qualifier_id','interview_status']) {
        if (Object.hasOwn(row,key) && String(row[key] || '') !== String(old[key] || '')) throw interviewError(409, 'Booking and interview progress must be changed through their dedicated actions');
      }
    }
    validateTimes(value); next.push(value);
  }
  if (!append) for (const old of existing.filter(s => !seen.has(String(s._id)))) {
    // Deleting/reordering an evaluated slot must never attach its evaluations to another candidate.
    if (old.booking_status === 'booked' || old.interview_status !== 'not_started' || await accessContext.run(undefined, async()=>await Evaluation.exists({panel_id:panel._id,...evaluationSlotQuery(old._id,existing.indexOf(old))}))) throw interviewError(409, 'Booked or evaluated slots must be retained. Use Cancel schedule instead of removing them.');
    requireInterviewAction(req, 'interview-panels.cancel.interview.schedule');
    next.push({...old,interview_status:'cancelled',cancelled_at:new Date(),cancelled_by:req.access?.userId,cancellation_reason:'Removed from schedule editor'});
  }
  // Preserve old positions for compatibility links; new slots always append.
  if (!creating) next.sort((a,b) => {
    const ai=existing.findIndex(s=>String(s._id)===String(a._id)),bi=existing.findIndex(s=>String(s._id)===String(b._id));
    return (ai<0?existing.length:ai)-(bi<0?existing.length:bi);
  });
  return next;
}
export async function assertInterviewConflicts(panel, slots, members = panel.members) {
  const ids = (members || []).map(m => String(m.panelist_id));
  const others = await accessContext.run(undefined, async () => await Panel.find({ _id: { $ne: panel._id }, status: { $nin: ['inactive','cancelled','completed'] }, 'members.panelist_id': { $in: ids } }).select('title schedules').lean());
  const proposed = slots.filter(activeSlot);
  for (const [i,slot] of proposed.entries()) {
    validateTimes(slot);
    const overlaps = s => activeSlot(s) && s.date === slot.date && s.start_time < slot.end_time && s.end_time > slot.start_time;
    if (proposed.slice(i+1).some(overlaps) || others.some(p => (p.schedules || []).some(overlaps))) throw interviewError(409, 'A panelist already has an overlapping interview schedule');
  }
}
export async function migrateEvaluationSlotLinks(panel) {
  for (const [index,slot] of panel.schedules.entries()) await accessContext.run(undefined, async () => await Evaluation.updateMany({panel_id:panel._id,schedule_index:index,$or:[{schedule_id:{$exists:false}},{schedule_id:null}]},{$set:{schedule_id:slot._id}}));
}
export async function finalizeInterviewProgress(panel, index) {
  const slot = panel.schedules[index], required = slot.required_panelist_ids?.length ? slot.required_panelist_ids : panel.members.map(m=>m.panelist_id);
  const completed = await accessContext.run(undefined, async () => await Evaluation.distinct('panelist_id',{panel_id:panel._id,schedule_id:slot._id,status:'completed'}));
  slot.required_panelist_ids = required;
  slot.interview_status = required.length && required.every(id=>completed.some(done=>String(done)===String(id))) ? 'completed' : 'in_progress';
}
