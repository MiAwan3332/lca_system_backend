export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
/** Higher cap for Excel/PDF exports (opt-in via export=1). */
export const MAX_EXPORT_PAGE_SIZE = 10000;

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isExportRequest = (query = {}) => {
  const flag = String(query.export || query.for_export || "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

export const getPagination = (
  query = {},
  { defaultLimit = DEFAULT_PAGE_SIZE, maxLimit = MAX_PAGE_SIZE } = {}
) => {
  const page = positiveInteger(query.page, 1);
  const requestedLimit = positiveInteger(query.limit, defaultLimit);
  const effectiveMax = isExportRequest(query)
    ? Math.max(maxLimit, MAX_EXPORT_PAGE_SIZE)
    : maxLimit;
  const limit = Math.min(requestedLimit, effectiveMax);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

export const buildPaginationResponse = ({ docs, totalDocs, page, limit }) => {
  const totalPages = Math.max(1, Math.ceil(totalDocs / limit) || 1);
  const hasPrevPage = page > 1;
  const hasNextPage = page < totalPages && totalDocs > 0;

  return {
    docs,
    totalDocs,
    limit,
    totalPages,
    page,
    pagingCounter: (page - 1) * limit + 1,
    hasPrevPage,
    hasNextPage,
    prevPage: hasPrevPage ? page - 1 : null,
    nextPage: hasNextPage ? page + 1 : null,
  };
};

export const paginateQuery = async ({ model, filter = {}, query = {}, sort, populate }) => {
  const { page, limit, skip } = getPagination(query);
  let findQuery = model.find(filter);

  if (sort) findQuery = findQuery.sort(sort);
  if (populate) findQuery = findQuery.populate(populate);

  const [totalDocs, docs] = await Promise.all([
    model.countDocuments(filter),
    findQuery.skip(skip).limit(limit).lean(),
  ]);

  return buildPaginationResponse({ docs, totalDocs, page, limit });
};

export const enforcePaginationBounds = (req, _res, next) => {
  if (req.query && ("page" in req.query || "limit" in req.query)) {
    const { page, limit } = getPagination(req.query);
    req.query.page = String(page);
    req.query.limit = String(limit);
  }
  next();
};
