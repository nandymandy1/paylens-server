import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
export type RequestWithId = Request & { requestId: string };
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export function requestIdMiddleware(
  request: RequestWithId,
  response: Response,
  next: NextFunction,
) {
  const incoming = request.header('x-request-id');
  request.requestId =
    incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  response.setHeader('x-request-id', request.requestId);
  next();
}
