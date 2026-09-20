import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const rows = await prisma.employeeImport.findMany({
  where: { status: { in: ["QUEUED", "APPLY_QUEUED", "VALIDATING", "APPLYING", "PAUSING"] } },
  select: { id: true, status: true, originalFileName: true, validatedAt: true, createdAt: true },
  orderBy: { createdAt: "desc" },
  take: 20,
});
console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();
process.exit(0);
