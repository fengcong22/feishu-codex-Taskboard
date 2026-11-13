import { defineConfig } from "vitest/config";

// Component tests are discovered by pattern so new *.test.tsx files run automatically.
// Node-side tests under test/ use `node --test` and are intentionally not included here.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      // Known failing since the upstream Taskboard import (d7d3592) and never part of the
      // previous hand-maintained list: 7/8 completion-menu cases fail. Remove this entry
      // once the test or InlineMediaComposer is fixed.
      "web/src/components/InlineMediaComposer.test.tsx",
    ],
  },
});
