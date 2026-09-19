CREATE TABLE "MutationIdempotency" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "operation" VARCHAR(80) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "resourceId" TEXT,
  "responseStatus" INTEGER NOT NULL DEFAULT 200,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MutationIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MutationIdempotency_organizationId_operation_idempotencyKey_key"
  ON "MutationIdempotency"("organizationId", "operation", "idempotencyKey");
CREATE INDEX "MutationIdempotency_organizationId_operation_createdAt_idx"
  ON "MutationIdempotency"("organizationId", "operation", "createdAt");

ALTER TABLE "MutationIdempotency"
  ADD CONSTRAINT "MutationIdempotency_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
