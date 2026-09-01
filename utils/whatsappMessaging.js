import moment from "moment";
import WhatsAppTemplate from "../models/whatsappTemplate.js";
import {
  getOpenWaConfig,
  isOpenWaConfigured,
  openWaRequest,
} from "./openwaClient.js";

/** System processes that can auto-send a WhatsApp template. */
export const WHATSAPP_PROCESSES = [
  {
    key: "student_admission",
    label: "Student Admission",
    description: "Sent automatically when a new student is added.",
  },
  {
    key: "user_welcome",
    label: "User Welcome",
    description: "Sent automatically when a new staff/admin user is added.",
  },
  {
    key: "panelist_welcome",
    label: "Panelist Welcome",
    description: "Sent automatically when a new panelist is added.",
  },
  {
    key: "qualifier_welcome",
    label: "Qualifier Welcome",
    description:
      "Sent automatically when a new qualifier is added (includes payment details).",
  },
  {
    key: "fee_payment",
    label: "Fee Payment",
    description: "Sent automatically when a fee payment is recorded.",
  },
  {
    key: "fee_reminder",
    label: "Fee Reminder",
    description: "For pending fee reminders (use when sending reminders).",
  },
  {
    key: "custom",
    label: "Custom (manual)",
    description: "Not sent automatically — for tests or future use.",
  },
];

export const WHATSAPP_PROCESS_KEYS = WHATSAPP_PROCESSES.map((p) => p.key);

/** Tags available in LCA WhatsApp message templates. */
export const WHATSAPP_TEMPLATE_TAGS = [
  { tag: "{{name}}", label: "Name", sample: "Ali Khan" },
  { tag: "{{email}}", label: "Email", sample: "ali@example.com" },
  { tag: "{{role}}", label: "User role", sample: "Principal" },
  { tag: "{{phone}}", label: "Phone", sample: "03001234567" },
  { tag: "{{description}}", label: "Description / remarks", sample: "Senior interviewer" },
  { tag: "{{status}}", label: "Active / Inactive", sample: "Active" },
  { tag: "{{cnic}}", label: "CNIC", sample: "35202-1234567-1" },
  { tag: "{{roll_number}}", label: "Roll number", sample: "CSS-001" },
  { tag: "{{batch}}", label: "Batch name", sample: "CSS Morning 2026" },
  { tag: "{{class_time}}", label: "Class time", sample: "9:00 AM – 1:00 PM" },
  { tag: "{{admission_date}}", label: "Admission date", sample: "30 Aug 2026" },
  { tag: "{{total_fee}}", label: "Total fee (after discount)", sample: "50,000" },
  { tag: "{{discount}}", label: "Discount amount", sample: "5,000" },
  { tag: "{{paid_fee}}", label: "Paid fee (total)", sample: "20,000" },
  { tag: "{{pending_fee}}", label: "Remaining fee", sample: "30,000" },
  { tag: "{{amount_received}}", label: "Amount just received", sample: "10,000" },
  { tag: "{{payment_method}}", label: "Payment method", sample: "Cash" },
  { tag: "{{password}}", label: "Portal password", sample: "lca@123456" },
  { tag: "{{portal_url}}", label: "Portal URL", sample: "https://lca-portal.com" },
  { tag: "{{academy_name}}", label: "Academy name", sample: "Lahore CSS Academy" },
];

export const STUDENT_WELCOME_TEMPLATE_KEY = "student_welcome";
export const USER_WELCOME_TEMPLATE_KEY = "user_welcome";
export const PANELIST_WELCOME_TEMPLATE_KEY = "panelist_welcome";
export const QUALIFIER_WELCOME_TEMPLATE_KEY = "qualifier_welcome";
export const FEE_PAYMENT_TEMPLATE_KEY = "fee_payment_receipt";
export const FEE_REMINDER_TEMPLATE_KEY = "fee_reminder";

export const DEFAULT_STUDENT_WELCOME_BODY = `Assalam o Alaikum {{name}}!

Welcome to {{academy_name}}.

Your admission is confirmed. Please keep these details:

• Roll No: {{roll_number}}
• Batch: {{batch}}
• Class Time: {{class_time}}
• CNIC: {{cnic}}
• Phone: {{phone}}
• Admission Date: {{admission_date}}

Fee summary:
• Total Fee: Rs. {{total_fee}}
• Amount Paid: Rs. {{paid_fee}}
• Remaining: Rs. {{pending_fee}}
• Payment Method: {{payment_method}}

Portal login:
• Login: your phone number ({{phone}})
• Temporary Password: {{password}}
• Portal: {{portal_url}}

Please change your password after first login.
If you have any questions, reply to this WhatsApp message.

— {{academy_name}}`;

export const DEFAULT_USER_WELCOME_BODY = `Assalam o Alaikum {{name}}!

Welcome to {{academy_name}} Portal.

Your staff account has been created:

• Name: {{name}}
• Email: {{email}}
• Role: {{role}}
• Phone: {{phone}}

Portal login:
• Login: {{email}}
• Temporary Password: {{password}}
• Portal: {{portal_url}}

Please change your password after first login.
If you need help, reply to this WhatsApp message.

— {{academy_name}}`;

export const DEFAULT_PANELIST_WELCOME_BODY = `Assalam o Alaikum {{name}}!

Welcome to {{academy_name}}.

You have been added as an interview panelist.

Your details:
• Name: {{name}}
• Phone: {{phone}}
• Status: {{status}}
• About: {{description}}

We look forward to working with you.
If you have any questions, reply to this WhatsApp message.

— {{academy_name}}`;

export const DEFAULT_QUALIFIER_WELCOME_BODY = `Assalam o Alaikum {{name}}!

Welcome to {{academy_name}}.

You have been registered as a qualifier for interview.

Your details:
• Name: {{name}}
• Phone: {{phone}}
• CNIC: {{cnic}}
• Interview Batch: {{batch}}
• Remarks: {{description}}

Payment details:
• Amount Received: Rs. {{amount_received}}
• Payment Method: {{payment_method}}
• Batch Fee: Rs. {{batch_fee}}
• Discount: Rs. {{discount}}
• Payable Fee: Rs. {{total_fee}}
• Total Paid: Rs. {{paid_fee}}
• Remaining: Rs. {{pending_fee}}

We will contact you with further instructions.
If you have any questions, reply to this WhatsApp message.

— {{academy_name}}`;

export const DEFAULT_FEE_PAYMENT_BODY = `Assalam o Alaikum {{name}}!

We have received your fee payment at {{academy_name}}.

Payment details:
• Amount Received: Rs. {{amount_received}}
• Payment Method: {{payment_method}}
• Batch: {{batch}}
• Roll No: {{roll_number}}

Fee summary:
• Total Fee: Rs. {{total_fee}}
• Total Paid: Rs. {{paid_fee}}
• Remaining: Rs. {{pending_fee}}

Thank you.
— {{academy_name}}`;

export const DEFAULT_FEE_REMINDER_BODY = `Assalam o Alaikum {{name}}!

This is a friendly reminder from {{academy_name}}.

You have a pending fee balance:
• Batch: {{batch}}
• Roll No: {{roll_number}}
• Remaining: Rs. {{pending_fee}}
• Total Fee: Rs. {{total_fee}}
• Paid so far: Rs. {{paid_fee}}

Please clear your dues at your earliest convenience.
— {{academy_name}}`;

const formatTime12Hour = (value) => {
  if (value == null || value === "") return "";
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return raw;

  let hours = Number(match[1]);
  const minutes = match[2];
  if (!Number.isFinite(hours) || hours < 0 || hours > 23) return raw;

  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
};

export const formatClassTimeRange = (startTime, endTime) => {
  const start = formatTime12Hour(startTime);
  const end = formatTime12Hour(endTime);
  if (start && end) return `${start} – ${end}`;
  return start || end || "";
};

export const formatCurrencyPlain = (value) =>
  Number(value || 0).toLocaleString("en-PK", { maximumFractionDigits: 0 });

export const slugifyTemplateKey = (value) => {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || `template_${Date.now()}`;
};

/** Convert local / intl phone to WhatsApp chat id digits (e.g. 92300...). */
export const toWhatsAppNumber = (phone) => {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) digits = digits.slice(2);

  // 92 0 3XXXXXXXXX — country code kept with the local leading 0
  if (digits.startsWith("920") && digits.length === 13) {
    digits = `92${digits.slice(3)}`;
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    digits = `92${digits.slice(1)}`;
  }

  if (digits.length === 10 && digits.startsWith("3")) {
    digits = `92${digits}`;
  }

  return digits;
};

export const toWhatsAppChatId = (phone) => {
  const number = toWhatsAppNumber(phone);
  if (!number || number.length < 10) return null;
  return `${number}@c.us`;
};

export const renderWhatsAppTemplate = (body, vars = {}) => {
  let output = String(body || "");
  Object.entries(vars).forEach(([key, value]) => {
    const safe = value == null || value === "" ? "N/A" : String(value);
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
    output = output.replace(pattern, safe);
  });
  return output.trim();
};

export const buildStudentTemplateVars = ({
  student,
  batch,
  password = "lca@123456",
  paymentMethod = "",
  amountReceived = null,
} = {}) => {
  const portalUrl = (
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    "https://lca-portal.com"
  ).replace(/\/$/, "");

  const classTime = formatClassTimeRange(
    batch?.class_start_time,
    batch?.class_end_time
  );

  const received =
    amountReceived != null
      ? formatCurrencyPlain(amountReceived)
      : formatCurrencyPlain(student?.paid_fee);

  return {
    name: student?.name || "",
    phone: student?.phone || "",
    cnic: student?.cnic || "",
    roll_number: student?.roll_number || "",
    batch: batch?.name || "N/A",
    class_time: classTime || "N/A",
    admission_date: (() => {
      const raw = student?.admission_date;
      if (!raw) return moment().format("DD MMM YYYY");
      const parsed = moment(
        raw instanceof Date || typeof raw === "number"
          ? raw
          : String(raw)
      );
      return parsed.isValid()
        ? parsed.format("DD MMM YYYY")
        : moment().format("DD MMM YYYY");
    })(),
    total_fee: formatCurrencyPlain(student?.total_fee),
    paid_fee: formatCurrencyPlain(student?.paid_fee),
    pending_fee: formatCurrencyPlain(student?.pending_fee),
    amount_received: received,
    payment_method:
      paymentMethod ||
      (Number(student?.paid_fee) > 0 ? "Paid" : "Pay Later"),
    password,
    portal_url: portalUrl,
    academy_name: "Lahore CSS Academy",
  };
};

/** @deprecated use buildStudentTemplateVars */
export const buildStudentWelcomeVars = buildStudentTemplateVars;

export const buildUserTemplateVars = ({ user, password = "lcaadmin@123456" } = {}) => {
  const portalUrl = (
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    "https://lca-portal.com"
  ).replace(/\/$/, "");

  return {
    name: user?.name || "",
    email: user?.email || "",
    phone: user?.phone || "",
    role: user?.role || "",
    password,
    portal_url: portalUrl,
    academy_name: "Lahore CSS Academy",
  };
};

export const buildPanelistTemplateVars = ({ panelist } = {}) => {
  const portalUrl = (
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    "https://lca-portal.com"
  ).replace(/\/$/, "");

  const isActive = panelist?.is_active !== false;

  return {
    name: panelist?.name || "",
    phone: panelist?.phone || "",
    description: panelist?.description || "",
    status: isActive ? "Active" : "Inactive",
    role: "Panelist",
    portal_url: portalUrl,
    academy_name: "Lahore CSS Academy",
  };
};

export const buildQualifierTemplateVars = ({
  qualifier,
  batch,
  paymentMethod = "",
  amountReceived = null,
} = {}) => {
  const portalUrl = (
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    "https://lca-portal.com"
  ).replace(/\/$/, "");

  const isActive = qualifier?.is_active !== false;
  const batchName =
    batch?.name ||
    (typeof qualifier?.batch === "object" && qualifier?.batch?.name) ||
    "";

  const paid = Number(qualifier?.paid_fee) || 0;
  const discount = Number(qualifier?.discount_amount) || 0;
  const netFee = Number(qualifier?.total_fee) || 0;
  const batchFeeValue =
    Number(batch?.batch_fee) ||
    (typeof qualifier?.batch === "object" &&
      Number(qualifier?.batch?.batch_fee)) ||
    netFee + discount;
  const received =
    amountReceived != null
      ? formatCurrencyPlain(amountReceived)
      : formatCurrencyPlain(paid);

  return {
    name: qualifier?.name || "",
    phone: qualifier?.phone || "",
    cnic: qualifier?.cnic || "",
    email: qualifier?.email || "",
    city: qualifier?.city || "",
    description: qualifier?.description || "",
    batch: batchName,
    status: isActive ? "Active" : "Inactive",
    role: "Qualifier",
    batch_fee: formatCurrencyPlain(batchFeeValue),
    discount: formatCurrencyPlain(discount),
    total_fee: formatCurrencyPlain(netFee),
    paid_fee: formatCurrencyPlain(paid),
    pending_fee: formatCurrencyPlain(qualifier?.pending_fee),
    amount_received: received,
    payment_method:
      paymentMethod ||
      qualifier?.payment_method ||
      (paid > 0 ? "Paid" : "Pay Later"),
    portal_url: portalUrl,
    academy_name: "Lahore CSS Academy",
  };
};

const SESSION_READY_STATUSES = new Set([
  "ready",
  "connected",
  "authenticated",
]);

const normalizeSessions = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  if (Array.isArray(payload?.data?.sessions)) return payload.data.sessions;
  if (Array.isArray(payload?.result)) return payload.result;
  if (payload && typeof payload === "object" && (payload.id || payload._id)) {
    return [payload];
  }
  return [];
};

const isSessionReady = (session) => {
  const status = String(session?.status || "").toLowerCase();
  if (!SESSION_READY_STATUSES.has(status)) return false;
  if (session?.engineLoaded === false) return false;
  return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const findReadyWhatsAppSession = async () => {
  if (!isOpenWaConfigured()) return null;

  const { defaultSessionName } = getOpenWaConfig();
  const payload = await openWaRequest("GET", "/api/sessions");
  const sessions = normalizeSessions(payload);
  const ready = sessions.filter(isSessionReady);
  if (!ready.length) return null;

  const preferred =
    ready.find((s) => String(s.name || "") === defaultSessionName) || ready[0];
  return preferred;
};

const DEFAULT_TEMPLATES = [
  {
    key: STUDENT_WELCOME_TEMPLATE_KEY,
    name: "Student Welcome",
    process: "student_admission",
    description: "Sent automatically when a new student is added.",
    body: DEFAULT_STUDENT_WELCOME_BODY,
  },
  {
    key: USER_WELCOME_TEMPLATE_KEY,
    name: "User Welcome",
    process: "user_welcome",
    description: "Sent automatically when a new staff/admin user is added.",
    body: DEFAULT_USER_WELCOME_BODY,
  },
  {
    key: PANELIST_WELCOME_TEMPLATE_KEY,
    name: "Panelist Welcome",
    process: "panelist_welcome",
    description: "Sent automatically when a new panelist is added.",
    body: DEFAULT_PANELIST_WELCOME_BODY,
  },
  {
    key: QUALIFIER_WELCOME_TEMPLATE_KEY,
    name: "Qualifier Welcome",
    process: "qualifier_welcome",
    description:
      "Sent automatically when a new qualifier is added (includes payment details).",
    body: DEFAULT_QUALIFIER_WELCOME_BODY,
  },
  {
    key: FEE_PAYMENT_TEMPLATE_KEY,
    name: "Fee Payment Receipt",
    process: "fee_payment",
    description: "Sent automatically when a fee payment is recorded.",
    body: DEFAULT_FEE_PAYMENT_BODY,
  },
  {
    key: FEE_REMINDER_TEMPLATE_KEY,
    name: "Fee Reminder",
    process: "fee_reminder",
    description: "Use for pending fee reminder messages.",
    body: DEFAULT_FEE_REMINDER_BODY,
  },
];

const PROCESS_DEFAULT_KEYS = {
  student_admission: STUDENT_WELCOME_TEMPLATE_KEY,
  user_welcome: USER_WELCOME_TEMPLATE_KEY,
  panelist_welcome: PANELIST_WELCOME_TEMPLATE_KEY,
  qualifier_welcome: QUALIFIER_WELCOME_TEMPLATE_KEY,
  fee_payment: FEE_PAYMENT_TEMPLATE_KEY,
  fee_reminder: FEE_REMINDER_TEMPLATE_KEY,
};

export const ensureDefaultWhatsAppTemplates = async () => {
  const results = [];
  for (const def of DEFAULT_TEMPLATES) {
    let existing = await WhatsAppTemplate.findOne({ key: def.key });
    if (!existing) {
      existing = await WhatsAppTemplate.create({
        ...def,
        is_active: true,
      });
    } else {
      let dirty = false;
      if (existing.process !== def.process) {
        existing.process = def.process;
        dirty = true;
      }
      // Refresh Qualifier Welcome so payment/discount tags are included
      if (
        def.key === QUALIFIER_WELCOME_TEMPLATE_KEY &&
        (!String(existing.body || "").includes("{{total_fee}}") ||
          !String(existing.body || "").includes("{{discount}}"))
      ) {
        existing.body = def.body;
        existing.description = def.description;
        dirty = true;
      }
      if (dirty) await existing.save();
    }
    results.push(existing);
  }

  return results;
};

/** Active template bound to a process (most recently updated wins). */
export const getActiveTemplateForProcess = async (processKey) => {
  await ensureDefaultWhatsAppTemplates();
  const process = String(processKey || "").trim();
  if (!process || process === "custom") return null;

  const active = await WhatsAppTemplate.findOne({
    process,
    is_active: true,
  })
    .sort({ updatedAt: -1 })
    .exec();
  if (active) return active;

  const defaultKey = PROCESS_DEFAULT_KEYS[process];
  if (!defaultKey) return null;

  return WhatsAppTemplate.findOne({ key: defaultKey }).exec();
};

const WHATSAPP_CHUNK_SIZE = 4000;

const splitWhatsAppMessage = (text) => {
  const message = String(text || "");
  if (message.length <= WHATSAPP_CHUNK_SIZE) return [message];

  const chunks = [];
  let remaining = message;
  while (remaining.length > WHATSAPP_CHUNK_SIZE) {
    let cut = remaining.lastIndexOf("\n", WHATSAPP_CHUNK_SIZE);
    if (cut < WHATSAPP_CHUNK_SIZE * 0.6) {
      cut = remaining.lastIndexOf(" ", WHATSAPP_CHUNK_SIZE);
    }
    if (cut < WHATSAPP_CHUNK_SIZE * 0.6) {
      cut = WHATSAPP_CHUNK_SIZE;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
};

const isOpenWaPacingLimit = (error) => {
  const code = error?.data?.code || error?.data?.error?.code;
  const message = String(error?.message || error?.data?.message || "");
  return (
    error?.status === 429 &&
    (code === "SEND_PACING_LIMITED" ||
      /daily send allowance|send pacing/i.test(message))
  );
};

const openWaPacingMessage =
  "WhatsApp gateway send pacing is enabled on OpenWA (default 20 messages on day 1). LCA does not set this limit. On the OpenWA server set SEND_PACING_ENABLED=false and restart, or raise SEND_PACING_WARMUP_SCHEDULE.";

const sendTextWithRetry = async (sessionId, chatId, text) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await openWaRequest(
        "POST",
        `/api/sessions/${sessionId}/messages/send-text`,
        {
          body: { chatId, text },
          timeoutMs: 45000,
        }
      );
    } catch (error) {
      lastError = error;
      if (isOpenWaPacingLimit(error)) throw error;
      const retryable = [409, 429, 504].includes(error.status);
      if (!retryable || attempt === 3) throw error;
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
};

export const sendWhatsAppText = async ({ phone, text, sessionId } = {}) => {
  if (!isOpenWaConfigured()) {
    return { sent: false, skipped: true, reason: "OpenWA is not configured" };
  }

  const chatId = toWhatsAppChatId(phone);
  if (!chatId) {
    return {
      sent: false,
      skipped: true,
      reason: "Invalid contact number for WhatsApp",
    };
  }

  const message = String(text || "").trim();
  if (!message) {
    return { sent: false, skipped: true, reason: "Message body is empty" };
  }

  let session = null;
  if (sessionId) {
    session = await openWaRequest("GET", `/api/sessions/${sessionId}`);
  } else {
    session = await findReadyWhatsAppSession();
  }

  const id = session?.id || session?._id;
  if (!id || !isSessionReady(session)) {
    return {
      sent: false,
      skipped: true,
      reason: "No ready WhatsApp session. Connect WhatsApp first.",
    };
  }

  const chunks = splitWhatsAppMessage(message);
  try {
    const results = [];
    for (const chunk of chunks) {
      const result = await sendTextWithRetry(id, chatId, chunk);
      results.push(result);
    }

    return {
      sent: true,
      chatId,
      sessionId: id,
      sessionName: session?.name || "",
      parts: chunks.length,
      result: results[results.length - 1],
    };
  } catch (error) {
    if (isOpenWaPacingLimit(error)) {
      return {
        sent: false,
        skipped: true,
        reason: openWaPacingMessage,
      };
    }
    throw error;
  }
};

/** Render + send the active template for a process. Never throws. */
export const sendWhatsAppForProcess = async ({
  process,
  phone,
  vars = {},
} = {}) => {
  try {
    const processKey = String(process || "").trim();
    if (!processKey || processKey === "custom") {
      return {
        sent: false,
        skipped: true,
        reason: "Custom templates are not sent automatically",
      };
    }

    const template = await getActiveTemplateForProcess(processKey);
    const fallback = DEFAULT_TEMPLATES.find((item) => item.process === processKey);
    const body = template?.body || fallback?.body;
    if (!body) {
      return {
        sent: false,
        skipped: true,
        reason: `No active WhatsApp template for process "${processKey}"`,
      };
    }

    const text = renderWhatsAppTemplate(body, vars);
    const outcome = await sendWhatsAppText({ phone, text });

    return {
      ...outcome,
      process: processKey,
      template_key: template?.key || fallback?.key,
      template_name: template?.name || fallback?.name,
      preview: text.slice(0, 180),
    };
  } catch (error) {
    console.error(`WhatsApp process "${process}" failed:`, error.message);
    return {
      sent: false,
      process,
      error: error.message || "Failed to send WhatsApp message",
    };
  }
};

export const sendStudentWelcomeWhatsApp = async ({
  student,
  batch,
  password,
  paymentMethod,
} = {}) => {
  const vars = buildStudentTemplateVars({
    student,
    batch,
    password,
    paymentMethod,
    amountReceived: student?.paid_fee,
  });
  return sendWhatsAppForProcess({
    process: "student_admission",
    phone: student?.phone,
    vars,
  });
};

export const sendUserWelcomeWhatsApp = async ({ user, password } = {}) => {
  const vars = buildUserTemplateVars({ user, password });
  return sendWhatsAppForProcess({
    process: "user_welcome",
    phone: user?.phone,
    vars,
  });
};

export const sendPanelistWelcomeWhatsApp = async ({ panelist } = {}) => {
  const vars = buildPanelistTemplateVars({ panelist });
  return sendWhatsAppForProcess({
    process: "panelist_welcome",
    phone: panelist?.phone,
    vars,
  });
};

export const sendQualifierWelcomeWhatsApp = async ({
  qualifier,
  batch,
  paymentMethod,
  amountReceived,
} = {}) => {
  const vars = buildQualifierTemplateVars({
    qualifier,
    batch,
    paymentMethod,
    amountReceived,
  });
  return sendWhatsAppForProcess({
    process: "qualifier_welcome",
    phone: qualifier?.phone,
    vars,
  });
};

export const sendFeePaymentWhatsApp = async ({
  student,
  batch,
  paymentMethod,
  amountReceived,
} = {}) => {
  const vars = buildStudentTemplateVars({
    student,
    batch,
    paymentMethod,
    amountReceived,
  });
  return sendWhatsAppForProcess({
    process: "fee_payment",
    phone: student?.phone,
    vars,
  });
};

export default {
  WHATSAPP_PROCESSES,
  WHATSAPP_TEMPLATE_TAGS,
  STUDENT_WELCOME_TEMPLATE_KEY,
  USER_WELCOME_TEMPLATE_KEY,
  PANELIST_WELCOME_TEMPLATE_KEY,
  QUALIFIER_WELCOME_TEMPLATE_KEY,
  ensureDefaultWhatsAppTemplates,
  getActiveTemplateForProcess,
  renderWhatsAppTemplate,
  buildStudentTemplateVars,
  buildUserTemplateVars,
  buildPanelistTemplateVars,
  buildQualifierTemplateVars,
  sendWhatsAppForProcess,
  sendStudentWelcomeWhatsApp,
  sendUserWelcomeWhatsApp,
  sendPanelistWelcomeWhatsApp,
  sendQualifierWelcomeWhatsApp,
  sendFeePaymentWhatsApp,
  sendWhatsAppText,
  slugifyTemplateKey,
};
