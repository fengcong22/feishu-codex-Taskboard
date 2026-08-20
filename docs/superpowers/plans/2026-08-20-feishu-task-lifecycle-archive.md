# 飞书待剪辑任务生命周期归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 当飞书记录离开“待剪辑”时，只归档该记录仍在 Taskboard“等待认领”（todo）中的飞书任务，并保留已进入执行状态的任务。

**Architecture:** 在现有事件决策中增加一个仅用于“离开触发值”的归档效果；使用任务描述中的服务端元数据匹配 Base、表、记录和触发字段身份。Bridge 在持有事件租约和 heartbeat 的情况下，通过 Taskboard 的活动任务列表、单任务读取和归档接口逐个归档候选；失败沿用现有持久化重试状态机。

**Tech Stack:** Node.js >= 22.5 ESM、内置 node:test、本地 Taskboard HTTP API、JSON 状态文件、PowerShell 5 兼容脚本。

## Global Constraints

- Bridge 和 Taskboard 只绑定 127.0.0.1。
- 只有其他值 → 待剪辑创建任务；离开待剪辑只处理匹配的 todo 任务。
- 已进入 in_progress、in_review、done 或其他非 todo 状态的任务不得被 Bridge 自动归档或中止。
- 整体投递语义仍是至少一次，不能宣称跨外部副作用与状态提交崩溃窗口的绝对 exactly-once。
- 飞书单元格只能提供受控字段值和项目包别名，不能解释为路径、命令或 prompt。
- 凭据只来自 .env.local；不要写入代码、日志、任务描述或 Git。
- 状态文件继续使用现有 fail-closed、原子替换、稳定普通文件路径和本机 OS 锁。
- 改变事件筛选或任务路由时，必须同步更新测试、README 和 AGENTS.md。

## File Map

- Modify src/decide-event.mjs: 识别离开触发值并返回归档效果。
- Modify src/task-payload.mjs: 新建任务元数据保存 triggerFieldId，兼容旧标记。
- Create src/task-lifecycle.mjs: 纯匹配和带并发保护的等待认领任务归档编排。
- Modify src/taskboard-client.mjs: 增加单任务读取和归档方法。
- Modify src/retry-policy.mjs: 保留归档流程需要的安全错误码。
- Modify src/bridge.mjs: 执行归档效果并持久化 ignored 结果。
- Modify tests: decision、payload、client、retry-policy、Bridge。
- Create test/task-lifecycle.test.mjs: 覆盖匹配、状态筛选、版本冲突和幂等。
- Modify README.md and AGENTS.md: 记录生命周期边界和验收步骤。

---

### Task 1: Add leave-trigger decision and workflow metadata

**Files**

- Modify: src/decide-event.mjs
- Modify: src/task-payload.mjs
- Test: test/decide-event.test.mjs
- Test: test/task-payload.test.mjs

**Interfaces**

The leave decision has this shape:

~~~js
{
  kind: "ignored",
  reason: "left_trigger",
  effect: "archive_waiting_tasks",
  table,
  event,
}
~~~

New task markers include triggerFieldId when configured; old markers without it remain valid.

- [ ] Write failing tests for entering, leaving, staying at, and unrelated changes. A leave event must not require a package alias.
- [ ] Run: node --test test/decide-event.test.mjs. Expected: the new leave assertions fail.
- [ ] Implement the leave branch before the existing after-value filter:

~~~js
const before = displayValue(event.beforeValue);
const after = displayValue(event.afterValue);
if (before === table.triggerValue && after !== table.triggerValue) {
  return {
    kind: "ignored",
    reason: "left_trigger",
    effect: "archive_waiting_tasks",
    table,
    event,
  };
}
if (after !== table.triggerValue) return { kind: "ignored", reason: "new_value_not_trigger" };
if (before === table.triggerValue) return { kind: "ignored", reason: "already_at_trigger" };
~~~

- [ ] Add triggerFieldId to the task metadata without changing marker version. Assert decoding returns the ID and old markers still parse.
- [ ] Run: node --test test/decide-event.test.mjs test/task-payload.test.mjs. Expected: all focused tests pass.

### Task 2: Add pure lifecycle matching

**Files**

- Create: src/task-lifecycle.mjs
- Create: test/task-lifecycle.test.mjs

**Interfaces**

~~~js
export function matchesWaitingFeishuTask(task, { event, table }) {}
export function selectWaitingFeishuTasks(tasks, scope) {}
~~~

The matcher requires source = feishu-base, exact baseToken/tableId/recordId/triggerValue, matching trigger field identity, archivedAt = null, and status = todo. If both metadata and configuration have triggerFieldId, compare IDs; otherwise compare triggerField names for old metadata compatibility.

- [ ] Add fixtures for matching todo tasks, running/review tasks, archived tasks, mismatched scope, malformed metadata, title-only lookalikes, and old metadata without triggerFieldId.
- [ ] Run: node --test test/task-lifecycle.test.mjs. Expected: fail because the module is absent.
- [ ] Implement using parseFeishuTaskMetadata; never match on title, package alias, or event ID alone:

~~~js
import { parseFeishuTaskMetadata } from "./task-payload.mjs";

function sameField(metadata, table) {
  if (metadata.triggerFieldId && table.triggerFieldId) {
    return metadata.triggerFieldId === table.triggerFieldId;
  }
  return metadata.triggerField === table.triggerField;
}

export function matchesWaitingFeishuTask(task, { event, table }) {
  if (!task || task.archivedAt != null || task.status !== "todo") return false;
  const metadata = parseFeishuTaskMetadata(task.description);
  return Boolean(metadata
    && metadata.baseToken === event.baseToken
    && metadata.tableId === event.tableId
    && metadata.recordId === event.recordId
    && metadata.triggerValue === table.triggerValue
    && sameField(metadata, table));
}

export function selectWaitingFeishuTasks(tasks, scope) {
  return Array.isArray(tasks) ? tasks.filter((task) => matchesWaitingFeishuTask(task, scope)) : [];
}
~~~

- [ ] Run: node --test test/task-lifecycle.test.mjs. Expected: all matcher tests pass.

### Task 3: Add safe Taskboard client methods

**Files**

- Modify: src/taskboard-client.mjs
- Modify: src/retry-policy.mjs
- Test: test/taskboard-client.test.mjs
- Test: test/retry-policy.test.mjs

**Interfaces**

~~~js
async getTask(taskId): Promise<Task>
async archiveTask(task): Promise<Task>
~~~

Both methods use the existing loopback request helper and validate non-empty task id and identifier. Preserve safe downstream codes TASK_NOT_FOUND and VERSION_CONFLICT.

- [ ] Add failing HTTP fixture tests for GET /api/tasks/task_1 and POST /api/tasks/task_1/archive with body { version: 4 }, plus malformed-success and 409 VERSION_CONFLICT cases.
- [ ] Run: node --test test/taskboard-client.test.mjs test/retry-policy.test.mjs. Expected: fail because methods/codes are absent.
- [ ] Add safe codes and implement:

~~~js
async getTask(taskId) {
  const pathname = "/api/tasks/" + encodeURIComponent(taskId);
  const payload = await this.#request(pathname, { method: "GET" });
  if (!validTask(payload?.task)) throw invalidResponse(pathname);
  return payload.task;
}

async archiveTask(task) {
  const pathname = "/api/tasks/" + encodeURIComponent(task.id) + "/archive";
  const payload = await this.#request(pathname, { body: { version: task.version } });
  if (!validTask(payload?.task)) throw invalidResponse(pathname);
  return payload.task;
}
~~~

- [ ] Run the focused client and retry-policy tests. Expected: all pass.

### Task 4: Orchestrate archive effects in Bridge

**Files**

- Modify: src/task-lifecycle.mjs
- Modify: src/bridge.mjs
- Test: test/task-lifecycle.test.mjs
- Test: test/bridge.test.mjs

**Interfaces**

~~~js
export async function archiveWaitingFeishuTasks(
  taskboard,
  scope,
  { ensureActive = async () => {} } = {},
): Promise<{ archivedCount: number }>;
~~~

- [ ] Add failing orchestration tests with a fake Taskboard containing two matching todo tasks and one running task. Assert only todo tasks are archived, listTasks receives archived = false, and ensureActive surrounds external calls.
- [ ] Add tests for one VERSION_CONFLICT followed by a reread showing in_progress, TASK_NOT_FOUND as an already-absent task, and unrelated errors being rethrown.
- [ ] Run: node --test test/task-lifecycle.test.mjs test/bridge.test.mjs. Expected: fail because orchestration is absent.
- [ ] Implement bounded orchestration: list active tasks, select candidates, reread each candidate, skip non-todo candidates, archive with current version, retry one version conflict after a reread, treat 404 as absent, and rethrow all other errors. Never loop indefinitely.
- [ ] Call ensureActive before and after every external request.
- [ ] In bridge.mjs, keep ordinary ignored events on the no-Taskboard path. For effect = archive_waiting_tasks, call the lifecycle operation and complete the event as ignored with reason left_trigger. Do not add arbitrary unvalidated fields to durable state.
- [ ] Add Bridge tests for multiple waiting tasks, execution-state protection, ordinary ignored events, retry recovery, duplicate replay, and partial archive success.
- [ ] Run: node --test test/task-lifecycle.test.mjs test/bridge.test.mjs. Expected: all focused tests pass.

### Task 5: Update operating documentation

**Files**

- Modify: AGENTS.md
- Modify: README.md
- Modify: docs/superpowers/specs/2026-08-20-feishu-task-lifecycle-archive-design.md
- Test: test/operations-hardening.test.mjs if contract assertions need updating

- [ ] Document the invariant: leaving 待剪辑 archives only same Base/table/record/trigger-flow tasks still in todo; processing, confirmation, and other non-todo tasks are untouched.
- [ ] Document that archived tasks remain recoverable, re-entry can create a new task, and no generic field-to-column mapping is currently active.
- [ ] Add manual acceptance steps for enter, leave, re-entry, and an already-started task.
- [ ] Run: node --test test/operations-hardening.test.mjs. Expected: all documentation contract tests pass.

### Task 6: Full verification and local acceptance

**Files:** no source changes; inspect the files above and local runtime only.

- [ ] Run syntax checks:

~~~powershell
node --check src/decide-event.mjs
node --check src/task-lifecycle.mjs
node --check src/task-payload.mjs
node --check src/taskboard-client.mjs
node --check src/bridge.mjs
node --check src/retry-policy.mjs
~~~

Expected: every command exits 0.

- [ ] Run: npm test. Expected: zero failures; record actual pass/skip counts.
- [ ] Run: git diff --check and git status --short. Confirm no credentials, .runtime state, temporary files, or debug output are unintentionally modified.
- [ ] Run only safe local checks:

~~~powershell
./scripts/start-local.ps1
./scripts/check-local.ps1
./scripts/stop-local.ps1
~~~

Use a synthetic/disposable lifecycle fixture for enter/leave/re-entry. Do not send a leave event matching an existing user task unless explicitly selected for acceptance.
- [ ] Report exact verification counts, lifecycle acceptance, execution-state protection, absence of generic field-to-column mapping, and that no commit was created unless requested.

## Plan Self-Review

- Spec coverage: trigger boundaries, metadata matching, todo-only filtering, version handling, retries, persistence, tests, documentation, and acceptance are covered by Tasks 1–6.
- Placeholder scan: no TBD, TODO, or unspecified implementation step appears in this plan.
- Type consistency: Task 4 consumes the client methods from Task 3 and matcher functions from Task 2; Bridge persists the existing normalized ignored outcome.
- Scope check: no Taskboard server changes, no automatic Codex start/stop, and no generic Feishu-to-column mapping are included.
