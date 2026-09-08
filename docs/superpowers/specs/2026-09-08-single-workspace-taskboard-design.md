# Single Workspace Taskboard Design

## Goal

Make `D:\codex\codex-feishu` the only daily workspace: one double-click entry starts the Bridge and the latest Taskboard contained in the same repository.

## Real operation path

`启动-Taskboard.bat` -> `scripts/start-local.ps1 -EnableFeishu` -> `taskboard/server/index.mjs` and `src/index.mjs` -> `.runtime/taskboard/taskboard.sqlite` and Bridge state -> `http://127.0.0.1:47823` displays `taskboard/dist/web`.

## Chosen architecture

Import the current tracked Taskboard working tree into `taskboard/` inside the Bridge repository. Keep Bridge dependencies at the repository root and Taskboard dependencies under `taskboard/node_modules`. The launch scripts resolve `taskboard/` relative to their own repository and no longer search sibling worktrees or absolute fallback directories.

The old `D:\codex\dashi-taskboard` directory remains unchanged as a safety copy until the user confirms the new entry works. Runtime databases are not merged because the user has no formal task data to preserve. The existing `codex-feishu\.runtime\taskboard` remains the sole runtime data directory; the imported Taskboard `.data`, `.runtime`, `.git`, `node_modules`, `pip`, and `tmp` directories are excluded.

## Source import

Copy every Git-tracked file from the current `D:\codex\dashi-taskboard` working tree so tracked uncommitted edits are preserved. Also copy the new focused migration test `test/feishu-database-migration.test.mjs`. Do not copy unrelated untracked `pip/` or `tmp/` content.

## Startup behavior

`start-local.ps1` and `stop-local.ps1` retain their explicit `-TaskboardRoot` override for diagnostics, but the only default is `$root\taskboard`. Startup continues to validate `server\index.mjs` and `dist\web\index.html`, uses loopback ports 47823 and 47824, and keeps the existing process identity checks.

## Verification

Build `taskboard/dist/web` from the imported current source. Run the focused database migration test and Bridge startup-script tests. Then run the same PowerShell script invoked by `启动-Taskboard.bat`, check `/api/meta`, `/health`, and load the browser page. No release, deployment, database merge, Auto-Cut publication, or FEI-3 run is included.
