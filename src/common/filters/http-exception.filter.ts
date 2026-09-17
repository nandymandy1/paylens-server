import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { RequestWithId } from '../middleware/request-id.middleware.js';
import type { ApiErrorResponse } from '../types/api-response.types.js';
const codes: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMIT_EXCEEDED',
  503: 'SERVICE_UNAVAILABLE',
};
@Catch()
export class HttpExceptionFilter extends BaseExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    super();
  }
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithId>();
    const response = context.getResponse<Response>();
    const httpException =
      exception instanceof HttpException ? exception : undefined;
    const status =
      httpException?.getStatus() ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const body: ApiErrorResponse = {
      success: false,
      code: codes[status] ?? 'INTERNAL_SERVER_ERROR',
      message:
        status === 400
          ? 'Request validation failed.'
          : (httpException?.message ?? 'An unexpected error occurred.'),
      requestId: request.requestId,
    };
    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId: request.requestId },
        'Unhandled request error',
      );
      body.message = 'An unexpected error occurred.';
    }
    response.status(status).json(body);
  }
}
