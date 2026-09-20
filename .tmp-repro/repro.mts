import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { S3CompatibleStorageProvider } from "/Users/narendramaurya/Projects/paylens/paylens-server/src/storage/providers/s3-compatible-storage.provider.js";

const importId = process.argv[2] ?? "cmu9q25ji000h0tt2jx1t0lww";

const prisma = new PrismaClient();
const row = await prisma.employeeImport.findUnique({ where: { id: importId } });
if (!row) {
  console.log("IMPORT_ROW: not found");
} else {
  console.log(
    JSON.stringify(
      {
        status: row.status,
        format: row.format,
        sourceObjectKey: row.sourceObjectKey,
        originalFileName: row.originalFileName,
        createdAt: row.createdAt,
      },
      null,
      2,
    ),
  );
}

const provider = new S3CompatibleStorageProvider({
  bucket: process.env.FILE_STORAGE_BUCKET as string,
  region: process.env.FILE_STORAGE_REGION as string,
  endpoint: process.env.FILE_STORAGE_ENDPOINT as string,
  accessKeyId: process.env.FILE_STORAGE_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.FILE_STORAGE_SECRET_ACCESS_KEY as string,
});

if (row) {
  for (const fn of ["exists", "head"] as const) {
    try {
      const out = await provider[fn](row.sourceObjectKey);
      console.log(`${fn.toUpperCase()}_OK:`, JSON.stringify(out));
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      const meta = (err["$metadata"] ?? {}) as Record<string, unknown>;
      console.log(
        `${fn.toUpperCase()}_THREW:`,
        JSON.stringify({
          name: err["name"],
          code: err["Code"] ?? err["code"],
          httpStatus: meta["httpStatusCode"],
        }),
      );
    }
  }
}

await prisma.$disconnect();
process.exit(0);
