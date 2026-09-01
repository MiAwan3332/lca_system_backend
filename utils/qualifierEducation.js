export const QUALIFICATION_OPTIONS = [
  "Matric / O-Level",
  "Intermediate / A-Level",
  "Bachelor's Degree",
  "Master's Degree",
  "MPhil / MS",
  "Other",
];

const trim = (value) => String(value || "").trim();

export const normalizeEducationEntry = (entry = {}) => ({
  qualification: trim(entry.qualification),
  institution: trim(entry.institution),
  board_or_university: trim(entry.board_or_university),
  year: trim(entry.year),
  grade: trim(entry.grade),
  details: trim(entry.details),
});

export const educationEntryHasContent = (entry) => {
  const normalized = normalizeEducationEntry(entry);
  return Object.values(normalized).some(Boolean);
};

export const educationEntryIsComplete = (entry) => {
  const normalized = normalizeEducationEntry(entry);
  return Boolean(normalized.qualification && normalized.institution);
};

export const normalizeEducationBackground = (value) => {
  if (Array.isArray(value)) {
    return value
      .map(normalizeEducationEntry)
      .filter(educationEntryHasContent);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return normalizeEducationBackground(parsed);
      }
    } catch {
      // legacy plain text
    }
    return [
      normalizeEducationEntry({
        qualification: "Other",
        institution: "",
        details: text,
      }),
    ];
  }
  return [];
};

export const parseEducationBackgroundPayload = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return normalizeEducationBackground(JSON.parse(trimmed));
    } catch {
      return normalizeEducationBackground(trimmed);
    }
  }
  return normalizeEducationBackground(value);
};

export const isEducationBackgroundComplete = (value) => {
  const entries = normalizeEducationBackground(value);
  if (entries.length === 0) return false;
  return entries.every(educationEntryIsComplete);
};

export const getEducationBackgroundValidationError = (value) => {
  const entries = normalizeEducationBackground(value);
  if (entries.length === 0) {
    return "Add at least one qualification in Education Background";
  }
  for (const entry of entries) {
    if (!educationEntryHasContent(entry)) continue;
    if (!trim(entry.qualification)) {
      return "Each education section requires a qualification level";
    }
    if (!trim(entry.institution)) {
      return "Each education section requires an institution";
    }
  }
  const completeEntries = entries.filter(educationEntryIsComplete);
  if (completeEntries.length === 0) {
    return "Add at least one complete qualification (level + institution)";
  }
  return null;
};

/** Full qualifier payload for interview conduct UI (panelists). */
export const serializeQualifierForInterview = (qualifier) => {
  if (!qualifier) return null;
  const plain = qualifier.toObject
    ? qualifier.toObject({ virtuals: true })
    : { ...qualifier };
  const batch =
    plain.batch && typeof plain.batch === "object"
      ? {
          _id: plain.batch._id,
          name: plain.batch.name || "",
          is_interview_batch: plain.batch.is_interview_batch,
          is_active: plain.batch.is_active,
          batch_fee: plain.batch.batch_fee,
        }
      : plain.batch || null;

  return {
    _id: plain._id,
    name: plain.name || "",
    phone: plain.phone || "",
    email: plain.email || "",
    cnic: plain.cnic || "",
    city: plain.city || "",
    father_name: plain.father_name || "",
    father_phone: plain.father_phone || "",
    description: plain.description || "",
    photo: plain.photo || "",
    optional_subjects: Array.isArray(plain.optional_subjects)
      ? plain.optional_subjects.filter(Boolean)
      : [],
    no_of_attempts:
      plain.no_of_attempts != null ? Number(plain.no_of_attempts) : 0,
    latest_degree: plain.latest_degree || "",
    education_background: normalizeEducationBackground(
      plain.education_background
    ),
    batch,
    is_active: plain.is_active !== false,
  };
};
