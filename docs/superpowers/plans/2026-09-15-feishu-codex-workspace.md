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

## Empty workflow board follow-up

After the catalog began succeeding, the existing generic zero-task import page took precedence over the Feishu board. Keep the board visible by sharing `resolveAiImportProjectId` between catalog probing and empty-page rendering; it excludes source-managed Feishu projects and subjects identified by the navigator. The render branch must check current eligibility as well as the asynchronously captured readiness so stale responses cannot hide workflow columns.

- Add behavioral eligibility tests covering AI availability transitions, Feishu identification before project refresh, and ordinary/Jira/global/loading/non-empty cases.
- Verify the real zero-task subject still renders its configured nine columns with catalog success.
- Run focused selection/board tests, the full standard check, and independent review; rebuild the web assets without restarting the running Bridge.

### Follow-up validation evidence

- Focused selection, home, and workflow board tests: 62 passed.
- Full npm test: 1,560 Node tests passed, 3 skipped, 0 failed; 42 component tests passed; typecheck and web build succeeded.
- Browser verification of the originally affected zero-task subject: all nine workflow columns remain in the page, and the Codex panel opens with its model selector and no workspace error.
- check-local.ps1 -RequireFeishu passed after the web rebuild; the listener remains sdk_managed. No production table event or Auto-Cut job was triggered.
- Independent follow-up review: no actionable defects. A full App component test for late catalog responses remains a non-blocking coverage improvement; the shared eligibility rules and current render guard were reviewed directly.
