import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string, file = "index.ts") => fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

// Tests import workspace packages from source, so `pnpm test` needs no build first.
const alias = [
  { find: /^@tapdance\/core$/, replacement: src("core") },
  { find: /^@tapdance\/provider-simlock$/, replacement: src("provider-simlock") },
  { find: /^@tapdance\/sdk\/testing$/, replacement: src("sdk", "testing.ts") },
  { find: /^@tapdance\/sdk$/, replacement: src("sdk") },
  { find: /^@tapdance\/mcp$/, replacement: src("mcp") },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
          // Many CLI tests start the built CLI several times. Hosted CI runners (the release workflow's
          // macOS runner) are slower than a developer's Mac, so vitest's 5 s default is too tight there.
          testTimeout: process.env["CI"] ? 60_000 : 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.integration.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
