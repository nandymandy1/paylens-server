import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { HealthController } from '../../../src/modules/health/health.controller.js';
import { HealthService } from '../../../src/modules/health/health.service.js';

describe('HealthController (e2e)', () => {
  let app: INestApplication;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            health: () => ({ status: 'ok' }),
            ready: async () => ({
              ready: true,
              dependencies: { database: true, redis: true },
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => app.close());
  it('serves liveness without dependency checks', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
