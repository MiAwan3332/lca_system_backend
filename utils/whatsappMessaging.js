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
  { tag: "{{name}}", label: "Student name", sample: "Ali Khan" },
  { tag: "{{phone}}", label: "Phone", sample: "03001234567" },
  { tag: "{{cnic}}", label: "CNIC", sample: "35202-1234567-1" },
  { tag: "{{roll_number}}", label: "Roll number", sample: "CSS-001" },
  { tag: "{{batch}}", label: "Batch name", sample: "CSS Morning 2026" },
  { tag: "{{class_time}}", label: "Class time", sample: "9:00 AM – 1:00 PM" },
  { tag: "{{admission_date}}", label: "Admission date", sample: "30 Aug 2026" },
  { tag: "{{total_fee}}", label: "Total fee", sample: "50,000" },
  { tag: "{{paid_fee}}", label: "Paid fee (total)", sample: "20,000" },
  { tag: "{{pending_fee}}", label: "Remaining fee", sample: "30,000" },
  { tag: "{{amount_received}}", label: "Amount just received", sample: "10,000" },
  { tag: "{{payment_method}}", label: "Payment method", sample: "Cash" },
  { tag: "{{password}}", label: "Portal password", sample: "lca@123456" },
  { tag: "{{portal_url}}", label: "Portal URL", sample: "https://lca-portal.com" },
  { tag: "{{academy_name}}", label: "Academy name", sample: "Lahore CSS Academy" },
];

export const STUDENT_WELCOME_TEMPLATE_KEY = "student_welcome";
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

const normalizeSessions = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  return [];
};

export const findReadyWhatsAppSession = async () => {
  if (!isOpenWaConfigured()) return null;

  const { defaultSessionName } = getOpenWaConfig();
  const payload = await openWaRequest("GET", "/api/sessions");
  const sessions = normalizeSessions(payload);
  const ready = sessions.filter(
    (s) => String(s?.status || "").toLowerCase() === "ready"
  );
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

export const ensureDefaultWhatsAppTemplates = async () => {
  const results = [];
  for (const def of DEFAULT_TEMPLATES) {
    let existing = await WhatsAppTemplate.findOne({ key: def.key });
    if (!existing) {
      existing = await WhatsAppTemplate.create({
        ...def,
        is_active: true,
      });
    } else if (!existing.process) {
      existing.process = def.process;
      await existing.save();
    }
    results.push(existing);
  }

  // Migrate older welcome templates that have no process set
  await WhatsAppTemplate.updateMany(
    {
      key: STUDENT_WELCOME_TEMPLATE_KEY,
      $or: [{ process: { $exists: false } }, { process: null }, { process: "" }],
    },
    { $set: { process: "student_admission" } }
  );

  return results;
};

/** Active template bound to a process (most recently updated wins). */
export const getActiveTemplateForProcess = async (processKey) => {
  await ensureDefaultWhatsAppTemplates();
  const process = String(processKey || "").trim();
  if (!process || process === "custom") return null;

  return WhatsAppTemplate.findOne({
    process,
    is_active: true,
  })
    .sort({ updatedAt: -1 })
    .exec();
};

export const sendWhatsAppText = async ({ phone, text, sessionId } = {}) => {
  if (!isOpenWaConfigured()) {
    return { sent: false, skipped: true, reason: "OpenWA is not configured" };
  }

  const chatId = toWhatsAppChatId(phone);
  if (!chatId) {
    return { sent: false, skipped: true, reason: "Invalid student phone number" };
  }

  const message = String(text || "").trim();
  if (!message) {
    return { sent: false, skipped: true, reason: "Message body is empty" };
  }
  if (message.length > 4096) {
    return {
      sent: false,
      skipped: true,
      reason: "Message exceeds WhatsApp 4096 character limit",
    };
  }

  let session = null;
  if (sessionId) {
    session = await openWaRequest("GET", `/api/sessions/${sessionId}`);
  } else {
    session = await findReadyWhatsAppSession();
  }

  const id = session?.id || session?._id;
  if (!id || String(session?.status || "").toLowerCase() !== "ready") {
    return {
      sent: false,
      skipped: true,
      reason: "No ready WhatsApp session. Connect WhatsApp first.",
    };
  }

  const result = await openWaRequest(
    "POST",
    `/api/sessions/${id}/messages/send-text`,
    {
      body: { chatId, text: message },
      timeoutMs: 45000,
    }
  );

  return {
    sent: true,
    chatId,
    sessionId: id,
    sessionName: session?.name || "",
    result,
  };
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
    if (!template) {
      return {
        sent: false,
        skipped: true,
        reason: `No active WhatsApp template for process "${processKey}"`,
      };
    }

    const text = renderWhatsAppTemplate(template.body, vars);
    const outcome = await sendWhatsAppText({ phone, text });

    return {
      ...outcome,
      process: processKey,
      template_key: template.key,
      template_name: template.name,
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
  ensureDefaultWhatsAppTemplates,
  getActiveTemplateForProcess,
  renderWhatsAppTemplate,
  buildStudentTemplateVars,
  sendWhatsAppForProcess,
  sendStudentWelcomeWhatsApp,
  sendFeePaymentWhatsApp,
  sendWhatsAppText,
  slugifyTemplateKey,
};
