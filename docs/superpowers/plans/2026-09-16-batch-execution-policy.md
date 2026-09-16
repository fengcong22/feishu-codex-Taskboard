# Windows Batch Execution Policy Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow all three double-click entry points to load their scripts under a restrictive inherited PowerShell process policy.

**Architecture:** Add `-ExecutionPolicy Bypass` before `-File` in each existing batch command. Exercise the actual batch files in temporary example projects with harmless PowerShell scripts, preserving arguments and exit codes.

**Tech Stack:** Windows batch, Windows PowerShell, Node.js test runner.

## Global Constraints

- Preserve loopback bindings, Feishu switches, automatic-execution authorization, credentials and runtime data.
- Do not persist execution-policy changes or start/stop the live services.
- Update automated tests and README; obtain an independent code review before committing and merging with the Codex discovery fix.

## Task 1: Reproduce, Fix and Verify

**Files:** `启动-Taskboard.bat`, `停止-Taskboard.bat`, `检查-Taskboard.bat`, `test/batch-launchers.test.mjs`, `README.md`.

- [x] Add a Windows behavior regression test that copies each entry into a temporary example project, inherits `PSExecutionPolicyPreference=Restricted`, and runs a harmless script reporting successful loading and received switches. Exercise both successful and failed script exits.
- [x] Run `node --test test/batch-launchers.test.mjs`; confirm the unchanged entries fail with script-loading policy errors.
- [x] Insert `-ExecutionPolicy Bypass` between `-NoProfile` and `-File` in all three entry points, preserving all other batch behavior and CRLF encoding.
- [x] Update README with process scope, the higher precedence of organization policies, and instructions to replace only these three files on the target computer.
- [x] Rerun the behavior tests, run `npm.cmd test`, and inspect `git diff --check`.
- [x] Obtain independent review and address actionable findings before reporting results.

## Verification Results

- The original three entries failed under inherited `Restricted` with `UnauthorizedAccess`; all three passed after the fix, including success/failure exit codes, Chinese/space paths and Feishu switches. Removing and restoring the fix confirmed the regression test's red/green behavior.
- `npm.cmd test`: Node suite finished with 1672 passed, 3 skipped and 1 failure (`streamed preflight completed clears its watchdog while publishing progress`, `AUTOCUT_PREFLIGHT_TIMEOUT`). The unchanged Auto-Cut timeout test and its sibling both passed on a focused rerun; the full suite was not rerun and is not claimed fully green.
- The remaining standard stages were run separately because the Node failure stopped the npm command: typecheck passed, web build passed (existing CSS pseudo-element and bundle-size warnings), component tests 92/92 passed.
- Independent read-only review found no actionable issues. `git diff --check` passed. Live services and the target deployment computer were not exercised.
