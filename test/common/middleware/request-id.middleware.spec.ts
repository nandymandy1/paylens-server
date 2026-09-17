import { describe, expect, it, vi } from 'vitest';
import { requestIdMiddleware } from '../../../src/common/middleware/request-id.middleware.js';
describe('requestIdMiddleware', () => {
  it('accepts a safe incoming request id', () => {
    const request = { header: () => 'req_safe' };
    const response = { setHeader: vi.fn() };
    const next = vi.fn();
    requestIdMiddleware(request as never, response as never, next);
    expect(response.setHeader).toHaveBeenCalledWith('x-request-id', 'req_safe');
  });
});
