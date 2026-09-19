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
    start: vi.fn(async () => ({
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
      state: "opaque-state",
    })),
    callback: vi.fn(async () => ({
      session: { accessToken: "access", refreshToken: "session-1.secret" },
      redirectTo: "/dashboard",
    })),
  };
  const audit = {};
  const config = {
    getOrThrow: (key: string) => {
      const values: Record<string, unknown> = {
        "app.authCookieSecure": false,
        "app.authCookieSameSite": "lax",
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
    const cookie = vi.fn();
    const result = await controller.googleStart(undefined, undefined, {
      redirect,
      cookie,
    } as never);

    expect(google.start).toHaveBeenCalledOnce();
    expect(cookie).toHaveBeenCalledOnce();
    expect(cookie.mock.calls[0][0]).toBe("paylens_oauth");
    expect(cookie.mock.calls[0][1]).toBe("opaque-state");
    expect(redirect).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(result).toBeUndefined();
  });

  it("binds the Google callback to the browser state cookie and clears it", async () => {
    const { controller, google } = harness;
    const cookie = vi.fn();
    const clearCookie = vi.fn();
    const redirect = vi.fn();
    const req = {
      requestId: "req-1",
      headers: {},
      cookies: { paylens_oauth: "opaque-state" },
    } as never;

    await controller.googleCallback("code-1", "opaque-state", req, {
      cookie,
      clearCookie,
      redirect,
    } as never);

    expect(google.callback).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "code-1",
        state: "opaque-state",
        browserState: "opaque-state",
      }),
    );
    expect(clearCookie).toHaveBeenCalledWith("paylens_oauth", expect.objectContaining({}));
    expect(cookie).toHaveBeenCalledWith("paylens_at", expect.any(String), expect.any(Object));
    expect(redirect).toHaveBeenCalledWith("http://localhost:3000/dashboard");
  });

  it("clears the OAuth cookie even when the callback fails", async () => {
    const { controller, google } = harness;
    const clearCookie = vi.fn();

    google.callback.mockRejectedValueOnce(
      Object.assign(new Error("bad"), { code: "OAUTH_STATE_INVALID" }),
    );

    await expect(
      controller.googleCallback(
        "code-1",
        "opaque-state",
        { cookies: {}, headers: {} } as never,
        {
          clearCookie,
        } as never,
      ),
    ).rejects.toThrow("bad");
    expect(clearCookie).toHaveBeenCalledWith("paylens_oauth", expect.objectContaining({}));
  });

  it("rejects anonymous invitation acceptance without registration fields", async () => {
    const { controller } = harness;
    const req = { requestId: "req-1", headers: {}, principal: null } as never;

    await expect(
      controller.acceptInvitation({ token: "tok" }, req, {} as never),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
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
