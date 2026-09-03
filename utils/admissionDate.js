import Student from "../models/students.js";

/**
 * `admission_date` is a String field, so range queries are plain lexicographic
 * comparisons. That only works when every stored value starts with an
 * `YYYY-MM-DD` day key, which is what these helpers guarantee.
 */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/** Extract the `YYYY-MM-DD` part of any date-ish value. */
export const toAdmissionDayKey = (value) => {
  if (!value && value !== 0) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  if (!raw) return "";

  const matched = raw.match(DAY_KEY_PATTERN);
  if (matched) return matched[0];

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
};

/** Convert any incoming value into a sortable stored representation. */
export const normalizeAdmissionDate = (value) => {
  if (!value && value !== 0) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }

  const raw = String(value).trim();
  if (!raw) return "";
  if (DAY_KEY_PATTERN.test(raw)) return raw;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};

/**
 * Build an inclusive `admission_date` range. The lower bound stays a bare day
 * key and the upper bound reaches the end of the day so that both
 * `2026-09-03` and `2026-09-03T13:38:20.000Z` fall inside the range.
 */
export const buildAdmissionDateFilter = (startDate, endDate) => {
  const start = toAdmissionDayKey(startDate);
  const end = toAdmissionDayKey(endDate);
  if (!start && !end) return null;

  const range = {};
  if (start) range.$gte = start;
  if (end) range.$lte = `${end}T23:59:59.999Z`;
  return range;
};

/** Apply the range onto a query object, when either bound is present. */
export const applyAdmissionDateFilter = (filter, startDate, endDate) => {
  const range = buildAdmissionDateFilter(startDate, endDate);
  if (range) filter.admission_date = range;
  return filter;
};

/**
 * Older records stored `new Date()` directly, which Mongoose cast to
 * `"Thu Sep 03 2026 18:38:20 GMT+0500 (...)"`. Those never match a day-key
 * range, so rewrite them once.
 */
export const normalizeStoredAdmissionDates = async () => {
  const legacy = await Student.find({
    admission_date: { $nin: [null, ""], $not: DAY_KEY_PATTERN },
  }).select("_id admission_date");

  let updated = 0;
  for (const student of legacy) {
    const normalized = normalizeAdmissionDate(student.admission_date);
    if (!normalized || normalized === student.admission_date) continue;

    await Student.updateOne(
      { _id: student._id },
      { $set: { admission_date: normalized } }
    );
    updated += 1;
  }

  return updated;
};
