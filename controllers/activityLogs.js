import ActivityLog from "../models/activityLogs.js";
import { denyUnlessInstitutionAdmin } from "../utils/lmsAccess.js";

export const getActivityLogs = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  const {
    query,
    actor_category,
    module,
    action,
    start_date,
    end_date,
    page,
    limit,
  } = req.query;

  try {
    const filter = {};

    if (actor_category && ["student", "teacher", "admin"].includes(actor_category)) {
      filter.actor_category = actor_category;
    }

    if (module) {
      filter.module = module;
    }

    if (action) {
      filter.action = action;
    }

    if (start_date || end_date) {
      filter.created_at = {};
      if (start_date) {
        filter.created_at.$gte = new Date(`${start_date}T00:00:00.000Z`);
      }
      if (end_date) {
        filter.created_at.$lte = new Date(`${end_date}T23:59:59.999Z`);
      }
    }

    if (query) {
      const regex = { $regex: query, $options: "i" };
      filter.$or = [
        { description: regex },
        { actor_name: regex },
        { actor_email: regex },
        { path: regex },
        { module: regex },
        { action: regex },
      ];
    }

    const logs = await ActivityLog.paginate(filter, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      sort: { created_at: -1 },
      populate: [
        { path: "actor_user", select: "name email role" },
        { path: "actor_student", select: "name email roll_number" },
        { path: "actor_teacher", select: "name email" },
      ],
    });

    res.status(200).json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getActivityLogModules = async (req, res) => {
  if (denyUnlessInstitutionAdmin(req, res)) return;

  try {
    const { actor_category } = req.query;
    const match = actor_category ? { actor_category } : {};

    const modules = await ActivityLog.distinct("module", match);
    const actions = await ActivityLog.distinct("action", match);

    res.status(200).json({
      modules: modules.filter(Boolean).sort(),
      actions: actions.filter(Boolean).sort(),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
