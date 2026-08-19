# Feishu Bridge README Showcase Implementation Plan

> **For agentic workers:** Implement each task with a red-green-refactor cycle and verify the complete local flow after every integration boundary.

**Goal:** 将 README 改造成展示型与技术交接型兼具的项目首页。

**Architecture:** 只修改 Markdown 文档和 README 契约测试；沿用现有脚本、端口和安全边界，不新增运行时依赖或宣传图片。

**Tech Stack:** Markdown, Mermaid, Node.js native test runner.

## Global Constraints

- 不虚构自动配音、真实视频剪辑、自动导出或回写能力。
- 不提交 `.env.local`、`config/bridge.local.json` 或 `.runtime/`。
- 不修改 Bridge、Taskboard、SDK 和启动逻辑。

---

### Task 1: Add README showcase contract tests

**Files:** `test/operations-hardening.test.mjs`

- [ ] Add assertions for the project title, Mermaid flow, capability table, quick-start wording, and explicit unsupported boundaries.
- [ ] Run `npm test -- test/operations-hardening.test.mjs`; expected failure because current README lacks the new showcase sections.

### Task 2: Rewrite README presentation sections

**Files:** `README.md`

- [ ] Add the showcase header, truthful capability table, Mermaid flow, quick start, and navigation links while retaining operational details.
- [ ] Run the targeted test and confirm it passes.

### Task 3: Verify and publish

- [ ] Run `npm test` and `git diff --check`.
- [ ] Confirm no local secrets or runtime files are staged.
- [ ] Commit the README and tests, then push `main` to `origin`.

