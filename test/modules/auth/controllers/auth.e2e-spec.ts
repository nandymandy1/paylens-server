import { execSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmailService } from "@/modules/email/email.service.js";

// Runs only against an explicitly supplied external Redis; never provisions one via Docker.
describe.runIf(process.env.AUTH_E2E_REDIS_URL)("Authentication flows (e2e)", () => {
  let app: INestApplication;
  let postgres: StartedTestContainer;
  let outbox: EmailService;
  const originalEnvironment = { ...process.env };

  const verificationTokenFor = (email: string): string => {
    const entry = [...outbox.outbox]
      .reverse()
      .find((item) => item.to === email && item.html.includes("/verify-email?token="));

    if (!entry) {
      throw new Error(`no verification email for ${email}`);
    }

    return new URL(entry.html.match(/href="([^"]+)"/)?.[1] as string).searchParams.get(
      "token",
    ) as string;
  };

  const resetTokenFor = (email: string): string => {
    const entry = [...outbox.outbox]
      .reverse()
      .find((item) => item.to === email && item.html.includes("/reset-password?token="));

    if (!entry) {
      throw new Error(`no reset email for ${email}`);
    }

    return new URL(entry.html.match(/href="([^"]+)"/)?.[1] as string).searchParams.get(
      "token",
    ) as string;
  };

  const inviteTokenFor = (email: string): string => {
    const entry = [...outbox.outbox]
      .reverse()
      .find((item) => item.to === email && item.html.includes("/invite/accept?token="));

    if (!entry) {
      throw new Error(`no invitation email for ${email}`);
    }

    return new URL(entry.html.match(/href="([^"]+)"/)?.[1] as string).searchParams.get(
      "token",
    ) as string;
  };

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "paylens",
        POSTGRES_PASSWORD: "paylens",
        POSTGRES_USER: "paylens",
      })
      .withExposedPorts(5432)
      .start();

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = `postgresql://paylens:paylens@${postgres.getHost()}:${postgres.getMappedPort(5432)}/paylens`;
    process.env.REDIS_URL = process.env.AUTH_E2E_REDIS_URL as string;
    process.env.CORS_ORIGINS = "http://localhost:3000";
    process.env.FRONTEND_URL = "http://localhost:3000";
    process.env.EXECUTION_TRACE_ENABLED = "true";
    // Deterministic provider posture: Google disabled here (enabled-path redirect
    // is covered by the controller spec + live smoke).
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    process.env.GOOGLE_CALLBACK_URL = "";

    execSync("npx prisma migrate deploy", {
      cwd: new URL("../../../..", import.meta.url).pathname,
      env: process.env,
      stdio: "pipe",
    });

    const { createApplication } = await import("@/application.js");

    app = await createApplication();
    await app.init();
    outbox = app.get(EmailService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    process.env = originalEnvironment;
  });

  it("registers, verifies once, and rejects verification replay", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Acme Industries",
        firstName: "Asha",
        lastName: "Sharma",
        email: "owner@acme.example",
        password: "correct horse battery staple",
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.data.user.email).toBe("owner@acme.example");
        expect(body.data.organization.slug).toBe("acme-industries");
        expect(body.data).not.toHaveProperty("session");
      });

    // Correct password but unverified email stays locked out with a stable code.
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "correct horse battery staple" })
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("EMAIL_NOT_VERIFIED");
      });

    const token = verificationTokenFor("owner@acme.example");
    const agent = request.agent(app.getHttpServer());

    await agent.post("/api/v1/auth/verify-email").send({ token }).expect(200);

    await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("EMAIL_VERIFICATION_TOKEN_INVALID");
      });
  });

  it("logs in, bootstraps /me, and enforces tenant isolation", async () => {
    const agent = request.agent(app.getHttpServer());

    await agent
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "correct horse battery staple" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.memberships).toHaveLength(1);
      });

    const me = await agent.get("/api/v1/auth/me").expect(200);

    expect(me.body.data.activeOrganization.slug).toBe("acme-industries");
    expect(me.body.data.user.passwordHash).toBeUndefined();

    const members = await agent.get("/api/v1/organizations/current/members").expect(200);

    expect(members.body.data).toHaveLength(1);

    // A second tenant cannot touch the first one.
    await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        organizationName: "Rival Corp",
        firstName: "Ravi",
        lastName: "Verma",
        email: "rival@example.com",
        password: "correct horse battery staple",
      })
      .expect(201);

    const rivalToken = verificationTokenFor("rival@example.com");
    const rival = request.agent(app.getHttpServer());

    await rival.post("/api/v1/auth/verify-email").send({ token: rivalToken }).expect(200);
    await rival
      .post("/api/v1/auth/switch-organization")
      .send({ organizationId: me.body.data.activeOrganization.id })
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("MEMBERSHIP_REQUIRED");
      });
  });

  it("rotates refresh tokens and revokes the session on reuse", async () => {
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "correct horse battery staple" })
      .expect(200);

    const issued = login.headers["set-cookie"] as unknown as string[];
    const issuedRefresh = issued.find((cookie) => cookie.startsWith("paylens_rt=")) as string;

    const rotated = await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .set("Cookie", issued)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.refreshed).toBe(true);
      });

    const rotatedCookies = rotated.headers["set-cookie"] as unknown as string[];
    const rotatedAccess = rotatedCookies.find((cookie) =>
      cookie.startsWith("paylens_at="),
    ) as string;

    expect(rotatedCookies.find((cookie) => cookie.startsWith("paylens_rt="))).not.toBe(
      issuedRefresh,
    );

    // Replay the pre-rotation refresh secret: possible replay → session revoked.
    await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .set("Cookie", [issuedRefresh])
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.refreshed).toBe(false);
      });

    await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Cookie", [rotatedAccess])
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe("SESSION_REVOKED");
      });
  });

  it("resets passwords with single-use tokens and revokes every session", async () => {
    const agent = request.agent(app.getHttpServer());

    await agent
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "correct horse battery staple" })
      .expect(200);

    await request(app.getHttpServer())
      .post("/api/v1/auth/forgot-password")
      .send({ email: "owner@acme.example" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.message).toContain("If an eligible account exists");
      });

    // Unknown emails receive the identical response (no enumeration oracle).
    const unknown = await request(app.getHttpServer())
      .post("/api/v1/auth/forgot-password")
      .send({ email: "ghost@example.com" })
      .expect(200);

    expect(unknown.body.data.message).toContain("If an eligible account exists");

    const token = resetTokenFor("owner@acme.example");

    await request(app.getHttpServer())
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "another correct horse battery" })
      .expect(200);

    await request(app.getHttpServer())
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "another correct horse battery" })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("PASSWORD_RESET_TOKEN_INVALID");
      });

    // Password reset revoked every session: the pre-reset access cookie is dead.
    await agent.get("/api/v1/auth/me").expect(401);

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "correct horse battery staple" })
      .expect(401);

    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "another correct horse battery" })
      .expect(200);
  });

  it("onboards invited members and guards role boundaries", async () => {
    const owner = request.agent(app.getHttpServer());

    await owner
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "another correct horse battery" })
      .expect(200);

    // HR_ADMIN cannot be created by nobody: owner invites one first.
    const invite = await owner
      .post("/api/v1/organizations/current/invitations")
      .send({ email: "admin@acme.example", role: "HR_ADMIN" })
      .expect(201);

    expect(invite.body.data.email).toBe("admin@acme.example");

    const preview = await request(app.getHttpServer())
      .get("/api/v1/auth/invitations/preview")
      .query({ token: inviteTokenFor("admin@acme.example") })
      .expect(200);

    expect(preview.body.data.organization.name).toBe("Acme Industries");

    const admin = request.agent(app.getHttpServer());

    await admin
      .post("/api/v1/auth/invitations/accept")
      .send({
        token: inviteTokenFor("admin@acme.example"),
        firstName: "Admin",
        lastName: "User",
        password: "correct horse battery staple",
      })
      .expect(201);

    const adminMe = await admin.get("/api/v1/auth/me").expect(200);

    expect(adminMe.body.data.user.emailVerified).toBe(true);

    // HR_ADMIN may invite HR_MANAGER but never TENANT_OWNER.
    await admin
      .post("/api/v1/organizations/current/invitations")
      .send({ email: "manager@acme.example", role: "HR_MANAGER" })
      .expect(201);

    await admin
      .post("/api/v1/organizations/current/invitations")
      .send({ email: "sneaky@acme.example", role: "TENANT_OWNER" })
      .expect(403)
      .expect(({ body }) => {
        expect(body.code).toBe("INSUFFICIENT_PERMISSION");
      });
  });

  it("supports organization switching, logout, and Google-disabled behavior", async () => {
    const owner = request.agent(app.getHttpServer());

    await owner
      .post("/api/v1/auth/login")
      .send({ email: "owner@acme.example", password: "another correct horse battery" })
      .expect(200);

    const created = await owner
      .post("/api/v1/organizations")
      .send({ name: "Second Venture" })
      .expect(201);

    expect(created.body.data.organization.slug).toBe("second-venture");

    await owner
      .post("/api/v1/auth/switch-organization")
      .send({ organizationId: created.body.data.organization.id })
      .expect(200)
      .expect(({ body }) => {
        // Cookie-only model: fresh JWT in HttpOnly cookie, never in JSON.
        expect(body.data).not.toHaveProperty("accessToken");
        expect(body.data.activeOrganization.slug).toBe("second-venture");
      });

    const me = await owner.get("/api/v1/auth/me").expect(200);

    expect(me.body.data.activeOrganization.slug).toBe("second-venture");

    await owner.post("/api/v1/auth/logout").expect(200);
    await owner.get("/api/v1/auth/me").expect(401);
    // Logout stays idempotent after the session is already gone.
    await owner.post("/api/v1/auth/logout").expect(200);

    await request(app.getHttpServer())
      .get("/api/v1/auth/providers")
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual({ google: false });
      });

    await request(app.getHttpServer())
      .get("/api/v1/auth/google/start")
      .expect(404)
      .expect(({ body }) => {
        expect(body.code).toBe("GOOGLE_AUTH_DISABLED");
      });
  });
});
