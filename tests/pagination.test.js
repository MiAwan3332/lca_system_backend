import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaginationResponse,
  enforcePaginationBounds,
  getPagination,
} from "../utils/pagination.js";

test("pagination applies safe defaults", () => {
  assert.deepEqual(getPagination({}), { page: 1, limit: 10, skip: 0 });
});

test("pagination caps oversized and invalid client values", () => {
  assert.deepEqual(getPagination({ page: "3", limit: "9999999" }), {
    page: 3,
    limit: 100,
    skip: 200,
  });
  assert.deepEqual(getPagination({ page: "-2", limit: "0" }), {
    page: 1,
    limit: 10,
    skip: 0,
  });
});

test("pagination response exposes demand-loading metadata", () => {
  assert.deepEqual(
    buildPaginationResponse({ docs: [{ id: 1 }], totalDocs: 21, page: 2, limit: 10 }),
    {
      docs: [{ id: 1 }],
      totalDocs: 21,
      limit: 10,
      totalPages: 3,
      page: 2,
      pagingCounter: 11,
      hasPrevPage: true,
      hasNextPage: true,
      prevPage: 1,
      nextPage: 3,
    }
  );
});

test("pagination middleware prevents endpoint-specific bypasses", () => {
  const req = { query: { page: "2", limit: "9999999" } };
  let continued = false;
  enforcePaginationBounds(req, {}, () => {
    continued = true;
  });

  assert.equal(req.query.page, "2");
  assert.equal(req.query.limit, "100");
  assert.equal(continued, true);
});
