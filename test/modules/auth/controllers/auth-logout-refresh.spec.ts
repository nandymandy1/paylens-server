import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  SESSION_HINT_COOKIE_NAME,
} from "@/modules/auth/constants/auth.constants.js";
import { AuthController } from "@/modules/auth/controllers/auth.controller.js";

const createController = () => {
  const auth = { revalidateSessionTenant: vi.fn(async (record) => record) };
  const sessions = {
    revokeSession: vi.fn(async () => undefined),
    refresh: vi.fn(),
    accessTokenFor: vi.fn((record) => record.accessToken ?? "fresh-access"),
  };
  const invitations = {};
  const google = {};
  const audit = { record: vi.fn(async () => undefined) };
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

  const res = { cookie: vi.fn(), clearCookie: vi.fn() };

  return { controller, sessions, audit, res };
};

const clearedNames = (res: { clearCookie: ReturnType<typeof vi.fn> }): string[] =>
  res.clearCookie.mock.calls.map(([name]) => name as string);

describe("AuthController logout/refresh closure", () => {
  let harness: ReturnType<typeof createController>;

  beforeEach(() => {
    harness = createController();
  });

  it("revokes the Redis session and clears every auth cookie on logout", async () => {
    const { controller, sessions, audit, res } = harness;
    const req = {
      requestId: "req-1",
      headers: {},
      cookies: { [REFRESH_COOKIE_NAME]: "session-1.secret" },
    } as never;

    await expect(controller.logout(req, res as never)).resolves.toEqual({ loggedOut: true });

    expect(sessions.revokeSession).toHaveBeenCalledWith("session-1");
    expect(audit.record).toHaveBeenCalledWith("LOGOUT", { requestId: "req-1" });
    expect(clearedNames(res)).toEqual(
      expect.arrayContaining([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_HINT_COOKIE_NAME]),
    );
    // Cookie deletion reuses the centralized creation scope (path/domain).
    for (const [, options] of res.clearCookie.mock.calls as [string, Record<string, unknown>][]) {
      expect(options.path).toBe("/");
      expect(options).not.toHaveProperty("domain");
    }

    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("keeps logout idempotent without a refresh cookie", async () => {
    const { controller, sessions, res } = harness;
    const req = { requestId: "req-2", headers: {}, cookies: {} } as never;

    await expect(controller.logout(req, res as never)).resolves.toEqual({ loggedOut: true });

    expect(sessions.revokeSession).not.toHaveBeenCalled();
    expect(clearedNames(res)).toEqual(
      expect.arrayContaining([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_HINT_COOKIE_NAME]),
    );
  });

  it("returns an idempotent no-op refresh without issuing cookies when no credential is presented", async () => {
    const { controller, sessions, res } = harness;
    const req = { requestId: "req-3", headers: {}, cookies: {} } as never;

    await expect(controller.refresh(req, res as never)).resolves.toEqual({ refreshed: false });

    expect(sessions.refresh).not.toHaveBeenCalled();
    expect(clearedNames(res)).toEqual(
      expect.arrayContaining([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_HINT_COOKIE_NAME]),
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("cannot restore authentication with a pre-logout refresh credential", async () => {
    const { controller, sessions, res } = harness;

    sessions.refresh.mockRejectedValueOnce(
      Object.assign(new Error("Refresh session is no longer valid."), {
        code: "REFRESH_TOKEN_INVALID",
      }),
    );
    const req = {
      requestId: "req-4",
      headers: {},
      cookies: { [REFRESH_COOKIE_NAME]: "session-1.stale-secret" },
    } as never;

    await expect(controller.refresh(req, res as never)).resolves.toEqual({ refreshed: false });

    expect(sessions.refresh).toHaveBeenCalledWith("session-1", "stale-secret");
    // No valid new access cookie, no resurrected session: cookies are cleared,
    // never reissued.
    expect(res.cookie).not.toHaveBeenCalled();
    expect(clearedNames(res)).toEqual(
      expect.arrayContaining([ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_HINT_COOKIE_NAME]),
    );
  });

  it("reissues scoped cookies only for a valid live refresh", async () => {
    const { controller, res } = harness;

    harness.sessions.refresh.mockResolvedValueOnce({
      record: { sessionId: "session-1" },
      accessToken: "fresh-access",
      refreshToken: "session-1.next-secret",
    });
    const req = {
      requestId: "req-5",
      headers: {},
      cookies: { [REFRESH_COOKIE_NAME]: "session-1.live-secret" },
    } as never;

    await expect(controller.refresh(req, res as never)).resolves.toEqual({ refreshed: true });

    expect(res.cookie).toHaveBeenCalledWith(
      ACCESS_COOKIE_NAME,
      "fresh-access",
      expect.objectContaining({ path: "/" }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      "session-1.next-secret",
      expect.objectContaining({ path: "/" }),
    );
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
});
