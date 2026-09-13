# Feishu Subject Phase Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every newly imported Feishu table and every existing legacy subject expose and persist an independent three-stage configuration based only on that table's metadata.

**Architecture:** Add one server-side default builder for a subject's metadata snapshot. Use it when creating a new subject and when upgrading a legacy subject during catalog refresh/listing, while preserving existing per-subject execution, package, upload, display, and local path values. Keep the React editor's existing stage editor and metadata selectors; make its form fallback phased for metadata-backed subjects so an old row is usable even before a refresh mutation.

**Tech Stack:** Node.js ESM, SQLite-backed Taskboard workflow store, React/TypeScript, Vitest, Node test runner.

## Global Constraints

- Keep each subject isolated by `subjectKey = baseToken:tableId`.
- Derive field and option IDs only from the current table's `metadata.fields`.
- New subjects start as `draft`; a legacy `enabled` subject is demoted to `draft` on metadata refresh, while an already `disabled` subject remains `disabled`. Never enable a subject or alter the Bridge active snapshot implicitly.
- Preserve existing package aliases, execution/upload settings, display state, and machine-local paths.
- Keep Bridge and Taskboard loopback-only and do not add credentials, paths, commands, or prompts to Feishu data.
- Update automated tests and README for the behavior change.

---

### Task 1: Server-side per-subject phased defaults

**Files:**
- Modify: `taskboard/server/feishu-workflow-store.mjs`
- Test: `taskboard/test/feishu-workflow-store.test.mjs`

**Interfaces:**
- Add an internal `phasedDefaultsForSubject({ subjectKey, baseToken, baseName, tableId, tableName, projectId, metadata, existing })` helper returning a draft-compatible subject object containing `statusField`, `documentField`, `namingField`, and all three `stages`.
- `upsertBasePreview()` uses the helper for a new table and for an existing legacy table; existing phased subjects continue through the current refresh path.

- [ ] **Step 1: Write the failing tests**

Add tests asserting that a new table gets all three stage keys, that its status/document/naming bindings come from its own metadata, and that two tables with different field IDs do not share bindings. Add legacy-row tests that insert the old subject shape, refresh the Base preview, and expect a phased draft while retaining the old execution/package/upload/display fields, plus a disabled legacy row that remains disabled after the phased migration.

- [ ] **Step 2: Run the focused tests to verify failure**

Run:

```powershell
npm --prefix taskboard test -- --test-name-pattern "phased defaults|legacy subject|independent"
```

Expected: FAIL because `upsertBasePreview()` currently creates a legacy subject without `statusField`, `documentField`, `namingField`, or `stages`.

- [ ] **Step 3: Implement the minimal default builder**

Use the current table metadata to select the first single-select field as `statusField`, the first remaining field as `documentField`, and the next remaining field (or the document field when only one remains) as `namingField`. Use controlled `pending_*` identifiers and `待配置` labels when a required binding cannot be inferred. Create fixed stage entries with `initial.enabled === true`, review stages disabled, docx sources (`录屏`, `修改意见`), video-original audio, and suffixes `_初稿`, `_初审修改`, `_终审修改`; map available status options by index and leave missing option bindings pending.

Validate the generated object structurally with metadata detached, then restore the table metadata so drafts can be displayed and repaired even when metadata is incomplete. Keep `existing` values for fields already present and only fill missing phased keys for legacy rows.

- [ ] **Step 4: Run focused tests to verify success**

Run the same focused command and expect PASS, including assertions that the second subject's field IDs and option IDs remain its own.

- [ ] **Step 5: Commit the server change**

```powershell
git add taskboard/server/feishu-workflow-store.mjs taskboard/test/feishu-workflow-store.test.mjs
git commit -m "feat: initialize per-subject phased workflow defaults"
```

### Task 2: Legacy subject display fallback in the editor

**Files:**
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.tsx`
- Test: `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`

**Interfaces:**
- `formForSubject(subject)` must create `stageDefaults(subject, fields)` for any metadata-backed subject that lacks persisted phased keys.
- No new global state or shared template is introduced; the form continues to use the selected subject's metadata and subject-keyed audio draft cache.

- [ ] **Step 1: Write the failing component test**

Render a legacy subject with table metadata but no `statusField`, `documentField`, `namingField`, or `stages`. Assert that the panel renders the `状态字段`, `素材文档字段`, `命名字段`, `初稿`, `初审修改`, and `终审修改` controls, and that the status options come from that subject's metadata.

- [ ] **Step 2: Run the component test to verify failure**

Run:

```powershell
npm --prefix taskboard run test:components -- web/src/components/FeishuWorkflowPanel.test.tsx -t "legacy subject"
```

Expected: FAIL because `formForSubject()` currently returns `stages: null` for a legacy subject.

- [ ] **Step 3: Implement the fallback**

Change only the `stages` condition in `formForSubject()` so metadata-backed subjects use `stageDefaults(subject, fields)`. Keep subjects with no metadata and no phased fields on the legacy form, preserving existing behavior for older manually configured rows without a metadata snapshot.

- [ ] **Step 4: Run component tests and typecheck**

Run:

```powershell
npm --prefix taskboard run test:components -- web/src/components/FeishuWorkflowPanel.test.tsx
npm --prefix taskboard run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the editor change**

```powershell
git add taskboard/web/src/components/FeishuWorkflowPanel.tsx taskboard/web/src/components/FeishuWorkflowPanel.test.tsx
git commit -m "fix: show phased editor for metadata-backed subjects"
```

### Task 3: Documentation and full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Document the per-subject initialization and migration contract without exposing credentials or machine-local paths.

- [ ] **Step 1: Update README**

Add the behavior to the workflow configuration section: every imported table receives the complete three-stage draft surface, stage and field bindings are per subject, and legacy rows are upgraded without changing active execution state.

- [ ] **Step 2: Run the complete verification suite**

Run:

```powershell
npm test
```

Expected: exit code `0`; Node tests, Taskboard typecheck, web build, and component tests all pass.

- [ ] **Step 3: Inspect the final diff**

Run:

```powershell
git diff --check HEAD~2..HEAD
git status --short
```

Confirm only the intended feature commits and the pre-existing user changes are present; do not stage or revert unrelated files.

- [ ] **Step 4: Commit the documentation**

```powershell
git add README.md
git commit -m "docs: describe per-subject phased configuration"
```
