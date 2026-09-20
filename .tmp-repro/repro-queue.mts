import "dotenv/config";
import { Queue } from "bullmq";

const queue = new Queue("employee-import", {
  connection: { url: process.env.REDIS_URL as string, maxRetriesPerRequest: null },
});

try {
  const job = await queue.add(
    "employee-import-validate",
    { importId: "repro-fake-id", organizationId: "repro-org", requestedByUserId: "repro-user" },
    {
      jobId: "repro-fake-id:validate",
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
    },
  );
  console.log("QUEUE_ADD_OK:", JSON.stringify({ id: job.id, name: job.name }));
  await job.remove().catch(() => undefined);
  console.log("CLEANED");
} catch (error) {
  console.log(
    "QUEUE_ADD_THREW:",
    JSON.stringify({ name: (error as Error)?.name, message: (error as Error)?.message }),
  );
}
await queue.close();
process.exit(0);
