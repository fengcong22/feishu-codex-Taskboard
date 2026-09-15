# Preserve task cards when returning to a project

**Goal:** Returning from another panel to the same Feishu project, or selecting the current project again, preserves task cards without a page reload.

**Evidence:** In the real local UI, switching between two distinct Feishu projects loads their tasks. Opening Auto-Cut packages and then selecting the same subject clears its task count from one to zero. changeProject always clears project data and increments request generations, but task-loading effects only rerun when the selected project or subject changes.

**Design:** Only invalidate and clear project data when the project/subject/task scope changes. Same-project view navigation retains loaded data and current in-flight requests. Remove redundant context invalidations from configuration navigation that already calls changeProject; pass an explicit subject when a freshly added subject is not yet in the current catalog. Cross-project switches retain existing stale-response protections.

**Constraints:** Frontend repair only. Keep the real Feishu listener and running Auto-Cut task active; use read-only live checks and isolated component fixtures.

## Verification

- [x] Add real App component regressions for same-project reselection, package-panel return, different-project round trips, and delayed task responses.
- [x] Confirm the same-project cases fail before implementation.
- [x] Implement scope-aware project navigation and update README.
- [x] Run component tests, existing project-selection tests, typecheck, and the standard npm test command.
- [x] Obtain independent review and verify the reproduced UI route against the rebuilt frontend.
- [x] Commit locally after validation (this commit).

Initial regression run reproduced three same-scope failures while two cross-project controls passed. All eight final component cases pass, including configuration navigation and pending requests. Existing project selection/home tests pass (29), and the workflow UI contract tests pass (10) after updating their expected navigation signature. Independent read-only code review found no actionable findings.

Final `npm test` passed: 1,560 Node tests passed, 3 skipped, zero failures; TypeScript checking and the web build succeeded; all 61 component tests passed. The rebuilt local UI retained FEI-29 after Auto-Cut packages → the same subject, repeated selection of the current subject, and a different-subject round trip, without further reloads. Its processing duration continued advancing throughout verification. `check-local.ps1 -RequireFeishu` passed with the listener still `sdk_managed` and the existing four dead letters unchanged. No services were restarted or live task/Feishu records mutated.
