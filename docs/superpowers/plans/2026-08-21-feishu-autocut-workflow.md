# 飞书 Auto-Cut 工作流实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持飞书事件可靠投递和本机安全边界的前提下，增加多 Base/学科配置、统一 Auto-Cut 执行、手动验收、ZIP 产物管理和本地/NAS 上传队列。

**Architecture:** codex-feishu 继续作为 Bridge 和配置元数据服务，负责 Base/子表身份、字段规则、草稿/启用白名单和可靠事件投递；dashi-taskboard 增加 Base/学科目录、执行记录、产物记录和上传 Worker。Taskboard、Bridge 和 Worker 只通过 127.0.0.1 通信，任务使用 baseToken + tableId 作为稳定学科身份，运行中任务保存配置快照。

**Tech Stack:** Node.js 22 ESM、node:test、SQLite node:sqlite、React 19/TypeScript、飞书官方 Node SDK、Taskboard 现有 Codex runner、Node crypto SHA-256、受控本地文件系统适配器。

## Global Constraints

- Bridge 和 Taskboard 只绑定 127.0.0.1，不能改成 LAN 或公网监听。
- 飞书单元格只能提供白名单中的项目包别名和受控值，不能提供路径、shell 命令、Codex 参数或 prompt。
- 真实配置只写入被 Git 忽略的 config/bridge.local.json；凭据只放在 .env.local 或批准的密钥管理中。
- 状态文件使用现有稳定普通文件、同机锁和原子替换；不能手工删除状态文件解决重复任务。
- 事件投递仍是至少一次语义；不得宣称跨 Taskboard、Codex、文件系统副作用的绝对 exactly-once。
- event_id 幂等、离开可开始值只归档 todo、未知包别名阻断执行等现有事件不变量必须保持。
- 配置保存默认为草稿；导入共享配置不得自动启用子表。
- 任务创建时保存配置版本和 Auto-Cut 包别名快照；后续配置修改不改变已开始任务。
- 剪辑状态和上传状态独立；手动模式成功后进入 in_review，自动模式成功后进入 done。
- 任何开启自动 Codex 执行的代码必须同时更新 AGENTS.md、README、自动化测试，并先用测试表/无害项目验收。
- 不回滚或覆盖 D:\codex\dashi-taskboard 当前已有的用户未提交修改；实现开始前先建立隔离分支或 worktree 并记录基线。

## Repository/File Map

### D:\codex\codex-feishu

- Create src/workflow-config.mjs: Base/学科 schema、稳定身份、草稿/启用状态、共享配置脱敏。
- Create src/workflow-config-store.mjs: 临时文件、校验和原子替换的本机配置持久化。
- Create src/feishu-base-metadata.mjs: Base 链接解析和飞书 Base/table/field 只读适配器。
- Modify src/config.mjs, src/decide-event.mjs, src/bridge.mjs, src/task-payload.mjs, src/index.mjs, src/server.mjs, src/feishu-ws.mjs。
- Create test/workflow-config.test.mjs, test/feishu-base-metadata.test.mjs, test/workflow-config-api.test.mjs。
- Modify test/config.test.mjs, test/decide-event.test.mjs, test/bridge.test.mjs, test/task-payload.test.mjs, test/server.test.mjs。
- Modify config/bridge.example.json and README.md.

### D:\codex\dashi-taskboard

- Create server/feishu-workflow-store.mjs, server/feishu-workflow-api.mjs, server/resource-scheduler.mjs, server/feishu-execution.mjs, server/artifact-service.mjs, server/upload-worker.mjs。
- Modify server/database.mjs, server/app.mjs, server/feishu-package-config.mjs。
- Create web/src/components/FeishuWorkflowPanel.tsx and web/src/feishuWorkflow.ts。
- Modify web/src/App.tsx, web/src/api.ts, web/src/types.ts, web/src/components/TaskDetail.tsx, web/src/styles.css。
- Create focused tests for store, API, scheduler, execution, artifacts, upload and UI; preserve existing user changes.
- Modify README.md and codex-feishu AGENTS.md only in the policy-enable commit.

## Task 0: Isolate both repositories

**Files:** no source changes; branch/worktree metadata only.

**Interfaces:** consumes the approved Bridge design commit and the dirty Taskboard worktree; produces isolated implementation branches with the existing Taskboard diff preserved.

- [ ] Step 1: Record baselines.

~~~powershell
Set-Location D:\codex\codex-feishu
git status --short --branch
git log -1 --oneline
Set-Location D:\codex\dashi-taskboard
git status --short --branch
git diff --stat
~~~

Expected: Bridge shows the design commit; Taskboard reports existing user changes and no files are reset.

- [ ] Step 2: Create feature branches/worktrees without discarding changes.

Use branch name codex/feishu-autocut-workflow in both repositories. If Taskboard changes cannot be committed safely, create a worktree from the same commit and copy only approved changes by normal patching. Never run git reset --hard or git checkout --.

- [ ] Step 3: Run current suites.

Run npm test in both repositories. Record any pre-existing failure before feature work.

## Task 1: Versioned Base/subject configuration domain

**Files:**
- Create: D:\codex\codex-feishu\src\workflow-config.mjs
- Create: D:\codex\codex-feishu\src\workflow-config-store.mjs
- Create: D:\codex\codex-feishu\test\workflow-config.test.mjs
- Modify: D:\codex\codex-feishu\src\config.mjs, config\bridge.example.json, README.md, test\config.test.mjs

**Interfaces:**
- subjectKey(baseToken, tableId): string
- validateWorkflowConfig(value): NormalizedWorkflowConfig
- createWorkflowConfigStore({ filename, initial, now }): { read, preview, saveDraft, enable, disable, exportShareable, importShareable }
- activeTables(): returns only subjects with lifecycle enabled.

- [ ] Step 1: Write failing tests for stable identity, duplicate base/table rejection, custom start values, draft/enable lifecycle, configVersion increments and export redaction.
- [ ] Step 2: Run node --test test/workflow-config.test.mjs and confirm failure.
- [ ] Step 3: Implement strict validation for IDs, one non-empty startValue, manual/automatic mode, lifecycle, package alias, positive concurrency and local-only path fields. Persist with a queued temp-file write and atomic rename.
- [ ] Step 4: Implement saveDraft without replacing the active version; enable validates the full snapshot and atomically activates it; disable removes it from activeTables; import writes drafts only; export removes secrets, absolute workspace paths, ZIP paths, target paths, credentials, leases and history.
- [ ] Step 5: Run node --test test/workflow-config.test.mjs test/config.test.mjs and commit feat: add versioned Feishu subject configuration.

## Task 2: Base link parsing and read-only metadata preview

**Files:**
- Create: D:\codex\codex-feishu\src\feishu-base-metadata.mjs
- Create: D:\codex\codex-feishu\test\feishu-base-metadata.test.mjs
- Modify: D:\codex\codex-feishu\src\server.mjs, src\index.mjs, test\server.test.mjs

**Interfaces:**
- parseBaseLink(input): { baseToken, tableId?: string }
- createFeishuBaseMetadataReader({ client }): { readBase, listTables, listFields, preview }
- POST /api/feishu/base-preview accepts { url } and returns normalized Base/table/field metadata.

- [ ] Step 1: Write fake-SDK tests for /base/bas_x, optional table query, invalid links, Base/table/field IDs, field options and safe non-zero SDK errors.
- [ ] Step 2: Run node --test test/feishu-base-metadata.test.mjs test/server.test.mjs and confirm failure.
- [ ] Step 3: Implement the adapter using only official read APIs; normalize names for display and IDs for identity; do not read records or write Base data.
- [ ] Step 4: Add JSON/body validation and generic loopback-safe errors; inject the fake client in tests.
- [ ] Step 5: Run focused tests and commit feat: add Feishu Base metadata preview.

## Task 3: Runtime-aware Bridge routing and snapshots

**Files:**
- Modify: D:\codex\codex-feishu\src\decide-event.mjs, src\bridge.mjs, src\task-payload.mjs, src\index.mjs, src\feishu-ws.mjs
- Modify: D:\codex\codex-feishu\test\decide-event.test.mjs, test\bridge.test.mjs, test\task-payload.test.mjs

**Interfaces:**
- createBridge({ getConfig, ...existingOptions }) reads the active validated config at decision time.
- decideRecordChange(config, event) matches baseToken + tableId and ignores draft/disabled subjects.
- buildTaskPayload(decision) emits subjectKey, configVersion, executionMode, uploadMode and package alias in the server-owned marker.

- [ ] Step 1: Add tests for same table ID across Base tokens, same display names, draft/disabled subjects, custom start values and immutable task snapshots.
- [ ] Step 2: Run the focused Bridge tests and confirm new assertions fail.
- [ ] Step 3: Implement dynamic config lookup while preserving lease, retry, title lookup and archive logic; an SDK event for a non-active subject is ignored.
- [ ] Step 4: Derive a safe deterministic Taskboard project ID from subjectKey; package aliases retain only trusted workspace/prompt mapping and no longer define subject identity.
- [ ] Step 5: Run npm test and commit feat: route events by enabled Feishu subjects.

## Task 4: Taskboard catalog persistence and local API

**Files:**
- Create: D:\codex\dashi-taskboard\server\feishu-workflow-store.mjs, server\feishu-workflow-api.mjs
- Create: D:\codex\dashi-taskboard\test\feishu-workflow-store.test.mjs, test\feishu-workflow-api.test.mjs
- Modify: D:\codex\dashi-taskboard\server\database.mjs, server\app.mjs, web\src\types.ts, web\src\api.ts

**Interfaces:**
- listCatalog(): Promise<BaseCatalog[]>
- upsertBasePreview(preview): Promise<BaseCatalog>
- saveSubjectDraft(subjectKey, patch): Promise<SubjectConfig>
- enableSubject(subjectKey, expectedVersion): Promise<SubjectConfig>
- disableSubject(subjectKey, expectedVersion): Promise<SubjectConfig>
- GET/POST/PATCH /api/local/feishu/workflow/catalog|subjects|subjects/:subjectKey and enable/disable actions.

- [ ] Step 1: Add failing SQLite tests for feishu_bases, feishu_subjects, feishu_subject_versions, version checks and deterministic subject project mapping.
- [ ] Step 2: Run focused tests and confirm missing tables/routes fail.
- [ ] Step 3: Add additive migrations and row mappers. Do not reuse workflow_workspaces or task parent/subIssue relations for Base hierarchy. Store absolute paths only in local DB.
- [ ] Step 4: Validate unknown keys, lifecycle transitions, fields, package aliases, concurrency and paths; call Bridge validation before local enable.
- [ ] Step 5: Run focused tests and commit feat: persist Feishu Base subject catalog.

## Task 5: Base/subject navigation and configuration UI

**Files:**
- Create: D:\codex\dashi-taskboard\web\src\components\FeishuWorkflowPanel.tsx
- Create: D:\codex\dashi-taskboard\web\src\feishuWorkflow.ts
- Create: D:\codex\dashi-taskboard\test\feishu-workflow-ui.test.mjs
- Modify: D:\codex\dashi-taskboard\web\src\App.tsx, src\api.ts, src\types.ts, src\styles.css

**Interfaces:**
- FeishuWorkflowPanel props: catalog, selectedSubjectKey, onSelectSubject, onAddBase, onSaveDraft, onEnable, onDisable.
- listFeishuWorkflowCatalog(signal): Promise<BaseCatalog[]> and mutation calls matching Task 4.
- Base selection aggregates displayed subjects; subject selection loads one projectId.

- [ ] Step 1: Add source-contract tests that verify Base/subject names, hidden-subject filtering, draft/active labels and subject-only task loading.
- [ ] Step 2: Run the UI test and confirm missing component/API symbols fail.
- [ ] Step 3: Implement Add Base, metadata preview, selected-subject list, field/start-value/package/mode/concurrency/upload controls, explicit Save Draft/Enable/Disable actions.
- [ ] Step 4: Integrate with existing project switcher and task route; preserve non-Feishu project behavior; persist only selected subjectKey in client storage.
- [ ] Step 5: Run npm run typecheck, npm run build:web and the focused UI test; commit feat: add Feishu Base subject navigation.

## Task 6: Unified execution claim and resource scheduler

**Files:**
- Create: D:\codex\dashi-taskboard\server\resource-scheduler.mjs, server\feishu-execution.mjs
- Create: D:\codex\dashi-taskboard\test\resource-scheduler.test.mjs, test\feishu-execution.test.mjs
- Modify: D:\codex\dashi-taskboard\server\database.mjs, server\app.mjs, server\feishu-package-config.mjs
- Modify: D:\codex\dashi-taskboard\web\src\api.ts, App.tsx, components\TaskDetail.tsx, types.ts

**Interfaces:**
- createResourceScheduler({ database, now, sleep }): { request, release, recover }
- createFeishuExecutionService({ database, aiChat, packageStore, scheduler, artifactService, events }): { requestExecution, reconcile, recover }
- requestExecution(taskId, { trigger: manual | move | automatic, actor }): Promise<ExecutionSnapshot>
- POST /api/local/tasks/:id/execute is the single loopback endpoint; /start-ai delegates to it.

- [ ] Step 1: Add tests for two simultaneous requests yielding one claim, maxConcurrent=1 yielding one running/one queued, separate groups running concurrently, lease recovery and immutable config snapshots.
- [ ] Step 2: Run node --test test/resource-scheduler.test.mjs test/feishu-execution.test.mjs and confirm failure.
- [ ] Step 3: Add task_executions and resource_leases migrations with one active claim per task, executionId, configVersion, package alias, trigger, state, attempts and lease fields. Use SQLite transactions and version checks.
- [ ] Step 4: Route manual click and drag-to-in_progress through requestExecution. Existing non-Feishu tasks retain current behavior. Do not execute Codex from the Bridge event handler.
- [ ] Step 5: Reconcile Auto-Cut runs: manual mode settles to in_review after verified artifacts; automatic mode settles to done; failures/user-action-required states settle to blocked; before policy enablement, automatic requests return a visible configuration error.
- [ ] Step 6: Run existing start-flow tests plus focused tests and commit manual/unified execution. Create a separate policy commit only after updating AGENTS.md, README and tests to explicitly permit automatic execution.

## Task 7: ZIP artifact selection, SHA-256 and completed view

**Files:**
- Create: D:\codex\dashi-taskboard\server\artifact-service.mjs
- Create: D:\codex\dashi-taskboard\test\artifact-service.test.mjs
- Modify: D:\codex\dashi-taskboard\server\database.mjs, server\app.mjs, web\src\components\TaskDetail.tsx, web\src\App.tsx, web\src\api.ts, web\src\types.ts, web\src\styles.css

**Interfaces:**
- createArtifactService({ rootDirectory, now }): { acceptUpload, validateZip, getArtifact }
- acceptUpload(taskId, fileStream, metadata): Promise<ArtifactSnapshot>
- ArtifactSnapshot includes artifactId, taskId, filename, size, sha256, sourceMode, validationStatus, path and timestamps.
- POST /api/local/tasks/:id/artifacts, GET /api/local/tasks/:id/artifacts, POST /api/local/tasks/:id/artifacts/:artifactId/select.

- [ ] Step 1: Add tests for stable-file detection, SHA-256, corrupt ZIP, absolute/.. entry rejection, duplicate hash idempotency and mode-specific state transition.
- [ ] Step 2: Run focused test and confirm failure.
- [ ] Step 3: Stream to a server-owned temporary file, require .zip, check size/mtime stability, hash with createHash("sha256"), inspect entries with a locked safe parser, reject traversal/absolute names, then atomic-rename. Never overwrite the source.
- [ ] Step 4: Bind artifact to execution; manual mode moves to in_review, automatic mode moves to done only after the same validation. Add select/reselect ZIP controls and completed-window metadata.
- [ ] Step 5: Run typecheck/build/artifact tests and commit feat: add verified Feishu ZIP artifacts.

## Task 8: Upload queue and local/UNC/NAS target adapter

**Files:**
- Create: D:\codex\dashi-taskboard\server\upload-worker.mjs
- Create: D:\codex\dashi-taskboard\test\upload-worker.test.mjs
- Modify: D:\codex\dashi-taskboard\server\database.mjs, server\app.mjs, server\feishu-workflow-api.mjs
- Modify: D:\codex\dashi-taskboard\web\src\components\FeishuWorkflowPanel.tsx, components\TaskDetail.tsx, api.ts, types.ts
- Modify: D:\codex\codex-feishu\README.md

**Interfaces:**
- createUploadWorker({ database, artifactService, targetResolver, concurrency, now, logger }): { enqueue, processDue, recover, stop }
- enqueue(taskId, artifactId, targetId): Promise<UploadJob>
- POST /api/local/tasks/:id/upload-queue, GET /api/local/tasks/:id/upload, POST /api/local/tasks/:id/upload/retry.

- [ ] Step 1: Add tests for manual/automatic enqueue policy, temp destination promotion, destination hash match, duplicate hash, name conflict, missing target retry, bounded attempts and restart recovery.
- [ ] Step 2: Run focused test and confirm failure.
- [ ] Step 3: Validate absolute drive and UNC paths, reject null bytes/relative paths, resolve only server-owned target aliases, copy to a temporary .uploading file, hash and promote only after match.
- [ ] Step 4: Add durable upload_jobs with one lease per job, bounded retry and conflict state. Upload failure changes only upload status, never clip status.
- [ ] Step 5: Expose per-subject upload mode/source mode/path binding/target alias/upload concurrency. Manual mode cannot auto-enqueue before review approval; automatic mode auto-enqueues only when configured.
- [ ] Step 6: Run focused artifact/upload/API tests and commit feat: add verified ZIP upload queue.

## Task 9: Redacted shared configuration import/export

**Files:**
- Modify: D:\codex\codex-feishu\src\server.mjs, src\workflow-config-store.mjs, test\workflow-config-api.test.mjs
- Modify: D:\codex\dashi-taskboard\server\feishu-workflow-api.mjs, server\app.mjs, web\src\components\FeishuWorkflowPanel.tsx, web\src\api.ts
- Create: D:\codex\dashi-taskboard\test\feishu-share-config.test.mjs

**Interfaces:**
- GET /api/local/feishu/workflow/share/export returns schema-versioned redacted JSON.
- POST /api/local/feishu/workflow/share/import accepts { configuration, dryRun } and returns diagnostics.

- [ ] Step 1: Add tests asserting export contains IDs/names/modes/package aliases/concurrency but no App Secret, workspace path, ZIP path, target path, credentials, claims, logs or task history.
- [ ] Step 2: Run focused tests and confirm failure.
- [ ] Step 3: Implement schema validation, dry-run diagnostics and draft-only import; add UI export/import controls.
- [ ] Step 4: Run both repositories’ focused suites and commit feat: add redacted Feishu workflow sharing.

## Task 10: Documentation, policy update and end-to-end verification

**Files:**
- Modify: D:\codex\codex-feishu\AGENTS.md, README.md, config\bridge.example.json, scripts\check-local.ps1, scripts\simulate-ready.ps1
- Modify: D:\codex\dashi-taskboard\README.md
- Create: D:\codex\codex-feishu\test\autocut-workflow-e2e.test.mjs
- Create: D:\codex\dashi-taskboard\test\autocut-workflow-e2e.test.mjs

**Interfaces:** existing standard commands remain unchanged; /health adds redacted workflow/execution/upload queue counts.

- [ ] Step 1: Update AGENTS.md only after manual flow passes. State exact loopback automatic trigger, approved config source, claim/retry behavior and that arbitrary commands are never accepted.
- [ ] Step 2: Add deterministic harmless-package E2E: draft subject ignored, enable subject, custom start-value event creates one task, duplicate event creates no second task, manual execution reaches in_review, artifact selection records SHA-256, review approval reaches done, upload reaches uploaded, restart/replay remains idempotent.
- [ ] Step 3: Run all verification commands.

~~~powershell
Set-Location D:\codex\codex-feishu
npm test
Set-Location D:\codex\dashi-taskboard
npm run typecheck
npm run build:web
npm test
Set-Location D:\codex\codex-feishu
.\scripts\start-local.ps1
.\scripts\check-local.ps1
.\scripts\simulate-ready.ps1
.\scripts\check-local.ps1
.\scripts\stop-local.ps1
~~~

Expected: tests pass, health is redacted, simulation is idempotent and services bind only to 127.0.0.1.

- [ ] Step 4: Run requesting-code-review against both feature branches, resolve findings, rerun complete suites, inspect git diff --check, then propose merges.

## Coverage Self-Review

- Tasks 2, 4 and 5 cover Base link parsing, metadata IDs/names and selected-subject visibility.
- Tasks 1, 3 and 4 cover draft/enable lifecycle and the active Bridge whitelist.
- Tasks 1 and 3 cover custom start values, package aliases, configVersion and fixed first-phase routing.
- Task 6 covers click, drag-to-in_progress, automatic-mode gate, idempotent claims and concurrency.
- Tasks 6 and 7 cover manual in_review versus automatic done.
- Task 7 covers manual ZIP selection, SHA-256, structure/path validation and the completed view.
- Task 8 covers local/UNC/NAS targets, upload idempotency, conflict protection and retries.
- Task 9 covers redacted cross-computer import/export.
- Task 10 covers AGENTS, README, standard commands and end-to-end verification.
- No task uses parent/subIssue relations for Base/subject hierarchy.
- No task treats a Feishu cell as a path, command, prompt or credential source.
