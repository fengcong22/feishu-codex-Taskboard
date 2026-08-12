# Feishu Codex Taskboard MVP Design

## Objective

Build a Windows-local MVP that turns a Feishu Base record status change into a visible Taskboard task. The user can review the task, click Start, and watch Codex run the mapped Auto-cut project with live progress and logs.

The first verified flow uses a simulated Feishu event. Real Feishu long-connection credentials and subscriptions are connected only after the local flow works.

## Confirmed Product Decisions

- Reuse `dashi-taskboard` in a separate browser window at `http://127.0.0.1:47823`.
- Do not depend on the project's macOS Codex sidebar integration for the Windows MVP.
- Each Feishu Base table has its own configuration.
- Each table chooses `manual` or `automatic` mode; the initial default is `manual`.
- Each table configures its own trigger field. The current example is `视频整体进度`.
- A task is created only when the trigger field transitions from another value to `待剪辑`.
- Records select an Auto-cut package through a field named `自动剪辑项目包`.
- One table can route different records to different Auto-cut packages.
- Package values are aliases such as `Auto-cut-copyA`; aliases map to trusted local directories in server-side configuration.
- A missing or unknown alias creates a blocked task and never executes a local path supplied by Feishu.
- Manual mode creates the task but requires the user to click Start.
- Automatic mode remains configurable but execution is disabled in the MVP until the manual flow is verified.

## Considered Approaches

### 1. Reuse dashi-taskboard with a small Feishu bridge (selected)

This provides an existing task UI, persisted history, Codex execution, progress events, and logs. The new code remains focused on Feishu event normalization, transition detection, routing, and safe task creation.

### 2. Build a new dashboard and runner

This gives full UI control but duplicates task persistence, Codex process management, streaming logs, and recovery behavior. It has substantially higher MVP cost and risk.

### 3. Trigger Codex directly with no dashboard

This is the smallest backend, but it does not solve the user's requirement to see queued tasks, execution progress, logs, and failures without manipulating the Codex chat window.

## Architecture

```text
Simulated event endpoint (MVP) / Feishu long connection (phase 2)
        |
        v
Feishu Bridge
  - validate event
  - deduplicate event
  - match table configuration
  - detect transition to 待剪辑
  - resolve package alias through whitelist
        |
        v
dashi-taskboard task
  - ready: valid package, waiting for click
  - blocked: missing/unknown package or invalid configuration
        |
        v
User clicks Start
        |
        v
Codex runs in trusted Auto-cut workspace
        |
        v
Taskboard displays state, structured events, logs, and final result
```

## Components

### Taskboard

The upstream `dashi-taskboard` application owns the browser UI, task persistence, manual start interaction, Codex subprocess execution, and progress display. It binds to `127.0.0.1` so it is accessible only from this computer during the MVP.

### Feishu Bridge

A small Node.js service owns integration-specific behavior:

- Loads per-table configuration.
- Accepts a normalized simulated event for local testing.
- Later accepts `drive.file.bitable_record_changed_v1` from Feishu's long connection.
- Detects a transition into the configured trigger value.
- Suppresses duplicate deliveries using a stable event identity.
- Reads the configured package alias from the record fields.
- Resolves the alias through a local whitelist.
- Creates a Taskboard task containing record identifiers, changed field, prior/current values, package alias, and execution instructions.

The event handler performs only validation and enqueueing. It does not wait for Codex or video processing.

### Configuration

Configuration is local and excludes secrets from source control. It contains:

- Table ID and display name.
- Trigger field name and trigger value.
- Package field name.
- Mode: `manual` or `automatic`.
- Package alias to trusted absolute workspace path mapping.
- Taskboard base URL.

The sample configuration uses placeholder table IDs and a harmless local test package. Real Auto-cut directories are added only after their exact paths and startup instructions are verified.

## Event Rules

An event creates a task only when all of these conditions hold:

1. The event belongs to a configured table.
2. The changed field is the table's configured trigger field.
3. The new value is exactly `待剪辑`.
4. The prior value was not `待剪辑`.
5. The event has not already been processed.

Events that do not meet these conditions are acknowledged and recorded as ignored. A matching event with no valid package mapping creates a blocked task with a clear reason.

## Task Contents

Each created task includes:

- Base and table identifiers.
- Record ID and record title when available.
- Trigger field transition.
- Selected package alias.
- Resolved workspace identity without exposing arbitrary execution controls.
- A generated Codex instruction containing only normalized record context and the package's predefined workflow prompt.

Feishu cell contents are treated as untrusted data. They are context for the task, never shell commands, CLI flags, or filesystem paths.

## Manual And Automatic Modes

In `manual` mode, matching events create a ready task and stop. The user starts it from Taskboard.

In `automatic` mode during the MVP, matching events are labeled as eligible for automatic execution but remain ready for manual start. A later release can enable automatic start per table after the same package mapping and execution path has been proven manually.

## Failure Handling

- Unknown table: ignore with reason.
- Non-triggering transition: ignore with reason.
- Duplicate event: return the original outcome without creating another task.
- Missing package alias: create blocked task.
- Unknown package alias: create blocked task.
- Taskboard unavailable: retain a failed enqueue record and expose a retryable error.
- Codex process failure: preserve exit state and logs in Taskboard.
- Bridge restart: deduplication state and task linkage remain persisted locally.

## Verification Strategy

Automated tests cover transition detection, per-table behavior, package whitelist resolution, duplicate suppression, blocked tasks, and Taskboard request construction.

The end-to-end local check will:

1. Start Taskboard and the Bridge on loopback addresses.
2. Submit a simulated record change from a non-trigger value to `待剪辑`.
3. Confirm exactly one task appears in the browser.
4. Click Start on a harmless test package.
5. Confirm Codex progress and the final result are visible.
6. Replay the same event and confirm no duplicate task is created.

Desktop and narrow browser viewports will be checked to ensure controls and logs remain usable.

## Phase Boundaries

### Included in MVP

- Local Taskboard installation and startup.
- Separate Windows browser UI.
- Per-table configuration and mode switch.
- Package alias whitelist.
- Simulated Feishu event endpoint.
- Task creation, manual start, Codex execution, progress, and logs.
- Automated tests and a documented local startup procedure.

### Phase 2

- Feishu application credentials.
- Base file subscription.
- SDK or `lark-cli` long-connection consumer for the real event.
- Real record test.
- Optional Base status writeback.
- Enabling automatic execution per table.

### Excluded

- Public or LAN exposure.
- Arbitrary paths or commands from Feishu cells.
- Video upload/download orchestration.
- Windows injection into the Codex sidebar.
- Reimplementing Taskboard's UI or Codex runner.

## Success Criteria

The MVP succeeds when the user can open the local Taskboard, simulate a configured record transition to `待剪辑`, see one correctly routed task, manually start it, and observe a harmless Codex run through completion without using the Codex chat window.
