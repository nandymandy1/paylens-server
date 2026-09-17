import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ResponseEnvelopeInterceptor } from '../../../src/common/interceptors/response-envelope.interceptor.js';
describe('ResponseEnvelopeInterceptor', () => {
  it('adds data and request id once', async () => {
    const result = await new Promise((resolve) =>
      new ResponseEnvelopeInterceptor()
        .intercept(
          {
            switchToHttp: () => ({
              getRequest: () => ({ requestId: 'req_test' }),
            }),
          } as never,
          { handle: () => of({ value: 1 }) },
        )
        .subscribe(resolve),
    );
    expect(result).toEqual({
      success: true,
      requestId: 'req_test',
      data: { value: 1 },
    });
  });
});
