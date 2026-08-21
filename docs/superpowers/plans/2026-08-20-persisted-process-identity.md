# Persisted Process Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale PID reuse from causing the Taskboard launchers to stop the wrong same-script Node process.

**Architecture:** Preserve the existing PID files and add versioned JSON identity sidecars containing the PID and Windows process creation ticks as a decimal string. Centralized PowerShell helpers will write, read, compare, adopt, and remove markers consistently in the start and stop paths.

**Tech Stack:** Windows PowerShell 5.1, CIM `Win32_Process`, Node.js built-in test runner.

## Global Constraints

- Both services remain bound exactly to IPv4 `127.0.0.1` on ports `47823` and
  `47824`; wildcard and IPv6 listeners are not accepted as owned services.
- Runtime identity files remain under the Git-ignored `.runtime` directory.
- Legacy PID-only markers never authorize terminating a process.
- Only startup may migrate a healthy legacy process; stop remains fail-closed.
- Event routing and Feishu credential handling remain unchanged.

---

### Task 1: Lock destructive actions to persisted process identity

**Files:**
- Create: `scripts/process-identity.ps1`
- Modify: `test/startup-scripts.test.mjs`
- Modify: `scripts/start-local.ps1`
- Modify: `scripts/stop-local.ps1`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing PID files and `Win32_Process.CreationDate`
- Produces: `taskboard.process.json` and `bridge.process.json` with `pid` and `creationTicks`

- [ ] **Step 1: Write failing source-contract regression tests**

Add assertions that both scripts reference identity sidecars, persist creation
ticks, compare them before identity-bound native termination, and explicitly
handle legacy PID-only adoption without using it as destructive authorization.
Cover missing cleanup identity, wildcard listeners, post-health PID reuse,
readiness identity reuse, marker rewrites, non-leaf marker paths, and nonzero
stop results for live targets that cannot be verified.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/startup-scripts.test.mjs`

Expected: FAIL because the scripts do not yet define persisted identity
sidecars or require their creation time before stopping a process.

- [ ] **Step 3: Implement the minimal identity helpers and lifecycle changes**

In both PowerShell scripts, serialize a small JSON object with the exact PID and
UTC creation ticks. Parse it fail-closed. Compare both fields with the current
CIM process before any persisted-marker stop, and require the exact Node
executable selected by the launcher. Adopt a legacy marker only after
exact script, endpoint or mode health, and exclusive IPv4 loopback ownership
checks, followed by a same-instance CIM re-query. Remove an invalid marker only
when its identity-file snapshot is unchanged, and return nonzero after checking
all targets when a live process must be left running.

- [ ] **Step 4: Document the behavior**

Update the root-launcher paragraph to explain persistent process identity,
safe legacy adoption, and why an unverified process may be left running.

- [ ] **Step 5: Run focused verification and verify GREEN**

Run: `node --test test/startup-scripts.test.mjs`

Expected: all startup-script tests pass.

- [ ] **Step 6: Run repository and live verification**

Run PowerShell 5 parsing, `npm test`, `git diff --check`, then use
`scripts/start-local.ps1 -EnableFeishu` and
`scripts/check-local.ps1 -RequireFeishu` without changing loopback ports.

- [ ] **Step 7: Review, commit, and push**

Request an independent review of the diff, fix every Critical or Important
finding, repeat verification, commit the scoped files, and push
`codex/feishu-task-lifecycle-archive` so PR #2 updates automatically.
