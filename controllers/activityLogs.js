import ActivityLog from "../models/activityLogs.js";
import { denyUnlessInstitutionAdmin } from "../utils/lmsAccess.js";

const clampInt = (value, fallback, min, max) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

/**
 * Server-side pagination only — never returns the full collection.
 * Default: page=1, limit=10. Client can raise limit (capped at 100).
 */
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
      const regex = { $regex: String(query), $options: "i" };
      filter.$or = [
        { description: regex },
        { actor_name: regex },
        { actor_email: regex },
        { path: regex },
        { module: regex },
        { action: regex },
      ];
    }

    const pageNum = clampInt(page, 1, 1, 100000);
    const limitNum = clampInt(limit, 10, 1, 100);
    const skip = (pageNum - 1) * limitNum;

    const [totalDocs, docs] = await Promise.all([
      ActivityLog.countDocuments(filter),
      ActivityLog.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate([
          { path: "actor_user", select: "name email role" },
          { path: "actor_student", select: "name email roll_number" },
          { path: "actor_teacher", select: "name email" },
        ])
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalDocs / limitNum) || 1);
    const hasPrevPage = pageNum > 1;
    const hasNextPage = pageNum < totalPages && totalDocs > 0;

    res.status(200).json({
      docs,
      totalDocs,
      limit: limitNum,
      totalPages,
      page: pageNum,
      pagingCounter: skip + 1,
      hasPrevPage,
      hasNextPage,
      prevPage: hasPrevPage ? pageNum - 1 : null,
      nextPage: hasNextPage ? pageNum + 1 : null,
    });
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
