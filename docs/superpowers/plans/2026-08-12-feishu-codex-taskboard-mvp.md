# Feishu Codex Taskboard MVP Implementation Plan

> **For agentic workers:** Implement each task with a red-green-refactor cycle and verify the complete local flow after every integration boundary.

**Goal:** Build a Windows-local flow in which a simulated Feishu Base transition to `待剪辑` creates a safely routed Taskboard task that the user manually starts and follows through Codex progress in the browser.

**Architecture:** A focused Node.js Bridge normalizes events, applies per-table rules, resolves package aliases from a trusted whitelist, persists deduplication outcomes, and calls Taskboard's HTTP API. A small upstream Taskboard extension adds an issue-linked start action that creates a local AI thread, starts the Codex turn, binds the thread to the issue, and opens its existing live progress panel.

**Tech Stack:** Node.js 24, native `node:http`, native `node:test`, JSON persistence for the MVP Bridge, dashi-taskboard React/TypeScript UI, SQLite Taskboard storage, Codex CLI JSON event stream.

## Global Constraints

- Bind both services to `127.0.0.1`; do not expose a LAN or public listener.
- Taskboard requires Node.js `>=22.5`; the verified local runtime is Node.js `v24.18.0`.
- Each table independently configures mode, trigger field, trigger value, and package field.
- Create work only on a transition from a value other than `待剪辑` into `待剪辑`.
- Default to manual execution; automatic mode remains disabled in the MVP.
- Never accept filesystem paths, shell commands, or Codex CLI flags from Feishu cells.
- Resolve only configured package aliases to trusted absolute workspace directories.
- Missing or unknown aliases create blocked tasks and never start Codex.
- Do not request or store Feishu credentials until the simulated flow passes.

---

### Task 1: Project foundation and configuration validation

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `config/bridge.example.json`
- Create: `src/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces `loadConfig(filename)` returning `{ host, port, taskboardUrl, projectId, stateFile, tables, packages }`.
- Each table entry is keyed by `tableId` and contains `name`, `mode`, `triggerField`, `triggerValue`, and `packageField`.
- Each package entry is keyed by alias and contains absolute `workspacePath` and fixed `prompt`.

- [ ] Write tests for valid configuration, duplicate table IDs, unsupported mode, non-absolute package paths, and invalid listener addresses.
- [ ] Run `npm test -- test/config.test.mjs` and verify the tests fail because `src/config.mjs` does not exist.
- [ ] Implement the smallest validator and loader that satisfies the tests.
- [ ] Run the targeted test and full test suite.

### Task 2: Pure event decision and safe task construction

**Files:**
- Create: `src/decide-event.mjs`
- Create: `src/task-payload.mjs`
- Test: `test/decide-event.test.mjs`
- Test: `test/task-payload.test.mjs`

**Interfaces:**
- Produces `decideRecordChange(config, event)` returning one of:
  - `{ kind: "ignored", reason }`
  - `{ kind: "ready", table, packageConfig, event }`
  - `{ kind: "blocked", reason, table, event }`
- Produces `buildTaskPayload(decision, projectId)` returning the exact body for `POST /api/tasks`.

- [ ] Write tests proving unknown tables, unrelated fields, unchanged `待剪辑`, and transitions away from `待剪辑` are ignored.
- [ ] Write tests proving different tables can use different trigger fields and modes.
- [ ] Write tests proving valid aliases become ready while missing and unknown aliases become blocked.
- [ ] Write tests proving record values cannot become workspace paths or commands in the request.
- [ ] Run targeted tests and verify the expected missing-module failures.
- [ ] Implement the decision and payload builders.
- [ ] Run targeted tests and the full suite.

### Task 3: Persistent deduplication and Taskboard client

**Files:**
- Create: `src/state-store.mjs`
- Create: `src/taskboard-client.mjs`
- Test: `test/state-store.test.mjs`
- Test: `test/taskboard-client.test.mjs`

**Interfaces:**
- Produces `JsonStateStore` with `get(eventId)` and `put(eventId, outcome)` serialized through atomic file replacement.
- Produces `TaskboardClient` with `ensureProject(project)` and `createTask(payload)`.

- [ ] Write tests for persistence across instances and duplicate reads.
- [ ] Write HTTP fixture tests for project creation, existing-project recovery, task creation, structured Taskboard errors, and unavailable service errors.
- [ ] Run tests to confirm failure before implementation.
- [ ] Implement minimal persistence and HTTP requests with bounded timeouts.
- [ ] Run targeted tests and full suite.

### Task 4: Bridge HTTP service and simulated endpoint

**Files:**
- Create: `src/bridge.mjs`
- Create: `src/server.mjs`
- Create: `src/index.mjs`
- Test: `test/bridge.test.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- Produces `createBridge({ config, store, taskboard })` with `handle(event)`.
- Produces `createBridgeServer(options)` exposing:
  - `GET /health`
  - `GET /api/config-summary`
  - `POST /api/simulate/record-changed`
- Simulated event body contains `eventId`, `baseToken`, `tableId`, `recordId`, `recordTitle`, `fieldName`, `beforeValue`, `afterValue`, and `fields`.

- [ ] Write bridge tests for ignored, ready, blocked, Taskboard-down, and replayed events.
- [ ] Write endpoint tests for validation, response codes, and no duplicate task creation.
- [ ] Run tests to confirm they fail before implementation.
- [ ] Implement the Bridge and loopback HTTP server.
- [ ] Run targeted tests and full suite.

### Task 5: Taskboard manual Codex start action

**Files:**
- Modify: `D:/codex/dashi-taskboard/web/src/api.ts`
- Modify: `D:/codex/dashi-taskboard/web/src/App.tsx`
- Modify: `D:/codex/dashi-taskboard/web/src/components/TaskDetail.tsx`
- Modify: `D:/codex/dashi-taskboard/server/app.mjs`
- Test: `D:/codex/dashi-taskboard/test/server.test.mjs`
- Test: `D:/codex/dashi-taskboard/test/task-start-flow.test.mjs`

**Interfaces:**
- Adds `POST /api/tasks/:id/start-ai` with a server-owned request body containing only a package alias confirmation; task description metadata provides normalized Bridge context.
- The route validates task state, resolves the task's mapped project workspace, creates an issue-linked AI thread, starts the fixed task prompt, binds its Codex thread ID to the task when available, and returns the local AI thread/run identifiers.
- The Task Detail action calls the route and requests the existing `AiChat` panel to open the returned thread.

- [ ] Add failing server tests for valid manual start, blocked task rejection, duplicate active start rejection, and invalid/missing project workspace.
- [ ] Add a failing UI source/behavior regression test for the manual start action and opening the progress panel.
- [ ] Run targeted upstream tests and verify the new tests fail.
- [ ] Implement the smallest API route and UI action using existing `AiChatService` and progress UI.
- [ ] Run upstream targeted tests, typecheck, and build.

### Task 6: Local startup, harmless package, and documentation

**Files:**
- Create: `examples/harmless-auto-cut/README.md`
- Create: `examples/harmless-auto-cut/AGENTS.md`
- Create: `scripts/start-local.ps1`
- Create: `scripts/stop-local.ps1`
- Create: `scripts/simulate-ready.ps1`
- Create: `README.md`
- Test: `test/startup-scripts.test.mjs`

**Interfaces:**
- `start-local.ps1` starts Taskboard and Bridge hidden, waits on health conditions, and opens the browser only after both are ready.
- `stop-local.ps1` stops only PIDs written to the workspace runtime state.
- `simulate-ready.ps1` posts one deterministic transition for the harmless package.

- [ ] Write tests for loopback variables, explicit paths, PID file scoping, and the sample event payload.
- [ ] Run tests to verify failure before scripts exist.
- [ ] Implement the scripts and concise nontechnical instructions.
- [ ] Run all Bridge tests and Taskboard verification commands.

### Task 7: End-to-end browser verification

**Files:**
- Update: `README.md` only if observed steps differ from the documented behavior.

- [ ] Install Taskboard dependencies and build its production UI.
- [ ] Start both services through `scripts/start-local.ps1`.
- [ ] Verify `GET http://127.0.0.1:47823/api/meta` and the Bridge health endpoint return success.
- [ ] Open Taskboard in a real browser and verify the page renders at desktop width.
- [ ] Submit the sample transition and confirm exactly one ready task appears.
- [ ] Replay the event and confirm no second task appears.
- [ ] Open the task, click Start, confirm live Codex progress appears, and wait for the harmless run to complete.
- [ ] Verify the final output and task linkage through the Taskboard API.
- [ ] Check a narrow viewport for usable controls and readable progress.
- [ ] Stop and restart through the scripts, then confirm persisted task and deduplication state remain intact.
