/** Official provinces and territories of Pakistan. */
export const PAKISTAN_PROVINCES = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Gilgit-Baltistan",
  "Azad Jammu and Kashmir",
  "Islamabad Capital Territory",
];

export const isPakistanProvince = (value) =>
  PAKISTAN_PROVINCES.includes(String(value || "").trim());
