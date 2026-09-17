import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter.js";
import { createValidationException } from "@/common/pipes/validation-exception.js";

function createHost(statusHolder: { status?: number }) {
  const request = { requestId: "filter-request" } as { requestId: string; errorCode?: string };
  const response = {
    status: vi.fn((status: number) => {
      statusHolder.status = status;

      return { json: vi.fn() };
    }),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  };

  return { host, request, response };
}

describe("http exception filter", () => {
  it("attaches the machine-readable code for failed-request logging", () => {
    const logger = { error: vi.fn() };
    const { host, request } = createHost({});
    const filter = new HttpExceptionFilter(logger as never);

    filter.catch(new HttpException("missing", HttpStatus.NOT_FOUND), host as never);

    expect(request.errorCode).toBe("NOT_FOUND");
  });

  it("maps validation failures to VALIDATION_FAILED without a stack log", () => {
    const logger = { error: vi.fn() };
    const { host, request } = createHost({});
    const filter = new HttpExceptionFilter(logger as never);

    filter.catch(createValidationException([]), host as never);

    expect(request.errorCode).toBe("VALIDATION_FAILED");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs unexpected failures once centrally with the error attached", () => {
    const logger = { error: vi.fn() };
    const { host, request } = createHost({});
    const filter = new HttpExceptionFilter(logger as never);
    const failure = new Error("database down");

    filter.catch(failure, host as never);

    expect(request.errorCode).toBe("INTERNAL_SERVER_ERROR");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, requestId: "filter-request" }),
      expect.any(String),
    );
  });
});
