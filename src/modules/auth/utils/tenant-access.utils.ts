import type { Prisma } from "@prisma/client";

/**
 * A usable tenant always has both an active membership and an active organization.
 * Keep this predicate shared so tenant-scoped services cannot drift into checking
 * membership status alone.
 */
export const activeOrganizationWhere = () => ({ status: "ACTIVE" as const });

export const activeTenantMembershipWhere = (
  scope: Prisma.OrganizationMembershipWhereInput,
): Prisma.OrganizationMembershipWhereInput => ({
  ...scope,
  status: "ACTIVE",
  organization: activeOrganizationWhere(),
});
