import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '../../src/config/env.validation.js';
const valid = {
  NODE_ENV: 'test',
  PORT: '3001',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/paylens',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'http://localhost:3000',
};
describe('validateEnvironment', () => {
  it('accepts validated runtime configuration', () =>
    expect(validateEnvironment(valid).PORT).toBe(3001));
  it('rejects malformed infrastructure configuration', () =>
    expect(() =>
      validateEnvironment({ ...valid, REDIS_URL: 'not-a-url' }),
    ).toThrow('REDIS_URL'));
});
