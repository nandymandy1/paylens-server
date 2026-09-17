import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";

export type RequestPrincipal = {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  membershipId: string | null;
  role: MembershipRoleName | null;
};

export type SessionRecord = {
  sessionId: string;
  userId: string;
  activeOrganizationId: string | null;
  activeMembershipId: string | null;
  role: MembershipRoleName | null;
  refreshTokenHash: string;
  createdAt: string;
  lastRefreshedAt: string;
  absoluteExpiresAt: string;
  userAgentHash: string | null;
};

export type SafeUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  status: string;
};

export type SafeMembership = {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: MembershipRoleName;
  status: string;
};

export type OAuthStateRecord = {
  nonce: string;
  redirectTo: string;
  invitationId: string | null;
  createdAt: string;
};

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
};
