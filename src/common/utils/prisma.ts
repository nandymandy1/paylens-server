import { Prisma } from "@prisma/client";

/**
 * Canonical Prisma error-shape predicates.
 * These identify storage shape only; domain error translation stays in features.
 */

/** True when a Prisma unique violation names the expected tenant-unique field. */
export const isPrismaUniqueViolationOn = (error: unknown, field: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  (error.meta.target as unknown[]).includes(field);

/** True for relation-restriction violations (e.g. concurrent delete races). */
export const isPrismaRelationViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === "P2003" || error.code === "P2014");
