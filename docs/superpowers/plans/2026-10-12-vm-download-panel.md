# VM Download Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Provide a usable local VM download panel backed by a persistent queue and shared authenticated worker.

**Architecture:** Reuse the existing approval state machine and SQLite store. Add a memory-only session manager, notification transport, local service/API and a React panel mounted in Local Settings. Keep unknown Shadow refresh/device-grant capabilities explicitly unavailable.

**Tech Stack:** Node.js 22.13+, node:sqlite, native HTTP/fetch, React/TypeScript, node:test and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-vm-download-panel-design.md`

## Global Constraints

- Preserve all existing uncommitted work on `codex/vm-pmo-video-editing`; the VM foundation exists only in that working tree. Work in place without committing unrelated work.
- Taskboard and Bridge remain `127.0.0.1` only. Independent download jobs never obtain Auto-Cut eligibility.
- No real approval submissions, download consumption or test notifications during development. Use fixtures.
- No credentials or download URLs in queue, UI, logs, docs or Git. No invented refresh or cross-device authorization endpoints.
- Keep current single-submit and resource reservation semantics. Add meaningful behavioral tests before implementation.

## Task 1: Shared Shadow session

Files: create `taskboard/server/vm-download-session.mjs`, `taskboard/test/vm-download-session.test.mjs`; update `vm-approval-client.mjs` and its tests.

Interface: `createVmDownloadSession({now,startLogin,createClient,checkIntervalMs,onChange})` returns `snapshot(), client(), beginLogin(), disconnect(), check(), close()`. `beginLogin` returns `{loginUrl,session}` immediately; completion occurs internally. `client()` returns authenticated client or null. The factory's `createClient` receives `{token,onToken}`. Client adds optional `onToken` callback for valid rotated token; never exposes raw token in snapshots.

- [x] Test pending login reuse, delayed login after disconnect, identity rejection, JWT exp metadata, token rotation, transient network errors, reconnect and close.
- [x] Implement session with generation guard and sanitized status; verify through mocked remote transport only.
- [x] Run `node --test taskboard/test/vm-download-session.test.mjs taskboard/test/vm-approval-client.test.mjs taskboard/test/vm-approval-auth.test.mjs`.

## Task 2: Waiting lifecycle

Files: update `vm-approval-workflow.mjs`, extend workflow tests.

Interface: `extendVmApprovalWait(store,id,{now=Date.now,waitMs=604800000})` extends only `VM_APPROVAL_WAIT_EXPIRED` or `VM_MEDIA_WAIT_EXPIRED` states using a lease, retaining request and application. Add `approval_wait_started_at/approval_deadline_at` after unique application binding and `media_wait_started_at/media_deadline_at` only after APPROVED. Summary includes safe timing and request display fields. Existing queued stale age guard remains separate.

- [x] Test normal PENDING beyond six polls, seven-day deadline, approved-media independent deadline, extension without duplicate submit, terminal states and restart persistence.
- [x] Implement and preserve auth/submission/download safeguards; run workflow/CLI/store tests.

## Task 3: Panel UI

Files: create `web/src/components/VmDownloadsPanel.tsx`, its test and `web/src/vmDownloads.ts`; mount in `LocalSettingsDialog.tsx`, add scoped CSS and test command.

Interface: consume API contract from spec. Use same-origin backend only and existing API helpers or bounded local wrapper. Display no credential input; batch VMID textarea, department/reason/path, login state, jobs and per-job recovery actions. Refresh while mounted and stop on unmount. Display unknown expiry truthfully; successful background SSO reflected by refresh. Show notification availability and persistent server errors.

- [x] Test disconnected-to-login interaction, batching, pending/ready/rejected states, extension/retry, network errors and poll cleanup.
- [x] Implement UI, including visible control to open a blocked login popup. Run focused component tests and typecheck.

## Task 4: Queue service, notifications and API integration

Files: create `vm-download-service.mjs`, `vm-download-notifier.mjs`, tests and API test; modify `app.mjs`, README and acquisition documentation.

Interfaces: service owns `snapshot/updateSettings/beginLogin/logout/enqueue/resume/extend/start/close` and uses `createVmDownloadSession`. Notification transport uses official SDK bot identity and the verified session's enterprise email (open IDs are app-specific). Notification receipts use a separate SQLite outbox with leases, so state updates cannot overwrite active jobs. App lifecycle starts and closes worker. Download origin policy comes from trusted server options/config only.

- [x] Test real SQLite restart, coalesced wake/run, authentication recovery, completed job no replay, notification dedup/failure, batch validation and max size, no process/environment tokens leaked.
- [x] Implement service with bounded single loop and safe shutdown. Build text notifications with no links or token, explicit errors and retry timing.
- [x] Test HTTP routes using isolated Taskboard server; reject invalid Origin, Host, client header, body and query. Use injected fake session/client/notifier for all remote behavior.
- [x] Update README and docs with actual capabilities and restart/session limits.

## Task 5: Review and verification

- [x] Run focused tests for each changed module then root `npm test` once integration is complete.
- [ ] Desktop/narrow browser inspection remains unavailable: browser inventory was empty and both IAB/Chrome returned unavailable. Isolated fixture server, built asset HTTP 200, five simulated queue states and component coverage verified; fixture server stopped.
- [x] Independent review for credential exposure, duplicate submission/consumption, loopback-only enforcement, account binding and races; fix findings and re-run affected tests.
- [x] Summarize delivered UI entry, validation evidence and remaining upstream Shadow limitations.

## Verification result

Final `npm test` passed: 2,083 backend tests, 7 platform skips; TypeScript and web build passed; 171 component tests passed. Task reviews and final independent review found no remaining blocking issues. No production requests, service restarts, commits or publishing performed. The existing uncommitted workspace is preserved.
