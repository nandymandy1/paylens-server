import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function packageVersion(packageName: string): string {
  let directory = dirname(require.resolve(packageName));

  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = join(directory, "package.json");

    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version: string;
      };

      if (parsed.name === packageName) return parsed.version;
    }

    directory = dirname(directory);
  }

  throw new Error(`Could not resolve ${packageName} package version`);
}

describe("Prisma instrumentation compatibility", () => {
  it("keeps instrumentation on the installed Prisma Client version", () => {
    expect(packageVersion("@prisma/instrumentation")).toBe(packageVersion("@prisma/client"));
  });
});
