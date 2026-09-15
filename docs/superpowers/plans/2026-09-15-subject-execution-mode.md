# Subject Execution Mode Implementation Plan

**Goal:** Expose a shared mode for every subject and default newly discovered subjects to automatic drafts.

**Architecture:** Reuse subject-level `execution.mode` and existing save/enable lifecycle. Expose the effective server policy as read-only metadata and pass it into the workflow panel.

**Tech Stack:** Node.js, SQLite, React, TypeScript, node:test, Vitest and Testing Library.

## Constraints

- User has approved the design and implementation; continue without another design approval round.
- Work in `D:/codex/worktrees/feishu-subject-execution`, branch `codex/subject-execution-mode`.
- Keep existing values and manual fallbacks for historical/shared missing fields.
- Keep loopback, trusted registration, enabled package whitelist and simulation exclusion.
- Never mutate live settings, tasks, state files or service lifecycle for verification.

## Tasks

- [x] Add store regressions in `taskboard/test/feishu-workflow-store.test.mjs`: new metadata creates automatic drafts, existing manual/automatic values and missing-field compatibility survive refresh/restoration. Run `node --test taskboard/test/feishu-workflow-store.test.mjs`, observe the new-default failure, then update only the new-subject fallback in `taskboard/server/feishu-workflow-store.mjs`.
- [x] Add panel tests in `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`: one mode control for phased and legacy subjects; switching saves top-level mode and retains other values; no enable occurs from selection/save; global policy true/false/undefined is clearly displayed. Run `npm --prefix taskboard run test:components`, observe missing controls, then move mode and existing concurrency controls into a common fieldset above stages.
- [x] Add HTTP policy tests in `taskboard/test/task-start-flow.test.mjs` or existing server fixture tests. Return `capabilities: { localAiChat, automaticExecution: allowAutomaticExecution }` in local `/api/meta`. Add `automaticExecution?: boolean` to `TaskboardCapabilities`; include it in App metadata comparison and pass `allowAutomaticExecution={taskboardMetadata?.capabilities?.automaticExecution}` to the panel. Unknown policy must not display enabled.
- [x] Update root README and Taskboard Chinese/English README with new defaults, configuration navigation, draft publication, historical-value retention, read-only total policy and independent upload controls.
- [x] Run focused tests and an isolated test-table lifecycle covering new draft -> save -> enable -> trusted automatic registration, plus manual/global-off/simulation gates with a fake execution runner.
- [x] Run root `npm test`, inspect exit status and failures. Resolve regressions without touching unrelated production behavior. Run `git diff --check`.
- [x] Obtain an independent read-only code review against `ab1eeee`, fix material findings and rerun affected checks.
- [x] Commit only this feature. Report exact test results and branch/commit; leave merging main for explicit authorization.

## Verification record

- Store regression red run: 2 expected new-default failures; green run: 77 passed. Shared import and project lifecycle: 22 passed.
- Component red run: 7 failures for the missing common controls/status; green run: 42 passed.
- HTTP metadata red run: 2 missing-property failures; green task-start/cloud companion run: 72 passed.
- Isolated workflow integration plus registration/coordinator suites: 91 passed. The fixture uses a temporary database, a loopback Bridge and a fake Codex executable; it exercises automatic -> manual -> automatic publication without rewriting historical tasks.
- Final root `npm test`: exit 0, Node tests 1,516 passed / 3 environment skips / 0 failed, TypeScript check passed, production web build passed, component tests 42 passed. Two existing browser checks skipped because Chrome/Chromium was unavailable; the existing symlink check skipped because symlink creation returned EPERM.
- The existing automatic-policy test assumed the launcher variable was unset. It now restores and isolates that variable while testing the default; server metadata fixtures explicitly declare their policy.
- One intermediate run hit a transient Wrangler local-persistence connection failure. Its isolated rerun and the final full suite passed. Existing CSS pseudo-element and large-bundle build warnings remain.
- Independent read-only review found no actionable issues. `git diff --check` passed. A fresh `git fetch origin main` confirmed the feature base is still current (`ab1eeee`).
