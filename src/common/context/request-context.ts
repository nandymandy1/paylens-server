import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  traceId?: string;
  spanId?: string;
  authUserId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Populated by the real auth guard/session resolution once authentication
// succeeds. Unauthenticated requests simply leave authUserId unset so the
// field is omitted from logs. Never fabricate an identity here.
export function setAuthUserId(userId: string): void {
  const store = requestContext.getStore();

  if (store) {
    store.authUserId = userId;
  }
}
