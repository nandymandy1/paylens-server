-- H6 multi-tenant identity + auth schema.
-- Creates enums and tables for users, organizations, memberships,
-- OAuth identities, action tokens, invitations, and audit events.

-- Enums
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "MembershipRole" AS ENUM ('TENANT_OWNER', 'HR_ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE', 'VIEWER_AUDITOR');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');
CREATE TYPE "AuthActionTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');
CREATE TYPE "AuthAuditAction" AS ENUM ('USER_REGISTERED', 'EMAIL_VERIFIED', 'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'GOOGLE_ACCOUNT_LINKED', 'ORGANIZATION_CREATED', 'INVITATION_CREATED', 'INVITATION_ACCEPTED', 'INVITATION_REVOKED', 'MEMBERSHIP_ROLE_CHANGED', 'SESSION_REVOKED');

-- User
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "emailVerifiedAt" TIMESTAMP(3),
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_status_idx" ON "User"("status");

-- Organization
CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- OrganizationMembership
CREATE TABLE "OrganizationMembership" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");
CREATE INDEX "OrganizationMembership_organizationId_status_idx" ON "OrganizationMembership"("organizationId", "status");

-- OAuthIdentity
CREATE TABLE "OAuthIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "OAuthProvider" NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "providerEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OAuthIdentity_provider_providerSubject_key" ON "OAuthIdentity"("provider", "providerSubject");
CREATE UNIQUE INDEX "OAuthIdentity_userId_provider_key" ON "OAuthIdentity"("userId", "provider");
CREATE INDEX "OAuthIdentity_provider_providerEmail_idx" ON "OAuthIdentity"("provider", "providerEmail");

-- AuthActionToken
CREATE TABLE "AuthActionToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "AuthActionTokenType" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AuthActionToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthActionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AuthActionToken_tokenHash_key" ON "AuthActionToken"("tokenHash");
CREATE INDEX "AuthActionToken_userId_type_idx" ON "AuthActionToken"("userId", "type");
CREATE INDEX "AuthActionToken_expiresAt_idx" ON "AuthActionToken"("expiresAt");

-- OrganizationInvitation
CREATE TABLE "OrganizationInvitation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "invitedByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrganizationInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");
CREATE INDEX "OrganizationInvitation_organizationId_acceptedAt_idx" ON "OrganizationInvitation"("organizationId", "acceptedAt");
CREATE INDEX "OrganizationInvitation_expiresAt_idx" ON "OrganizationInvitation"("expiresAt");

-- AuthAuditEvent
CREATE TABLE "AuthAuditEvent" (
  "id" TEXT NOT NULL,
  "action" "AuthAuditAction" NOT NULL,
  "actorUserId" TEXT,
  "targetUserId" TEXT,
  "organizationId" TEXT,
  "requestId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AuthAuditEvent_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AuthAuditEvent_action_createdAt_idx" ON "AuthAuditEvent"("action", "createdAt");
CREATE INDEX "AuthAuditEvent_actorUserId_idx" ON "AuthAuditEvent"("actorUserId");
CREATE INDEX "AuthAuditEvent_organizationId_idx" ON "AuthAuditEvent"("organizationId");
