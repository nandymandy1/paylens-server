import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: "./",
    include: ["test/integration/**/*.integration-spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
