import Student from "../models/students.js";
import Qualifier from "../models/qualifiers.js";
import Batch from "../models/batches.js";
import WhatsAppQueuedMessage from "../models/whatsappQueuedMessage.js";
import {
  buildQualifierTemplateVars,
  buildStudentTemplateVars,
  renderWhatsAppTemplate,
  resolveWhatsAppSenderFromReq,
} from "../utils/whatsappMessaging.js";
import {
  cancelAllInQueue,
  cancelQueuedMessage,
  createCampaignId,
  enqueueWhatsAppMessage,
  getQueueStats,
  resolveTemplateBody,
  WHATSAPP_QUEUE_DELAY_MS,
} from "../utils/whatsappQueue.js";

const trimOrEmpty = (value) => String(value ?? "").trim();

export const listWhatsAppQueue = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status = "",
      campaign_id = "",
      query = "",
    } = req.query || {};

    const filter = {};
    const statusValue = trimOrEmpty(status);
    if (statusValue && statusValue !== "all") {
      filter.status = statusValue;
    }

    const campaignId = trimOrEmpty(campaign_id);
    if (campaignId) {
      filter.campaign_id = campaignId;
    }

    const search = trimOrEmpty(query);
    if (search) {
      filter.$or = [
        { recipient_name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { template_name: { $regex: search, $options: "i" } },
        { batch_name: { $regex: search, $options: "i" } },
        { source: { $regex: search, $options: "i" } },
        { created_by_name: { $regex: search, $options: "i" } },
      ];
    }

    const options = {
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(200, Math.max(1, Number(limit) || 50)),
      sort: { createdAt: -1 },
      lean: true,
      populate: [{ path: "created_by", select: "name email" }],
    };

    const result = await WhatsAppQueuedMessage.paginate(filter, options);
    const stats = await getQueueStats();

    res.status(200).json({
      ...result,
      stats,
      delay_ms: WHATSAPP_QUEUE_DELAY_MS,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getWhatsAppQueueStats = async (_req, res) => {
  try {
    const stats = await getQueueStats();
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const cancelWhatsAppQueueMessage = async (req, res) => {
  try {
    const result = await cancelQueuedMessage(req.params.id);
    if (!result.ok) {
      return res.status(400).json({ message: result.message });
    }
    res.status(200).json({
      message: "Message cancelled",
      item: result.message,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const cancelAllWhatsAppQueue = async (req, res) => {
  try {
    const campaign_id = trimOrEmpty(req.body?.campaign_id);
    const result = await cancelAllInQueue({ campaign_id });
    res.status(200).json({
      message: `Cancelled ${result.cancelled} message(s)`,
      cancelled: result.cancelled,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const loadAudienceRecipients = async ({
  audience,
  batch_id,
  recipients,
}) => {
  if (Array.isArray(recipients) && recipients.length > 0) {
    return recipients
      .map((row) => ({
        name: trimOrEmpty(row?.name),
        phone: trimOrEmpty(row?.phone),
        recipient_type: trimOrEmpty(row?.recipient_type) || "custom",
        recipient_id: row?.recipient_id || null,
        batch: row?.batch || null,
        batch_name: trimOrEmpty(row?.batch_name),
        vars: row?.vars && typeof row.vars === "object" ? row.vars : null,
      }))
      .filter((row) => row.phone);
  }

  const audienceKey = trimOrEmpty(audience).toLowerCase();
  const batchId = trimOrEmpty(batch_id);

  if (!audienceKey || !batchId) {
    return { error: "Select an audience and batch, or provide recipients" };
  }

  const batch = await Batch.findById(batchId).select(
    "name class_start_time class_end_time batch_fee is_paid_batch is_interview_batch"
  );
  if (!batch) {
    return { error: "Selected batch not found" };
  }

  if (audienceKey === "students") {
    const students = await Student.find({
      batch: batchId,
      is_active: { $ne: false },
    })
      .select("name phone cnic roll_number total_fee paid_fee pending_fee admission_date batch")
      .lean();

    return students.map((student) => ({
      name: student.name || "",
      phone: student.phone || "",
      recipient_type: "student",
      recipient_id: student._id,
      batch: batch._id,
      batch_name: batch.name || "",
      vars: buildStudentTemplateVars({ student, batch }),
    }));
  }

  if (audienceKey === "qualifiers") {
    const qualifiers = await Qualifier.find({
      batch: batchId,
      is_active: { $ne: false },
    })
      .select(
        "name phone cnic city province father_name total_fee paid_fee pending_fee batch"
      )
      .lean();

    return qualifiers.map((qualifier) => ({
      name: qualifier.name || "",
      phone: qualifier.phone || "",
      recipient_type: "qualifier",
      recipient_id: qualifier._id,
      batch: batch._id,
      batch_name: batch.name || "",
      vars: buildQualifierTemplateVars({ qualifier, batch }),
    }));
  }

  return { error: "Audience must be students or qualifiers" };
};

/** Enqueue many WhatsApp messages (processed one-by-one with delay). */
export const enqueueBulkWhatsApp = async (req, res) => {
  try {
    const {
      audience,
      batch_id: batchId,
      recipients,
      template_key,
      template_id,
      body,
      source = "bulk",
    } = req.body || {};

    const templateResult = await resolveTemplateBody({
      template_key,
      template_id,
      body,
    });
    if (templateResult.error) {
      return res.status(400).json({ message: templateResult.error });
    }

    const loaded = await loadAudienceRecipients({
      audience,
      batch_id: batchId,
      recipients,
    });
    if (loaded?.error) {
      return res.status(400).json({ message: loaded.error });
    }
    if (!Array.isArray(loaded) || loaded.length === 0) {
      return res.status(400).json({ message: "No recipients found to message" });
    }
    if (loaded.length > 1000) {
      return res.status(400).json({
        message: "Maximum 1000 recipients can be queued at once",
      });
    }

    const campaignId = createCampaignId();
    const sender = await resolveWhatsAppSenderFromReq(req);
    const results = {
      queued: 0,
      failed: [],
      campaign_id: campaignId,
      delay_ms: WHATSAPP_QUEUE_DELAY_MS,
      sent_by: sender.created_by_name || null,
    };

    for (let index = 0; index < loaded.length; index += 1) {
      const row = loaded[index];
      try {
        const vars = {
          name: row.name || "",
          phone: row.phone || "",
          batch: row.batch_name || "",
          ...(row.vars || {}),
        };
        const message = renderWhatsAppTemplate(templateResult.body, vars);
        const outcome = await enqueueWhatsAppMessage({
          phone: row.phone,
          message,
          recipient_name: row.name,
          source: trimOrEmpty(source) || "bulk",
          process: templateResult.process,
          template_key: templateResult.template_key,
          template_name: templateResult.template_name,
          batch: row.batch,
          batch_name: row.batch_name,
          recipient_type: row.recipient_type,
          recipient_id: row.recipient_id,
          campaign_id: campaignId,
          created_by: sender.created_by,
          created_by_name: sender.created_by_name,
        });

        if (outcome.queued) {
          results.queued += 1;
        } else {
          results.failed.push({
            phone: row.phone,
            name: row.name,
            message: outcome.reason || outcome.error || "Could not queue",
          });
        }
      } catch (error) {
        results.failed.push({
          phone: row.phone,
          name: row.name,
          message: error.message,
        });
      }
    }

    const stats = await getQueueStats();

    res.status(200).json({
      message: `Queued ${results.queued} of ${loaded.length} messages. Sends one every ${Math.round(
        WHATSAPP_QUEUE_DELAY_MS / 1000
      )} seconds.`,
      ...results,
      total_recipients: loaded.length,
      stats,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
