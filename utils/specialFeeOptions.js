/** Legacy fixed special-fee keys used by older batches/students. */
export const LEGACY_SPECIAL_FEE_LABELS = {
  test_session: "Test Session",
  optional_revision: "Optional Revision",
  compulsory_revision: "Compulsory Revision",
};

export const LEGACY_SPECIAL_FEE_KEYS = Object.keys(LEGACY_SPECIAL_FEE_LABELS);

/** Existing batches without this field are treated as paid. */
export const batchIsPaid = (batch) => batch?.is_paid_batch !== false;

const humanizeKey = (key) =>
  String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Option";

const slugifyLabel = (label, index = 0) => {
  const base = String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `option_${index + 1}`;
};

/**
 * Normalize batch.special_fee_options into:
 * [{ key, label, fee }, ...]
 *
 * Supports:
 * - new array format
 * - legacy object { test_session: 5000, ... }
 * - Map-like { key: { fee, label } }
 */
export const normalizeBatchSpecialFeeOptions = (raw) => {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const label = String(item.label || "").trim() || humanizeKey(item.key);
        const key =
          String(item.key || "").trim() || slugifyLabel(label, index);
        const fee = Number(item.fee) || 0;
        return { key, label, fee };
      })
      .filter(Boolean);
  }

  if (typeof raw !== "object") return [];

  return Object.entries(raw)
    .map(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const fee = Number(value.fee) || 0;
        const label =
          String(value.label || "").trim() ||
          LEGACY_SPECIAL_FEE_LABELS[key] ||
          humanizeKey(key);
        return { key, label, fee };
      }
      return {
        key,
        label: LEGACY_SPECIAL_FEE_LABELS[key] || humanizeKey(key),
        fee: Number(value) || 0,
      };
    })
    .filter((item) => item.key);
};

export const getBatchSpecialFeeByKey = (raw, key) => {
  const option = normalizeBatchSpecialFeeOptions(raw).find(
    (item) => item.key === key
  );
  return option ? Number(option.fee) || 0 : 0;
};

/**
 * Parse request body into normalized special fee options for a batch.
 * Accepts:
 * - body.special_fee_options as array or JSON string
 * - legacy body.test_session_fee / optional_revision_fee / compulsory_revision_fee
 */
export const parseBatchSpecialFees = (body, isSpecialBatch, isPaidBatch = true) => {
  if (!isSpecialBatch) {
    return { fees: [] };
  }

  let rawOptions = body.special_fee_options;
  if (typeof rawOptions === "string") {
    try {
      rawOptions = JSON.parse(rawOptions);
    } catch {
      return { error: "Invalid special fee options payload" };
    }
  }

  let options = normalizeBatchSpecialFeeOptions(rawOptions);

  // Legacy flat fee fields (older clients)
  if (!options.length) {
    options = LEGACY_SPECIAL_FEE_KEYS.map((key) => {
      const feeField = `${key}_fee`;
      const fee =
        Number(body[feeField] ?? body.special_fee_options?.[key]) || 0;
      return {
        key,
        label: LEGACY_SPECIAL_FEE_LABELS[key],
        fee,
      };
    });
  }

  // Ensure unique keys
  const usedKeys = new Set();
  options = options.map((item, index) => {
    let key = item.key || slugifyLabel(item.label, index);
    let unique = key;
    let n = 2;
    while (usedKeys.has(unique)) {
      unique = `${key}_${n}`;
      n += 1;
    }
    usedKeys.add(unique);
    return {
      key: unique,
      label: String(item.label || "").trim() || humanizeKey(unique),
      fee: Number(item.fee) || 0,
    };
  });

  const labeledOptions = options.filter((item) => String(item.label || "").trim());
  if (isPaidBatch === false) {
    return { fees: labeledOptions };
  }

  const positiveOptions = options.filter((item) => item.fee > 0);
  if (!positiveOptions.length) {
    return {
      error:
        "Special batch requires at least one option with a fee greater than 0",
    };
  }

  for (const item of positiveOptions) {
    if (!item.label) {
      return { error: "Each special option needs a name/label" };
    }
    if (!Number.isFinite(item.fee) || item.fee < 0) {
      return { error: `Invalid fee for "${item.label}"` };
    }
  }

  // Keep options with fee > 0 only (blank unused rows dropped)
  return { fees: positiveOptions };
};

/**
 * Parse student enrollment selections against a batch's special options.
 * Accepts:
 * - body.special_selected_options as JSON array of keys / comma-separated
 * - legacy special_test_session / special_optional_revision / special_compulsory_revision
 */
export const parseSpecialFeeOptionsFromBatch = (body, batchRecord) => {
  const batchOptions = normalizeBatchSpecialFeeOptions(
    batchRecord?.special_fee_options
  ).filter((item) => item.fee > 0);

  if (!batchOptions.length) {
    return {
      error: "This special batch has no option fees configured",
    };
  }

  let selectedKeys = [];
  let rawSelected = body.special_selected_options;
  if (typeof rawSelected === "string") {
    try {
      const parsed = JSON.parse(rawSelected);
      rawSelected = parsed;
    } catch {
      rawSelected = String(rawSelected)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (Array.isArray(rawSelected)) {
    selectedKeys = rawSelected.map(String).filter(Boolean);
  }

  // Legacy boolean flags
  for (const key of LEGACY_SPECIAL_FEE_KEYS) {
    const flag = body[`special_${key}`];
    if (
      flag === true ||
      flag === "true" ||
      flag === "1" ||
      flag === 1
    ) {
      if (!selectedKeys.includes(key)) selectedKeys.push(key);
    }
  }

  // Also accept special_option_<key>=true dynamic flags
  for (const option of batchOptions) {
    const flag = body[`special_option_${option.key}`];
    if (
      flag === true ||
      flag === "true" ||
      flag === "1" ||
      flag === 1
    ) {
      if (!selectedKeys.includes(option.key)) selectedKeys.push(option.key);
    }
  }

  selectedKeys = [...new Set(selectedKeys)];

  if (!selectedKeys.length) {
    return {
      error: "Select at least one special batch option",
    };
  }

  const optionsMap = {};
  let totalFee = 0;

  for (const option of batchOptions) {
    const selected = selectedKeys.includes(option.key);
    optionsMap[option.key] = {
      selected,
      fee: selected ? option.fee : 0,
      label: option.label,
    };
    if (selected) totalFee += option.fee;
  }

  for (const key of selectedKeys) {
    if (!optionsMap[key] || !optionsMap[key].selected) {
      return {
        error: `Selected option "${humanizeKey(key)}" is not available on this batch`,
      };
    }
  }

  return { options: optionsMap, totalFee };
};
