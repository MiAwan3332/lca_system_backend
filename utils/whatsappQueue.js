import crypto from "crypto";
import WhatsAppQueuedMessage from "../models/whatsappQueuedMessage.js";
import {
  getActiveTemplateForProcess,
  renderWhatsAppTemplate,
  sendWhatsAppText,
  toWhatsAppNumber,
} from "./whatsappMessaging.js";
import WhatsAppTemplate from "../models/whatsappTemplate.js";

export const WHATSAPP_QUEUE_DELAY_MS = Number(
  process.env.WHATSAPP_QUEUE_DELAY_MS || 10000
);

let workerRunning = false;
let workerTimer = null;
let processing = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createCampaignId = () =>
  `wa_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

export const enqueueWhatsAppMessage = async ({
  phone,
  message,
  recipient_name = "",
  source = "manual",
  process = "",
  template_key = "",
  template_name = "",
  batch = null,
  batch_name = "",
  recipient_type = "",
  recipient_id = null,
  campaign_id = "",
  created_by = null,
} = {}) => {
  const trimmedPhone = String(phone || "").trim();
  const trimmedMessage = String(message || "").trim();

  if (!trimmedPhone) {
    return { queued: false, reason: "Phone number is required" };
  }
  if (!toWhatsAppNumber(trimmedPhone)) {
    return { queued: false, reason: "Invalid phone number for WhatsApp" };
  }
  if (!trimmedMessage) {
    return { queued: false, reason: "Message body is empty" };
  }

  const doc = await WhatsAppQueuedMessage.create({
    recipient_name: String(recipient_name || "").trim(),
    phone: trimmedPhone,
    message: trimmedMessage,
    status: "in_queue",
    source: String(source || "manual").trim() || "manual",
    process: String(process || "").trim(),
    template_key: String(template_key || "").trim(),
    template_name: String(template_name || "").trim(),
    batch: batch || null,
    batch_name: String(batch_name || "").trim(),
    recipient_type: String(recipient_type || "").trim(),
    recipient_id: recipient_id || null,
    campaign_id: String(campaign_id || "").trim(),
    created_by: created_by || null,
  });

  kickWhatsAppQueueWorker();

  return {
    queued: true,
    id: doc._id,
    status: doc.status,
    campaign_id: doc.campaign_id,
  };
};

/** Render process template and put message in queue (never sends immediately). */
export const enqueueWhatsAppForProcess = async ({
  process,
  phone,
  vars = {},
  recipient_name = "",
  source = "process",
  batch = null,
  batch_name = "",
  recipient_type = "",
  recipient_id = null,
  campaign_id = "",
  created_by = null,
} = {}) => {
  try {
    const processKey = String(process || "").trim();
    if (!processKey || processKey === "custom") {
      return {
        queued: false,
        skipped: true,
        reason: "Custom templates are not sent automatically",
      };
    }

    const template = await getActiveTemplateForProcess(processKey);
    if (!template?.body) {
      return {
        queued: false,
        skipped: true,
        reason: `No active WhatsApp template for process "${processKey}"`,
      };
    }

    const text = renderWhatsAppTemplate(template.body, vars);
    const outcome = await enqueueWhatsAppMessage({
      phone,
      message: text,
      recipient_name:
        recipient_name || vars?.name || vars?.Name || "",
      source,
      process: processKey,
      template_key: template.key,
      template_name: template.name,
      batch,
      batch_name,
      recipient_type,
      recipient_id,
      campaign_id,
      created_by,
    });

    return {
      ...outcome,
      sent: false,
      process: processKey,
      template_key: template.key,
      template_name: template.name,
      preview: text.slice(0, 180),
    };
  } catch (error) {
    console.error(`WhatsApp enqueue "${process}" failed:`, error.message);
    return {
      queued: false,
      sent: false,
      process,
      error: error.message || "Failed to queue WhatsApp message",
    };
  }
};

export const getQueueStats = async () => {
  const [in_queue, sending, sent, failed, cancelled] = await Promise.all([
    WhatsAppQueuedMessage.countDocuments({ status: "in_queue" }),
    WhatsAppQueuedMessage.countDocuments({ status: "sending" }),
    WhatsAppQueuedMessage.countDocuments({ status: "sent" }),
    WhatsAppQueuedMessage.countDocuments({ status: "failed" }),
    WhatsAppQueuedMessage.countDocuments({ status: "cancelled" }),
  ]);

  return {
    in_queue,
    sending,
    sent,
    failed,
    cancelled,
    delay_ms: WHATSAPP_QUEUE_DELAY_MS,
    worker_running: workerRunning,
  };
};

export const cancelQueuedMessage = async (id) => {
  const doc = await WhatsAppQueuedMessage.findById(id);
  if (!doc) {
    return { ok: false, message: "Message not found" };
  }
  if (doc.status !== "in_queue") {
    return {
      ok: false,
      message: `Only in-queue messages can be cancelled (current: ${doc.status})`,
    };
  }

  doc.status = "cancelled";
  doc.cancelled_at = new Date();
  await doc.save();
  return { ok: true, message: doc };
};

export const cancelAllInQueue = async ({ campaign_id } = {}) => {
  const filter = { status: "in_queue" };
  if (campaign_id) {
    filter.campaign_id = String(campaign_id).trim();
  }

  const result = await WhatsAppQueuedMessage.updateMany(filter, {
    $set: {
      status: "cancelled",
      cancelled_at: new Date(),
    },
  });

  return { ok: true, cancelled: result.modifiedCount || 0 };
};

const recoverStuckSending = async () => {
  await WhatsAppQueuedMessage.updateMany(
    { status: "sending" },
    { $set: { status: "in_queue", error: "" } }
  );
};

const processNextQueuedMessage = async () => {
  const next = await WhatsAppQueuedMessage.findOneAndUpdate(
    { status: "in_queue" },
    { $set: { status: "sending", error: "" } },
    { sort: { createdAt: 1 }, new: true }
  );

  if (!next) {
    return false;
  }

  try {
    const outcome = await sendWhatsAppText({
      phone: next.phone,
      text: next.message,
    });

    if (outcome?.sent) {
      next.status = "sent";
      next.sent_at = new Date();
      next.error = "";
    } else {
      next.status = "failed";
      next.error =
        outcome?.reason ||
        outcome?.error ||
        "WhatsApp send was skipped or failed";
    }
    await next.save();
  } catch (error) {
    next.status = "failed";
    next.error = error?.message || "Failed to send WhatsApp message";
    await next.save();
  }

  return true;
};

const runWorkerLoop = async () => {
  if (processing) return;
  processing = true;

  try {
    while (workerRunning) {
      const didWork = await processNextQueuedMessage();
      if (!didWork) {
        await sleep(2000);
        continue;
      }
      await sleep(WHATSAPP_QUEUE_DELAY_MS);
    }
  } catch (error) {
    console.error("WhatsApp queue worker error:", error);
  } finally {
    processing = false;
    if (workerRunning) {
      workerTimer = setTimeout(() => {
        runWorkerLoop();
      }, 2000);
    }
  }
};

export const kickWhatsAppQueueWorker = () => {
  if (!workerRunning) {
    startWhatsAppQueueWorker();
    return;
  }
  if (!processing && !workerTimer) {
    runWorkerLoop();
  }
};

export const startWhatsAppQueueWorker = async () => {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await recoverStuckSending();
  } catch (error) {
    console.error("WhatsApp queue recover failed:", error.message);
  }
  console.log(
    `WhatsApp queue worker started (delay ${WHATSAPP_QUEUE_DELAY_MS}ms between messages)`
  );
  runWorkerLoop();
};

export const stopWhatsAppQueueWorker = () => {
  workerRunning = false;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
};

export const resolveTemplateBody = async ({
  template_key,
  template_id,
  body,
} = {}) => {
  const customBody = String(body || "").trim();
  if (customBody) {
    return {
      body: customBody,
      template_key: "",
      template_name: "Custom message",
      process: "custom",
    };
  }

  const keyOrId = String(template_key || template_id || "").trim();
  if (!keyOrId) {
    return { error: "Template or message body is required" };
  }

  const isObjectId = /^[a-f\d]{24}$/i.test(keyOrId);
  const template = await WhatsAppTemplate.findOne(
    isObjectId ? { _id: keyOrId } : { key: keyOrId }
  );

  if (!template) {
    return { error: "WhatsApp template not found" };
  }
  if (template.is_active === false) {
    return { error: "Selected WhatsApp template is inactive" };
  }

  return {
    body: template.body,
    template_key: template.key,
    template_name: template.name,
    process: template.process || "custom",
  };
};

export default {
  WHATSAPP_QUEUE_DELAY_MS,
  createCampaignId,
  enqueueWhatsAppMessage,
  enqueueWhatsAppForProcess,
  getQueueStats,
  cancelQueuedMessage,
  cancelAllInQueue,
  startWhatsAppQueueWorker,
  stopWhatsAppQueueWorker,
  kickWhatsAppQueueWorker,
  resolveTemplateBody,
};
