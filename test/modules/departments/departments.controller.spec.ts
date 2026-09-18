import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter.js";
import { createGlobalValidationPipe } from "@/common/pipes/global-validation.pipe.js";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import { DepartmentsController } from "@/modules/departments/departments.controller.js";
import { DepartmentsService } from "@/modules/departments/departments.service.js";

describe("DepartmentsController", () => {
  it("delegates department reads to the service with the principal first", async () => {
    const departments = {
      list: vi.fn(async () => []),
      detail: vi.fn(async () => ({ id: "dept-eng" })),
    };
    const controller = new DepartmentsController(departments as never);
    const principal = {
      userId: "user-1",
      sessionId: "session-1",
      organizationId: "org-1",
      membershipId: "membership-1",
      role: "MANAGER",
    } as never;

    await controller.list(principal);
    await controller.detail(principal, "dept-eng");

    expect(departments.list).toHaveBeenCalledWith(principal);
    expect(departments.detail).toHaveBeenCalledWith(principal, "dept-eng");
  });

  it("delegates department mutations to the service with the principal first", async () => {
    const departments = {
      create: vi.fn(async () => ({ id: "dept-new" })),
      update: vi.fn(async () => ({ id: "dept-eng" })),
      remove: vi.fn(async () => ({ deleted: true })),
    };
    const controller = new DepartmentsController(departments as never);
    const principal = {
      userId: "user-1",
      sessionId: "session-1",
      organizationId: "org-1",
      membershipId: "membership-1",
      role: "HR_ADMIN",
    } as never;

    await controller.create(principal, { code: "ENG", name: "Engineering" } as never);
    await controller.update(principal, "dept-eng", { name: "Eng" } as never);
    await controller.remove(principal, "dept-eng");

    expect(departments.create).toHaveBeenCalledWith(principal, {
      code: "ENG",
      name: "Engineering",
    });
    expect(departments.update).toHaveBeenCalledWith(principal, "dept-eng", { name: "Eng" });
    expect(departments.remove).toHaveBeenCalledWith(principal, "dept-eng");
  });
});

/**
 * HTTP validation boundary: proves the real Nest pipeline
 * (HTTP → controller → ValidationPipe → DTO → service) enforces the
 * department contract. This fails if the controller's DTO imports are
 * type-only (runtime metadata erased → pipe skips validation).
 */
describe("DepartmentsController HTTP validation boundary", () => {
  let app: INestApplication;
  const departments = {
    create: vi.fn(async (principal: unknown, dto: unknown) => ({ id: "dept-new", dto })),
    update: vi.fn(async (principal: unknown, id: string, dto: unknown) => ({ id, dto })),
  };
  const principal = {
    userId: "user-1",
    sessionId: "session-1",
    organizationId: "org-1",
    membershipId: "membership-1",
    role: "HR_ADMIN",
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DepartmentsController],
      providers: [{ provide: DepartmentsService, useValue: departments }],
    })
      .overrideGuard(SessionGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { principal: unknown } };
        }) => {
          context.switchToHttp().getRequest().principal = principal;

          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new HttpExceptionFilter({ error: () => undefined } as never));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("accepts a valid department through the HTTP boundary", async () => {
    await request(app.getHttpServer())
      .post("/departments")
      .send({ code: "ENG", name: "Engineering" })
      .expect(201);

    expect(departments.create).toHaveBeenCalledWith(principal, {
      code: "ENG",
      name: "Engineering",
    });
  });

  it("normalizes lowercase codes through the HTTP boundary", async () => {
    await request(app.getHttpServer())
      .post("/departments")
      .send({ code: "eng", name: "Engineering" })
      .expect(201);

    expect(departments.create).toHaveBeenCalledWith(principal, {
      code: "ENG",
      name: "Engineering",
    });
  });

  it.each(["", "A", "ENG_01", "-ENG", "   ", "ABCDEFGHIJKLMNOPQRSTU"])(
    "rejects invalid code %j with the stable validation envelope",
    async (code) => {
      const response = await request(app.getHttpServer())
        .post("/departments")
        .send({ code, name: "Engineering" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("VALIDATION_FAILED");
      expect(response.body.details.fields.code).toBeDefined();
    },
  );

  it.each(["", "   ", "A", "x".repeat(101)])(
    "rejects invalid name %j with the stable validation envelope",
    async (name) => {
      const response = await request(app.getHttpServer())
        .post("/departments")
        .send({ code: "ENG", name })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("VALIDATION_FAILED");
      expect(response.body.details.fields.name).toBeDefined();
    },
  );

  it("rejects unknown writable fields per the global whitelist policy", async () => {
    const response = await request(app.getHttpServer())
      .post("/departments")
      .send({ code: "ENG", name: "Engineering", admin: true })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe("VALIDATION_FAILED");
  });

  it.each([{ code: "A" }, { code: "ENG_01" }, { name: "" }])(
    "rejects invalid department update %j",
    async (body) => {
      const response = await request(app.getHttpServer())
        .patch("/departments/dept-eng")
        .send(body)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("VALIDATION_FAILED");
    },
  );

  it.each([{ name: null }, { code: null }])(
    "rejects null department update field %j (omitted skips, null fails)",
    async (body) => {
      const response = await request(app.getHttpServer())
        .patch("/departments/dept-eng")
        .send(body)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("VALIDATION_FAILED");
      expect(response.body.details.fields).toBeDefined();
    },
  );

  it("accepts an empty department update (all fields omitted)", async () => {
    await request(app.getHttpServer()).patch("/departments/dept-eng").send({}).expect(200);
  });

  it("accepts a valid department update through the HTTP boundary", async () => {
    await request(app.getHttpServer())
      .patch("/departments/dept-eng")
      .send({ name: "Eng" })
      .expect(200);

    expect(departments.update).toHaveBeenCalledWith(principal, "dept-eng", { name: "Eng" });
  });
});
