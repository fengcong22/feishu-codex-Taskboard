# Feishu Bridge Operations Hardening Implementation Plan

> **For agentic workers:** Implement each task with a red-green-refactor cycle and verify the complete local flow after every integration boundary.

**Goal:** 固化已验证的飞书→Bridge→Taskboard链路，提供团队可复现的运行规范和只读健康检查入口。

**Architecture:** 保持现有事件处理代码不变，在仓库根目录增加单一 `AGENTS.md` 作为运行规范；用一个 PowerShell 5 兼容的 `check-local.ps1` 调用现有配置加载器和两个 loopback 健康接口。检查脚本只读、不创建任务、不输出凭据，并通过 `-RequireFeishu` 控制是否把长连接状态作为硬性条件。

**Tech Stack:** PowerShell 5+, Node.js >=22.5, native `node:test`, existing Bridge HTTP health endpoints.

## Global Constraints

- 两个服务仅允许绑定 `127.0.0.1`。
- `config/bridge.local.json`、`.env.local` 和 `.runtime/` 不得提交。
- 检查脚本不得读取或打印密钥，也不得停止进程或修改状态。
- 本轮不改变事件筛选、去重、任务创建和 SDK 连接行为。

---

### Task 1: Add failing operations-contract tests

**Files:**
- Create: `test/operations-hardening.test.mjs`
- Read: `scripts/check-local.ps1`, `AGENTS.md`, `README.md`

- [ ] **Step 1: Write tests for the required script and documentation contract**

  Assert that the check script contains the `-RequireFeishu` switch, Node-version/config checks, both loopback health URLs, `Invoke-RestMethod`, non-zero failure paths, and no command that reads `.env.local`. Assert that PowerShell can parse it. Assert that root `AGENTS.md` documents the fixed flow, loopback boundary, alias whitelist, idempotency, secret handling, and required commands.

- [ ] **Step 2: Run the targeted test and verify the expected failure**

  Run: `npm test -- test/operations-hardening.test.mjs`
  Expected: FAIL because `scripts/check-local.ps1` and root `AGENTS.md` do not yet exist.

### Task 2: Implement the read-only local health check

**Files:**
- Create: `scripts/check-local.ps1`

- [ ] **Step 1: Implement the minimum contract**

  Resolve the repository root, require Node `>=22.5`, load and validate `config/bridge.local.json` through `src/config.mjs`, query Taskboard `/api/meta` and Bridge `/health`, print sanitized statuses, and fail with a non-zero exit code on required-check failures. Treat a disconnected listener as a warning unless `-RequireFeishu` is supplied.

- [ ] **Step 2: Run the targeted tests and verify they pass**

  Run: `npm test -- test/operations-hardening.test.mjs`
  Expected: PASS, including PowerShell 5 parsing.

### Task 3: Add the team operating contract and handoff instructions

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Document the immutable flow and safe change rules**

  Document startup, health check, simulation, real-listener mode, shutdown, configuration boundaries, idempotency, manual-mode limits, secret handling, and the requirement that behavior changes include tests and review.

- [ ] **Step 2: Add a clean-machine handoff checklist to README**

  Link to `AGENTS.md`, show `check-local.ps1` with and without `-RequireFeishu`, and state the expected success criteria for simulation and replay.

- [ ] **Step 3: Re-run the targeted contract test**

  Run: `npm test -- test/operations-hardening.test.mjs`
  Expected: PASS.

### Task 4: Verify the integrated workflow

- [ ] **Step 1: Run the complete test suite**

  Run: `npm test`
  Expected: all tests pass with zero failures.

- [ ] **Step 2: Run the read-only check against the currently running local stack**

  Run: `./scripts/check-local.ps1` and, when the real listener is intentionally enabled, `./scripts/check-local.ps1 -RequireFeishu`.
  Expected: zero exit code; output contains only loopback URLs, counts, and listener status.

- [ ] **Step 3: Re-run the deterministic simulation**

  Run: `./scripts/simulate-ready.ps1`.
  Expected: the fixed event is reported as a duplicate and no second task is created.
