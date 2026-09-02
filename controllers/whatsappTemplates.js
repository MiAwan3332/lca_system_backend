import WhatsAppTemplate from "../models/whatsappTemplate.js";
import {
  WHATSAPP_TEMPLATE_TAGS,
  WHATSAPP_PROCESSES,
  WHATSAPP_PROCESS_KEYS,
  ensureDefaultWhatsAppTemplates,
  renderWhatsAppTemplate,
  buildStudentTemplateVars,
  buildUserTemplateVars,
  buildPanelistTemplateVars,
  buildQualifierTemplateVars,
  sendWhatsAppText,
  slugifyTemplateKey,
} from "../utils/whatsappMessaging.js";

const getRequestUserId = (req) =>
  req.user?.user?.id || req.user?.user?._id || req.user?.id || null;

const findTemplate = async (keyOrId) => {
  const value = String(keyOrId || "").trim();
  if (!value) return null;
  let template = await WhatsAppTemplate.findOne({ key: value });
  if (!template && value.match(/^[a-f\d]{24}$/i)) {
    template = await WhatsAppTemplate.findById(value);
  }
  return template;
};

const sampleVars = () => ({
  ...buildStudentTemplateVars({
    student: {
      name: "Ali Khan",
      phone: "03001234567",
      cnic: "35202-1234567-1",
      roll_number: "CSS-001",
      admission_date: new Date(),
      total_fee: 50000,
      paid_fee: 20000,
      pending_fee: 30000,
    },
    batch: {
      name: "CSS Morning 2026",
      class_start_time: "09:00",
      class_end_time: "13:00",
    },
    password: "lca@123456",
    paymentMethod: "Cash",
    amountReceived: 10000,
  }),
  ...buildUserTemplateVars({
    user: {
      name: "Ali Khan",
      email: "ali@example.com",
      phone: "03001234567",
      role: "Principal",
    },
    password: "lcaadmin@123456",
  }),
  ...buildPanelistTemplateVars({
    panelist: {
      name: "Ali Khan",
      phone: "03001234567",
      description: "Senior interviewer for CSS panel",
      is_active: true,
    },
  }),
  ...buildQualifierTemplateVars({
    qualifier: {
      name: "Ali Khan",
      phone: "03001234567",
      cnic: "35202-1234567-1",
      description: "Interview candidate — CSS batch",
      is_active: true,
      total_fee: 4000,
      discount_amount: 1000,
      paid_fee: 2000,
      pending_fee: 2000,
      payment_method: "Cash",
    },
    batch: { name: "Interview Panel Aug 2026", batch_fee: 5000 },
    paymentMethod: "Cash",
    amountReceived: 2000,
  }),
});

/** Available merge tags + process catalog for the editor. */
export const listWhatsAppTemplateTags = async (_req, res) => {
  try {
    res.status(200).json({
      tags: WHATSAPP_TEMPLATE_TAGS,
      processes: WHATSAPP_PROCESSES,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** List all templates. */
export const listWhatsAppTemplates = async (_req, res) => {
  try {
    await ensureDefaultWhatsAppTemplates();
    const templates = await WhatsAppTemplate.find()
      .sort({ process: 1, name: 1 })
      .lean();
    res.status(200).json({
      templates,
      tags: WHATSAPP_TEMPLATE_TAGS,
      processes: WHATSAPP_PROCESSES,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Get one template by key or id. */
export const getWhatsAppTemplate = async (req, res) => {
  try {
    await ensureDefaultWhatsAppTemplates();
    const template = await findTemplate(req.params.keyOrId);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.status(200).json({
      template,
      tags: WHATSAPP_TEMPLATE_TAGS,
      processes: WHATSAPP_PROCESSES,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Create a new template. */
export const createWhatsAppTemplate = async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Template name is required" });
    }

    const process = String(body.process || "custom").trim();
    if (!WHATSAPP_PROCESS_KEYS.includes(process)) {
      return res.status(400).json({
        message: `Invalid process. Use one of: ${WHATSAPP_PROCESS_KEYS.join(", ")}`,
      });
    }

    const messageBody = String(
      body.body || `Assalam o Alaikum {{name}}!\n\n— {{academy_name}}`
    ).trim();
    if (!messageBody) {
      return res.status(400).json({ message: "Message body is required" });
    }

    let key = slugifyTemplateKey(body.key || name);
    const existingKey = await WhatsAppTemplate.findOne({ key });
    if (existingKey) {
      key = `${key}_${Date.now().toString(36)}`;
    }

    const isActive = body.is_active !== false;

    // Only one active template per auto process
    if (isActive && process !== "custom") {
      await WhatsAppTemplate.updateMany(
        { process, is_active: true },
        { $set: { is_active: false } }
      );
    }

    const template = await WhatsAppTemplate.create({
      key,
      name,
      description: String(body.description || "").trim(),
      process,
      body: messageBody,
      is_active: isActive,
      updated_by: getRequestUserId(req) || undefined,
    });

    res.status(201).json({
      message: "Template created",
      template,
      tags: WHATSAPP_TEMPLATE_TAGS,
      processes: WHATSAPP_PROCESSES,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Template key already exists" });
    }
    res.status(500).json({ message: error.message });
  }
};

/** Update template fields. */
export const updateWhatsAppTemplate = async (req, res) => {
  try {
    const template = await findTemplate(req.params.keyOrId);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    const body = req.body || {};
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) {
        return res.status(400).json({ message: "Template name is required" });
      }
      template.name = name;
    }
    if (body.description != null) {
      template.description = String(body.description).trim();
    }
    if (body.process != null) {
      const process = String(body.process).trim();
      if (!WHATSAPP_PROCESS_KEYS.includes(process)) {
        return res.status(400).json({
          message: `Invalid process. Use one of: ${WHATSAPP_PROCESS_KEYS.join(", ")}`,
        });
      }
      template.process = process;
    }
    if (body.body != null) {
      const messageBody = String(body.body).trim();
      if (!messageBody) {
        return res.status(400).json({ message: "Message body is required" });
      }
      template.body = messageBody;
    }
    if (body.is_active != null) {
      template.is_active = Boolean(body.is_active);
    }

    // Only one active template per auto process
    if (template.is_active && template.process !== "custom") {
      await WhatsAppTemplate.updateMany(
        {
          _id: { $ne: template._id },
          process: template.process,
          is_active: true,
        },
        { $set: { is_active: false } }
      );
    }

    template.updated_by = getRequestUserId(req) || undefined;
    await template.save();

    res.status(200).json({
      message: "Template updated",
      template,
      tags: WHATSAPP_TEMPLATE_TAGS,
      processes: WHATSAPP_PROCESSES,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Delete a template. */
export const deleteWhatsAppTemplate = async (req, res) => {
  try {
    const template = await findTemplate(req.params.keyOrId);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    await template.deleteOne();
    res.status(200).json({ message: "Template deleted", key: template.key });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Preview rendered message. */
export const previewWhatsAppTemplate = async (req, res) => {
  try {
    const template = await findTemplate(req.params.keyOrId);
    const bodyText =
      req.body?.body != null
        ? String(req.body.body)
        : template?.body || "";

    const vars = { ...sampleVars(), ...(req.body?.vars || {}) };
    const rendered = renderWhatsAppTemplate(bodyText, vars);

    res.status(200).json({
      rendered,
      vars,
      template_key: template?.key || req.params.keyOrId,
      process: template?.process || null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/** Send a test message using the template. */
export const testWhatsAppTemplate = async (req, res) => {
  try {
    const template = await findTemplate(req.params.keyOrId);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    if (template.is_active !== true) {
      return res.status(400).json({
        message:
          "This template is inactive. Turn Active on and save before sending.",
      });
    }

    const phone = String(req.body?.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    const vars = buildStudentTemplateVars({
      student: {
        name: req.body?.name || "Test Student",
        phone,
        cnic: req.body?.cnic || "N/A",
        roll_number: req.body?.roll_number || "TEST-001",
        admission_date: new Date(),
        total_fee: Number(req.body?.total_fee) || 0,
        paid_fee: Number(req.body?.paid_fee) || 0,
        pending_fee: Number(req.body?.pending_fee) || 0,
      },
      batch: {
        name: req.body?.batch || "Test Batch",
        class_start_time: req.body?.class_start_time || "09:00",
        class_end_time: req.body?.class_end_time || "13:00",
      },
      password: req.body?.password || "lca@123456",
      paymentMethod: req.body?.payment_method || "Cash",
      amountReceived: Number(req.body?.amount_received) || 10000,
    });

    const text = renderWhatsAppTemplate(template.body, vars);
    const outcome = await sendWhatsAppText({ phone, text });

    if (!outcome.sent) {
      return res.status(400).json({
        message: outcome.reason || outcome.error || "Could not send test message",
        outcome,
      });
    }

    res.status(200).json({
      message: "Test WhatsApp message sent",
      outcome,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
