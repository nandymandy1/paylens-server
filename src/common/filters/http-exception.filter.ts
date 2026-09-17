import { ArgumentsHost, Catch, HttpException, HttpStatus } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { Response } from "express";
import { PinoLogger } from "nestjs-pino";
import type { RequestWithId } from "@/common/middleware/request-id.middleware.js";
import {
  ValidationException,
  type ValidationDetails,
} from "@/common/pipes/validation-exception.js";
import type { ApiErrorResponse } from "@/common/types/api-response.types.js";

const codes: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMIT_EXCEEDED",
  503: "SERVICE_UNAVAILABLE",
};

const messages: Record<number, string> = {
  400: "Bad request.",
  401: "Unauthorized.",
  403: "Forbidden.",
  404: "Not found.",
  429: "Too many requests.",
  503: "Service unavailable.",
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
    const httpException = exception instanceof HttpException ? exception : undefined;
    const status = httpException?.getStatus() ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const validationException = exception instanceof ValidationException ? exception : undefined;
    const body: ApiErrorResponse<ValidationDetails> = {
      success: false,
      code: validationException ? "VALIDATION_FAILED" : (codes[status] ?? "INTERNAL_SERVER_ERROR"),
      message: validationException
        ? "Request validation failed."
        : (messages[status] ?? "An unexpected error occurred."),
      requestId: request.requestId,
    };

    if (validationException) {
      const exceptionBody = validationException.getResponse() as {
        details: ValidationDetails;
      };

      body.details = exceptionBody.details;
    }

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId: request.requestId },
        "Unhandled request error",
      );
      body.message = "An unexpected error occurred.";
    }

    response.status(status).json(body);
  }
}
