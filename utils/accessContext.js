import { AsyncLocalStorage } from 'node:async_hooks';
export const accessContext = new AsyncLocalStorage();
export const legacyAccessDecision = (req) => {
  const context = req?.access || accessContext.getStore();
  return context?.enforced ? Boolean(context.routeAllowed) : undefined;
};
