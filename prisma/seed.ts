import "../src/telemetry-bootstrap.js";

const { main } = await import("../src/seed/runner.js");
const operation =
  process.argv[2] === "verify" || process.argv[2] === "rollback" ? process.argv[2] : "seed";

main(operation).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
