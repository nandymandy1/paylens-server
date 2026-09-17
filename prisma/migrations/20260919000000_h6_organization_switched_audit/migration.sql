-- H6-R3: dedicated audit event for organization switches.
-- Previously mislabeled as SESSION_REVOKED with reason organization-switch.
ALTER TYPE "AuthAuditAction" ADD VALUE IF NOT EXISTS 'ORGANIZATION_SWITCHED';
