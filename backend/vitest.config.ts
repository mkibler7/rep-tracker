import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: [
      "test/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "test/**/*.spec.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      exclude: [
        "**/src/utils/demoSeed.ts",
        "**/src/dtos/**",
        "**/src/utils/mailer.ts",
      ],
    },
    setupFiles: ["./test/setup.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
