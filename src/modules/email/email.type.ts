import type { MembershipRole } from "@prisma/client";

export type EmailJob =
  | {
      type: "VERIFY_EMAIL";
      to: string;
      verificationUrl: string;
    }
  | {
      type: "PASSWORD_RESET";
      to: string;
      resetUrl: string;
    }
  | {
      type: "ORGANIZATION_INVITATION";
      to: string;
      invitationUrl: string;
      organizationName: string;
      role: MembershipRole;
    };
