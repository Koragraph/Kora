import { defineConfig } from "vite-plus";
import "vite-plus/test/config";

const unitTests = ["src/**/*.test.ts"];

export default defineConfig({
  test: {
    include: unitTests,
    setupFiles: ["../shared/src/testing/deepTempDir.ts"],
    environment: "node",
  },
});
