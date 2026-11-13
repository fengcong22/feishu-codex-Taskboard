import { defineConfig } from "vitest/config";

// Component tests are discovered by pattern so new *.test.tsx files run automatically.
// Node-side tests under test/ use `node --test` and are intentionally not included here.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
  },
});
