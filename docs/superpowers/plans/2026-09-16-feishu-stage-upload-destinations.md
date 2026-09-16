# Feishu stage upload destinations implementation plan

> Execute the user-approved design in this task, with independent frontend work and a final code review.

**Goal:** Make the three stage ZIP destinations the only editable upload destinations for phased workflows.

**Architecture:** Keep stage snapshots as the authority when enqueueing phased uploads. Retain the legacy subject upload path and optional target alias in stored configurations and historical records for compatibility. Adjust the editor, activation validation, and shared configuration diagnostics consistently; do not change upload routing or migrate existing task snapshots.

**Tech Stack:** React/TypeScript, Node.js, SQLite, Vitest and Node test runner.

## Constraints

- Keep loopback binding, trusted Bridge registration, automatic execution gates and simulation restrictions unchanged.
- Preserve legacy workflow upload destinations and existing optional aliases.
- Require destinations only for enabled stages when automatic upload is selected; disabled stages may remain empty.
- Keep ZIP source settings, enqueue policy and concurrency visible.
- Do not edit local credentials, live configuration, production records or task state.

## Tasks

- [x] Frontend: add regression coverage for enabling phased automatic uploads with only stage destinations, missing enabled destinations, and preservation of legacy upload data on save. Remove the alias input and show the common upload path only for legacy forms. Guard the common path activation check with `!phased`.
- [x] Backend: reproduce the activation rejection using a phased example with `upload.targetPath: null`, then restrict the common path requirement to legacy subjects. Keep stage destination checks and task snapshots intact. Check sharing diagnostics for obsolete common-path requirements and cover any required correction with focused tests.
- [x] Compatibility: verify real fixture uploads still enqueue to the frozen stage destination without a common path, while legacy automatic uploads still require their common path.
- [x] Documentation: update the repository README and Taskboard Chinese README to explain source versus stage destinations and compatibility behavior.
- [x] Validation: run focused regressions, root `npm test` (Node tests, TypeScript, web build, component tests), and inspect the final diff. Request independent code review and fix material findings. Use isolated example fixtures for end-to-end coverage.

## Expected behavior

For a phased subject with initial enabled at `C:\\approved\\initial` and disabled review stages with no destinations, automatic upload can be enabled while `upload.targetPath` and `upload.targetId` are null. Clearing the initial destination blocks activation. A saved historical common path or alias remains stored but does not override any phased task's frozen destination. A legacy subject continues to use and validate its common upload path.

## Verification results

- New frontend and activation regressions failed on the original common-path requirement, then passed after the change.
- Isolated lifecycle fixtures verified ZIP registration and enqueueing with and without historical common settings, retaining the task's original stage destination after a new configuration was enabled.
- Root `npm test` exposed a stale shared-import assertion, which now verifies the exact local stage diagnostics and exclusion of the Bridge common-path warning. A later default-concurrency run hit an existing 600 ms preflight timeout; that test passed in isolation.
- Complete Node suite with `node --test --test-concurrency=4`: 1,670 passed, 3 skipped, 0 failed. `WRANGLER_SEND_METRICS=false` was set only for the test command to avoid telemetry delays.
- Component suite: 92 passed. TypeScript and web build passed; Vite reports its existing large-chunk warning.
- Independent code review found no actionable issues; final diff whitespace check passed.
- Local stack check found Taskboard stopped. Validation used isolated local fixtures without starting the production stack or changing live configuration.
- The user subsequently opened the updated page and confirmed the UI acceptance check passed on 2026-09-16.
