import { describe, expect, it } from 'vitest';
import { HealthService } from '../../../src/modules/health/health.service.js';
describe('HealthService', () => {
  it('reports ready only when Postgres and Redis are ready', async () => {
    const service = new HealthService(
      { isReady: async () => true } as never,
      { isReady: async () => false } as never,
    );
    await expect(service.ready()).resolves.toEqual({
      ready: false,
      dependencies: { database: true, redis: false },
    });
  });
});
