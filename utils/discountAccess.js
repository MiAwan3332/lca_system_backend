import { evaluateAccess } from './accessPolicy.js';

// Fee and inline discounts use the same role permission, record scope and amount limit.
export function assertDiscountAccess(context, value, resource = {}) {
  if (!context || context.owner || context.enforced === false) return;
  const amount = value === undefined || value === null || value === '' ? 0 : Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error('Discount must be a valid non-negative amount'), { status: 400 });
  if (!amount) return;
  if (!evaluateAccess(context, 'fees.discount.fee', { ...resource, amount }).allowed) {
    throw Object.assign(new Error('Discount permission, scope and amount limit must allow this discount'), { status: 403, code: 'ACCESS_DENIED' });
  }
}
