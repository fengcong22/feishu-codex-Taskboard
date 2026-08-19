# Feishu Bridge Operations Hardening Design

## Goal

把已经验证成功的“飞书多维表格 → 本地 SDK 长连接 → Bridge → Taskboard”链路固化为团队可复现、可检查、可交接的本地运行流程，同时保持现有事件处理行为不变。

## Scope

本轮只做运行规范和诊断入口：

- 在仓库根目录维护唯一的 `AGENTS.md`，记录固定数据流、配置约束、启动/停止方式、故障排查和变更要求。
- 增加 `scripts/check-local.ps1`，检查 Node 版本、配置文件、Taskboard 健康接口、Bridge 健康接口和监听器状态。
- 为检查脚本增加可自动运行的源代码回归测试，并更新 README 的团队交接步骤。

本轮不改变事件筛选、去重、任务创建和 SDK 连接实现；自动重连/退避作为后续独立改动。

## Existing Interfaces

- Bridge health: `GET http://127.0.0.1:47824/health`
- Taskboard readiness: `GET http://127.0.0.1:47823/api/meta`
- Local configuration: `config/bridge.local.json` (ignored, never committed)
- Startup: `scripts/start-local.ps1`
- Shutdown: `scripts/stop-local.ps1`
- Simulation: `scripts/simulate-ready.ps1`

## Diagnostic Contract

`check-local.ps1` must:

1. Fail with a non-zero exit code when Node is missing or below the supported major version (`22.5` minimum), the local config is missing, or either HTTP service is unavailable.
2. Print only non-secret status information: URLs, service status, table/package counts, and the Feishu listener state.
3. Never print `.env.local`, app secrets, or full request bodies.
4. Return zero only when all required checks pass; a disconnected Feishu listener is reported as a failure when the script is invoked with `-RequireFeishu` and is allowed when that switch is omitted.

## Documentation Contract

The root `AGENTS.md` is the single operational source of truth. It must state:

- the fixed data flow and loopback-only boundary;
- the exact startup, health-check, simulation, and shutdown commands;
- the package-alias whitelist rule and prohibition on paths/commands/prompts from Feishu cells;
- event-id idempotency and manual-mode boundaries;
- secret handling and the requirement that behavior-changing edits include tests and review.

README changes should link to these rules and provide a clean-machine handoff checklist.

## Acceptance Criteria

- `npm test` remains green.
- A clean local checkout can follow README steps and use `check-local.ps1` to distinguish a ready stack from a missing or unhealthy service.
- Running the check does not mutate state, create tasks, expose credentials, or stop processes.
- Existing simulated and real-event behavior remains unchanged.

