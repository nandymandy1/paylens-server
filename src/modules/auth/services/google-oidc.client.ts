import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import type { GoogleProfile } from "@/modules/auth/types/auth.types.js";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

@Injectable()
export class GoogleOidcClient {
  private client: OAuth2Client | null = null;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return (
      this.config.getOrThrow<string>("app.googleClientId") !== "" &&
      this.config.getOrThrow<string>("app.googleClientSecret") !== "" &&
      this.config.getOrThrow<string>("app.googleCallbackUrl") !== ""
    );
  }

  private getClient(): OAuth2Client {
    if (!this.client) {
      this.client = new OAuth2Client(
        this.config.getOrThrow<string>("app.googleClientId"),
        this.config.getOrThrow<string>("app.googleClientSecret"),
        this.config.getOrThrow<string>("app.googleCallbackUrl"),
      );
    }

    return this.client;
  }

  generateAuthUrl(state: string, nonce: string): string {
    return this.getClient().generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state,
      nonce,
    });
  }

  async exchangeCode(code: string): Promise<string> {
    const { tokens } = await this.getClient().getToken(code);

    if (!tokens.id_token) {
      throw new Error("Google did not return an ID token");
    }

    return tokens.id_token;
  }

  async verifyIdToken(idToken: string, expectedNonce: string): Promise<GoogleProfile> {
    const ticket = await this.getClient().verifyIdToken({
      idToken,
      audience: this.config.getOrThrow<string>("app.googleClientId"),
    });
    const payload = ticket.getPayload() as (TokenPayload & { nonce?: string }) | undefined;

    if (
      !payload ||
      !payload.sub ||
      !payload.email ||
      !payload.iss ||
      !GOOGLE_ISSUERS.has(payload.iss)
    ) {
      throw new Error("Google ID token failed validation");
    }

    if (payload.nonce !== expectedNonce) {
      throw new Error("Google ID token nonce mismatch");
    }

    const emailVerified = payload.email_verified === true;

    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified,
      firstName: payload.given_name ?? payload.name?.split(" ")[0] ?? "PayLens",
      lastName: payload.family_name ?? payload.name?.split(" ").slice(1).join(" ") ?? "User",
    };
  }
}
