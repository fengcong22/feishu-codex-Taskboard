# Windows CI Path Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows CI test fixtures compare equivalent Windows paths and use the runner's actual Node executable without changing Bridge, Taskboard, or process-stop behavior.

**Architecture:** Keep production path and process validation unchanged because the launcher already resolves repository paths and the stop script must verify exact process identity. Normalize only test fixture paths and expected executable values at the test boundary, where GitHub Windows runners may expose 8.3 aliases or install Node at a runner-specific location.

**Tech Stack:** Node.js `node:test`, `node:fs/promises`, PowerShell process fixtures, GitHub Actions on `windows-latest`.

## Global Constraints

- Do not change event filtering, task routing, credentials, ports, startup behavior, or production process identity semantics.
- Preserve the repository's Windows-only local verification workflow and existing test coverage.
- Do not add credentials, runtime state, or machine-specific paths to Git.

---

### Task 1: Normalize Windows test fixture paths and process fixtures

**Files:**
- Modify: `taskboard/test/autocut-local-runner.test.mjs:2,109`
- Modify: `taskboard/test/task-start-flow.test.mjs:2913`
- Modify: `test/startup-scripts.test.mjs` fixture path and executable construction used by the stop tests

**Interfaces:**
- Consumes: existing temporary-directory fixtures and PowerShell process mocks.
- Produces: equivalent path assertions and process command lines regardless of 8.3 path aliases or the Node installation path on the runner.

- [x] **Step 1: Add the smallest path-normalization assertions/fixtures.**

  Use `realpath` for existing runtime/workspace directories before comparing them or embedding them in fake process command lines, and use `process.execPath` for fake Node process identities. Keep marker-file paths and cleanup behavior unchanged.

- [x] **Step 2: Run the affected tests before the production/test adjustment.**

  GitHub Actions run `34421823580` supplied the red CI evidence: the runner exposed short `C:\Users\RUNNER~1` paths while PowerShell returned long `C:\Users\runneradmin` paths. The local machine does not expose that alias, so its pre-fix focused run passed.

- [x] **Step 3: Apply the minimal test-only normalization.**

  Canonicalize only the paths used in strict path assertions and PowerShell process command-line identity comparisons; use the current test process executable instead of a hard-coded Node path. Do not loosen production identity matching.

- [x] **Step 4: Run the affected tests again.**

  Run the same command after both changes: 97 tests passed, 0 failed; the standalone startup suite also passed 47/47.

- [x] **Step 5: Run the complete verification gate.**

  Run `npm test` from `D:\codex\codex-feishu`: exit code 0; 1397 Node tests (1394 passed, 3 skipped), typecheck passed, web build passed, and 13 component tests passed.

- [x] **Step 6: Review and commit.**

  `git diff --check` is clean apart from expected line-ending normalization notices. Focused review found no scope or correctness issues; commit the test-only change with `test: normalize Windows CI fixture paths`.
