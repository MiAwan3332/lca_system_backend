/** Canonical fee payment methods for LCA fee collection. */
export const FEE_PAYMENT_METHODS = [
  "Cash",
  "Bank Transfer",
  "Online Payment",
  "Cheque",
];

/** Legacy value stored in older FeeLog rows. */
export const LEGACY_ONLINE_METHOD = "Online";

export const FEE_PAYMENT_METHOD_ENUM = [
  ...FEE_PAYMENT_METHODS,
  LEGACY_ONLINE_METHOD,
];

export const isOnlinePaymentMethod = (method) =>
  method === "Online Payment" || method === LEGACY_ONLINE_METHOD;

export const requiresPaymentEvidence = (method) =>
  isOnlinePaymentMethod(method);

export const isValidFeePaymentMethod = (method) =>
  FEE_PAYMENT_METHOD_ENUM.includes(method);
