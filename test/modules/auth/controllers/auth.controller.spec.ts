import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "@/modules/auth/controllers/auth.controller.js";

const createController = () => {
  const auth = {
    switchOrganization: vi.fn(async () => ({
      activeOrganization: { id: "org-1", name: "Acme", slug: "acme" },
      activeMembership: { id: "membership-1", role: "TENANT_OWNER", status: "ACTIVE" },
    })),
  };
  const sessions = {
    getSession: vi.fn(async () => ({ sessionId: "session-1", userId: "user-1" })),
    accessTokenFor: vi.fn(() => "fresh-jwt"),
  };
  const invitations = {};
  const google = {
    start: vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc" })),
  };
  const audit = {};
  const config = {
    getOrThrow: (key: string) => {
      const values: Record<string, unknown> = {
        "app.authCookieSecure": false,
        "app.authCookieSameSite": "lax",
        "app.authCookieDomain": "",
        "app.authAccessTtlSeconds": 900,
        "app.frontendUrl": "http://localhost:3000",
      };

      return values[key];
    },
  };

  const controller = new AuthController(
    auth as never,
    sessions as never,
    invitations as never,
    google as never,
    audit as never,
    config as never,
  );

  return { controller, auth, sessions, google };
};

describe("AuthController transport", () => {
  let harness: ReturnType<typeof createController>;

  beforeEach(() => {
    harness = createController();
  });

  it("redirects Google start to the provider instead of returning JSON", async () => {
    const { controller, google } = harness;
    const redirect = vi.fn();
    const result = await controller.googleStart(undefined, undefined, { redirect } as never);

    expect(google.start).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(result).toBeUndefined();
  });

  it("keeps the switched access token in the HttpOnly cookie, out of JSON", async () => {
    const { controller, sessions } = harness;
    const cookie = vi.fn();
    const principal = {
      userId: "user-1",
      sessionId: "session-1",
      organizationId: "org-1",
      membershipId: "membership-1",
      role: "TENANT_OWNER",
    } as never;
    const req = { requestId: "req-1", headers: {}, principal } as never;

    const result = await controller.switchOrganization(
      principal,
      { organizationId: "org-1" },
      req,
      { cookie } as never,
    );

    expect(result).not.toHaveProperty("accessToken");
    expect(result).toHaveProperty("activeOrganization");
    expect(cookie).toHaveBeenCalledOnce();
    expect(cookie.mock.calls[0][0]).toBe("paylens_at");
    expect(cookie.mock.calls[0][1]).toBe("fresh-jwt");
    expect(sessions.accessTokenFor).toHaveBeenCalledOnce();
  });
});
