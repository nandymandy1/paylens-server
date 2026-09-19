import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { ACCESS_TOKEN_TTL_SECONDS } from "@/modules/auth/constants/auth.constants.js";
import { AuthController } from "@/modules/auth/controllers/auth.controller.js";
import { OptionalSessionGuard, SessionGuard } from "@/modules/auth/guards/session.guard.js";
import { AuditService } from "@/modules/auth/services/audit.service.js";
import { AuthService } from "@/modules/auth/services/auth.service.js";
import { GoogleOidcClient } from "@/modules/auth/services/google-oidc.client.js";
import { GoogleService } from "@/modules/auth/services/google.service.js";
import { InvitationService } from "@/modules/auth/services/invitation.service.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import { SessionService } from "@/modules/auth/services/session.service.js";

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("app.authAccessTokenSecret"),
        signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuditService,
    PasswordService,
    SessionService,
    InvitationService,
    GoogleOidcClient,
    GoogleService,
    SessionGuard,
    OptionalSessionGuard,
  ],
  exports: [
    JwtModule,
    AuthService,
    AuditService,
    InvitationService,
    SessionService,
    SessionGuard,
    OptionalSessionGuard,
    GoogleService,
  ],
})
export class AuthModule {}
