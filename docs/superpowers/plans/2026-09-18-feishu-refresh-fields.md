# Refresh Feishu fields

**Goal:** Provide a manual “刷新字段” action in the subject configuration header, visible across all four tabs, without re-adding a Base link.

**Approved scope:** The user accepted a refresh-fields action that updates fields/options by stable IDs while preserving configuration. This implementation adds only the manual action, not periodic background refresh.

**Architecture:** POST `/api/local/feishu/workflow/bases/:baseToken/refresh-metadata` with `{}` returns `{base}`. The server resolves the registered Base through the existing authenticated Bridge metadata reader. Refresh only existing subjects, retain removed subject state, preserve enabled snapshots, and use existing metadata draft reconciliation. The UI merges the refreshed Base into the latest catalog without selecting a different subject, preserving unsaved same-subject edits.

**UX:** Secondary button with refresh icon beside the subject heading. Pending feedback disables repeat requests; success shows a refresh time, failure retains the last catalog and allows retry. Fields or options no longer present in the Base clear to “请选择” and require an explicit re-selection; the system never auto-binds a same-named replacement. API requests time out after 15 seconds, including a hanging response body.

## Steps

- [x] Add API/store tests for refresh, identity validation, strict inputs, failure without mutation, removed subjects and immutable active snapshots; implement minimal endpoint/store support.
- [x] Add UI tests for new fields/options, preserved drafts, feedback/retry, and late responses after subject/Base navigation. Add bounded client request tests; implement the header action and responsive styles.
- [x] Update README with placement and draft/active behavior. Run relevant server tests, components, TypeScript and diff checks. Review changes independently.
- [ ] Check local execution state, build and reload service preserving listener state and package settings, then inspect the browser header and refresh feedback.

No credentials or production records are modified. Bridge routes, task routing, ZIP contracts and the loopback-only listener remain unchanged.
