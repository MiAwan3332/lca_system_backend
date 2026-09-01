import { isEducationBackgroundComplete } from "./qualifierEducation.js";

const trim = (value) => String(value || "").trim();

export const getQualifierProfileIncompleteFields = (qualifier) => {
  if (!qualifier) {
    return ["Profile"];
  }

  const missing = [];
  if (!trim(qualifier.name)) missing.push("Name");
  if (!trim(qualifier.phone)) missing.push("Phone");
  if (!trim(qualifier.cnic)) missing.push("CNIC");
  if (!trim(qualifier.city)) missing.push("City");
  if (!trim(qualifier.father_name)) missing.push("Father Name");
  if (!trim(qualifier.father_phone)) missing.push("Father Phone");
  if (!trim(qualifier.description)) missing.push("Remarks");
  if (!trim(qualifier.latest_degree)) missing.push("Latest Degree");
  if (!isEducationBackgroundComplete(qualifier.education_background)) {
    missing.push("Education Background");
  }
  if (
    qualifier.no_of_attempts === undefined ||
    qualifier.no_of_attempts === null ||
    qualifier.no_of_attempts === ""
  ) {
    missing.push("No. of Attempts");
  }
  if (
    !Array.isArray(qualifier.optional_subjects) ||
    qualifier.optional_subjects.filter((s) => trim(s)).length === 0
  ) {
    missing.push("Optional Subjects");
  }
  if (!trim(qualifier.photo)) missing.push("Photo");

  return missing;
};

export const isQualifierProfileComplete = (qualifier) =>
  getQualifierProfileIncompleteFields(qualifier).length === 0;

export const QUALIFIER_PROFILE_INCOMPLETE_MESSAGE =
  "Please complete your My Profile (all required fields) before booking an interview.";
