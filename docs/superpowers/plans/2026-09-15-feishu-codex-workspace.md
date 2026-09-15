# Feishu Codex workspace implementation plan

**Goal:** Open the Codex panel for a Feishu subject using its configured enabled package workspace.

**Architecture:** Reuse the project's server-owned `subjectKey` and the workflow store's `getSubject` lookup from the shared local AI context resolver only for requests without a task. Keep existing task provenance and snapshot resolution intact.

**Tech stack:** Node.js, SQLite, native test runner, existing Taskboard HTTP APIs.

## Constraints

- Loopback listeners only; do not change automatic execution eligibility.
- No local credentials, registries, database contents, or runtime files in Git.
- Use the subject's fixed alias, never cells or a same-ID fallback for a bound subject.
- No new package reference/deletion rules in this change.

## Implementation and verification

- [x] Add API regressions in `taskboard/test/ai-chat-server.test.mjs` with an isolated Feishu subject, a null project workspace, and a package using a different project ID. Assert catalog 200 and thread 201 with the trusted registry directory. Assert missing/disabled/draft packages fail and ordinary task markers do not unlock the workspace.
- [x] Run `node --test taskboard/test/ai-chat-server.test.mjs` and confirm the new positive cases fail with `PROJECT_WORKSPACE_UNAVAILABLE` before changing production code.
- [x] Share the existing workflow store instance with `resolveAiChatContext` in `taskboard/server/app.mjs`. Use `project.source === "feishu"` and `project.subjectKey` with `getSubject` instead of adding a database API. Validate fixed route, own registry alias, and enabled state before existing directory checks.
- [x] Verify subsequent turns recheck availability and workspace changes; existing task snapshots and ordinary task restrictions retain their meaning.
- [x] Update the root and Taskboard READMEs to describe subject package workspace resolution and troubleshooting.
- [x] Run focused AI/workflow/package tests, then `npm test` for all Node tests, typecheck, web build, and component tests.
- [x] Obtain independent review, address findings, and verify the final diff. Start the local stack with the prior intended Feishu mode and check the repaired catalog when feasible; do not trigger production table events or Auto-Cut jobs for this check.

## Validation evidence

- Focused AI API suite: 25 passed. The initial reproduction returned PROJECT_WORKSPACE_UNAVAILABLE before the fix.
- Full npm test: 1,558 Node tests passed, 3 skipped, 0 failed; 42 component tests passed; typecheck and web build succeeded.
- Independent review: no actionable findings.
- Local startup with -EnableFeishu and check-local.ps1 -RequireFeishu succeeded; listener reports sdk_managed.
- The originally failing project catalog returned 6 models, 67 skills, and 52 commands; composer returned 3 candidates. These checks did not send a conversation turn or trigger an Auto-Cut job.
