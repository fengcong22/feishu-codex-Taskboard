# Windows Launcher Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Windows Git scan consoles from closing Taskboard context menus and recover automatically from a stale `CODEX_EXECUTABLE` override.

**Architecture:** Keep the Git scan flow unchanged and add the Windows child-process option at its three call sites. Extract Codex discovery into one PowerShell function whose ordered candidates can be exercised independently by the existing AST-based startup tests. Restrict npm vendor fallback to the current Windows process architecture. Document stop/update/start for already-running services.

**Tech Stack:** Node.js test runner, Node child processes, PowerShell, React Taskboard server/UI.

## Global Constraints

- Preserve loopback-only listeners and all Bridge/Taskboard trust boundaries.
- Do not operate on Feishu records, Taskboard tasks, local state, or credentials.
- Do not commit unless the user explicitly requests it.
- Update automated tests and README for startup behavior changes.

---

### Task 1: Hide Development Scan Windows

**Files:**
- Modify: `taskboard/server/app.mjs:2350`
- Test: `taskboard/test/server.test.mjs`

**Interfaces:**
- Consumes: the existing `/api/projects/:id/development-contexts` Git scan.
- Produces: the same scan response with all three child processes launched using `windowsHide: true`.

- [x] Add a failing regression assertion covering all three Git commands.
- [x] Run the targeted Taskboard test and confirm the missing option causes failure.
- [x] Add `windowsHide: true` to `rev-parse`, `for-each-ref`, and `worktree list` calls.
- [x] Rerun the targeted test and confirm it passes.

### Task 2: Recover From Stale Codex Override

**Files:**
- Modify: `scripts/start-local.ps1:91`
- Test: `test/startup-scripts.test.mjs`
- Modify: `README.md:105`

**Interfaces:**
- Consumes: optional `CODEX_EXECUTABLE`, PATH, and approved npm vendor candidates.
- Produces: `Resolve-CodexExecutable`, returning the first existing executable path or `$null`.

- [x] Add failing PowerShell behavior tests for valid override precedence and stale override PATH fallback with a warning.
- [x] Run the targeted startup test and confirm the resolver is missing.
- [x] Implement ordered resolution, absolute filesystem normalization, and the final not-found startup failure.
- [x] Document automatic recovery and warn against persistent version-directory overrides.
- [x] Select only the native vendor architecture, including WOW64 environment handling.
- [x] Document that an already-running Taskboard needs stop/start to receive the new path; preserve existing process lifecycle behavior.
- [x] Rerun the targeted startup test and confirm it passes.

### Task 3: Verify and Review

**Files:**
- Review: all modified files

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: verified, review-ready working tree changes.

- [x] Run the two targeted test files.
- [x] Run the repository-standard test stages (`node --test --test-concurrency=1`, typecheck, build, and component tests).
- [x] Inspect `git diff --check`, the focused diff, and repository status.
- [x] Request an independent code review and resolve important findings.

Verification before the final PowerShell-only adjustments: complete serial Node suite 1504 passed, 3 skipped, 0 failed; typecheck and web build passed; component suite 35 passed. Rerun only the affected startup tests for the final resolver and architecture adjustments. Parallel Node testing previously encountered random Fetch-disallowed ports and a concurrency timeout.
