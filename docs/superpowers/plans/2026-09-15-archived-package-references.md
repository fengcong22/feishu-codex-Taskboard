# Archived Auto-Cut package references

**Goal:** Archived, inactive tasks no longer prevent deleting a package; restoring a registered task requires its package to exist and be enabled.

**Design:** Package listing and deletion continue to share `TaskboardDatabase.listPackageReferences`. Preserve enabled workflow references and independent execution reservations/active runs, including archived tasks. Keep historical tasks, provenance, package snapshots, artifacts and event deduplication records. Serialize restoration with package mutations so deletion cannot race a successful restore. Restore does not enqueue or authorize execution.

**Constraints:** Follow the root AGENTS.md. Use loopback-only servers with temporary fixture data; do not change production configuration or credentials. No schema migration or cleanup of historical records. The user approved this design in the current conversation.

## Implementation

- [x] Reproduce archived-task deletion and unavailable-package restoration with failing HTTP/database tests.
- [x] Update `taskboard/server/database.mjs` reference checks and tests in `taskboard/test/feishu-package-references.test.mjs`. Check pending/running execution reservations, launch claims and active runs independently of archive/status filters. Keep active configuration versions protected while new drafts are edited.
- [x] Add serialized enabled-package validation in `taskboard/server/feishu-package-config.mjs` and use it at the restore boundary in `taskboard/server/app.mjs`. Test missing/disabled/draft packages, normal restores, spoofed markers, retained snapshots and concurrent delete/restore. Read the request body before checking current task state so delayed bodies cannot bypass validation.
- [x] Update root and Taskboard READMEs with deletion/restoration rules and target-computer upgrade steps.
- [x] Run focused tests, then root `npm test` (Node tests, typecheck, web build and component tests).
- [x] Independently review the diff, resolve material findings, and report validated changes plus target-computer deployment limitations.

## Verification record

- Focused package config/reference/restore/API suites: 47 passed, 0 failed. Includes a real HTTP request whose body is delayed while archival and package deletion complete.
- Independent read-only review found no actionable issues; its separate reference suite passed all 16 cases.
- Isolated example project: 10 checks passed with real loopback HTTP, a temporary SQLite database and file-backed package registry. Verified archived reference count 1 to 0, successful deletion with provenance/snapshot/event lookup preserved, rejected restoration after deletion, and blocking references from execution reservations, AI turns and enabled configuration versions. No Codex or other child process was launched; the temporary server and data were cleaned up.
- Existing HTTP archival cancels delayed/queued reservations. A reservation only blocks package deletion while it remains persisted; running execution remains protected after HTTP archival.
- Two initial full-suite attempts encountered Fetch `bad port` failures in unrelated HTTP fixtures. This Windows host allocates ephemeral ports in 1024–15000, overlapping Fetch-forbidden ports. Final verification runs the unchanged `npm test` while a temporary helper reserves available forbidden ports on loopback; it releases every reservation afterward. No OS port setting or tracked application/test code is changed for this workaround.
- Final root `npm test`: exit 0; Node tests 1,543 passed, 0 failed, 3 environment skips; TypeScript check and production web build passed; component tests 42 passed. Two browser checks skipped because Chrome/Chromium is unavailable, and one symlink check skipped because Windows returned EPERM. Existing CSS pseudo-element and large-bundle warnings remain. The final log confirms all 19 temporary port reservations were released.
- `git diff --check` passed. The current local stack passed the read-only health check, with `sdk_managed` listener state and four pre-existing dead-letter records; this is not evidence that the running service has loaded this repair. No production state, package binding, credentials or service lifecycle was changed.
- This change needs no database migration. Target-computer deployment must use the reviewed revision and preserve that computer's credentials, local package registry and runtime data; it cannot be verified from this local checkout.
