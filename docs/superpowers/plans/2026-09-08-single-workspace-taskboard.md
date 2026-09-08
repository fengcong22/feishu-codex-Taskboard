# Single Workspace Taskboard Implementation Plan

> **For agentic workers:** Implement each checkbox in order and verify the direct startup path before claiming completion.

**Goal:** Make `D:\codex\codex-feishu` contain and launch the latest Taskboard and Bridge through one double-click entry.

**Architecture:** Import the current tracked Taskboard working tree into `taskboard/`; retain one runtime data directory under `.runtime/taskboard`; change launch scripts to resolve the bundled Taskboard by relative path.

**Tech Stack:** PowerShell, Node.js, React/Vite, SQLite.

## Global Constraints

- Preserve the existing `D:\codex\dashi-taskboard` directory and all current modifications.
- Do not copy `.git`, `.data`, `.runtime`, `node_modules`, `pip`, or `tmp` from the Taskboard source.
- Do not publish, deploy, or create an FEI-3 run.
- Keep Taskboard and Bridge bound to `127.0.0.1`.

### Task 1: Import the current Taskboard source

**Files:**
- Create: `taskboard/**`

- [ ] Copy all files returned by `git -C D:\codex\dashi-taskboard ls-files` from the current working tree.
- [ ] Copy `test/feishu-database-migration.test.mjs` as the only relevant untracked source file.
- [ ] Verify excluded runtime and dependency directories are absent.

### Task 2: Make the bundled Taskboard the default

**Files:**
- Modify: `scripts/start-local.ps1`
- Modify: `scripts/stop-local.ps1`
- Modify: `test/startup-scripts.test.mjs`
- Modify: `README.md`

- [ ] Update the focused startup test to require `$root\taskboard` as the sole default.
- [ ] Run that test and confirm it fails against the old external candidates.
- [ ] Replace the external default candidates with `$root\taskboard` in start and stop scripts.
- [ ] Update README setup and command examples to describe the bundled Taskboard.
- [ ] Run the focused startup test and confirm it passes.

### Task 3: Build and verify the direct path

**Files:**
- Generate: `taskboard/dist/web/**`

- [ ] Install the nested Taskboard dependencies from its lockfile.
- [ ] Run `npm run build:web` in `taskboard`.
- [ ] Run the focused migration and startup-script tests.
- [ ] Start with `scripts/start-local.ps1 -EnableFeishu`.
- [ ] Run `scripts/check-local.ps1 -RequireFeishu` and read `/api/meta` and `/health`.
- [ ] Load `http://127.0.0.1:47823` and confirm the current Taskboard surface is displayed.
