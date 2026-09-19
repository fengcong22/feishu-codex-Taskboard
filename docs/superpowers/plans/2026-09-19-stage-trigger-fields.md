# Stage Trigger Fields and Package Labels

**Goal:** Display the current Auto-Cut package name and configure separate initial and review trigger fields.

**Architecture:** Keep `statusField` for initial stages and add optional `reviewStatusField` for both review stages. When absent, use `statusField` for backward compatibility. Explicit empty selections must remain empty. Match events and lifecycle actions by field ID plus option ID. Keep package aliases and project IDs stable.

**Tech Stack:** React, TypeScript, Node.js, SQLite, Feishu official SDK.

## Constraints

- Preserve video/audio sources, delivery, writeback and existing history.
- Retain loopback authentication and controlled task registration.
- Preserve active snapshots until the user saves and enables the updated draft.
- Use fixtures for event tests; do not mutate production records.

## Work

- [x] Share the existing package name formatter between manager and route selector; test current version display with stable alias.
- [x] Add two selectors and field-specific options; test old configurations, independent clearing, save/reopen, deleted and renamed bindings.
- [x] Normalize, store, share and validate reviewStatusField; test legacy fallback and explicit clearing.
- [x] Route both event fields and archive only matching field/stage todo tasks; test simultaneous edges and option ID reuse across fields.
- [x] Update README, review changes, run component/server regressions and build.
- [x] Inspect responsive screenshots, then reload local services after checking active runs.
