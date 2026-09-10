# Workflow Metadata Refresh Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stable Feishu field/option IDs survive metadata renames without stale hidden values, preserve unsaved operator edits during metadata refresh, and block save/enable when a configured option ID is missing or ambiguous.

**Architecture:** Canonicalize metadata-owned display names at the Taskboard store boundary before validating a refreshed snapshot, while retaining unresolved IDs for repair. In React, reconcile only metadata-owned field and option names into the current draft when the same subject receives a new configuration version; keep operator-owned values untouched and validate IDs against unique live metadata entries. Keep the legacy top-level trigger synchronized with the first enabled phased trigger so Bridge compatibility fields cannot drift.

**Tech Stack:** Node.js test runner, React 19, TypeScript, Vitest/Testing Library, SQLite-backed Taskboard workflow store.

## Global Constraints

- Keep workflow schema version 1 and the existing three fixed stage IDs.
- Do not modify, build, install, or deploy Auto-Cut Lite.
- Keep Bridge and Taskboard loopback-only; do not alter execution eligibility, package allowlisting, event routing, or credential handling.
- Preserve unknown/missing metadata bindings as visible draft state, but never allow them to save or enable silently.
- Apply TDD: every production change follows a focused failing regression test.
- Update the existing operator README only if user-visible behavior wording changes.

---

### Task 1: Store-Side Metadata Rename Reconciliation

**Files:**
- Modify: `taskboard/test/feishu-workflow-store.test.mjs`
- Modify: `taskboard/server/feishu-workflow-store.mjs`

**Interfaces:**
- Consumes an existing phased subject plus a new live metadata snapshot.
- Produces a draft snapshot whose field/option display names are refreshed by stable IDs; unresolved IDs and attachment bindings remain preserved for explicit repair.

- [ ] **Step 1: Add a store regression test for an option rename with the same option ID.**

  Save and enable a phased subject, refresh metadata with `opt_ready` renamed from `待制作` to `新待制作`, and assert refresh succeeds, demotes to draft, increments the version, updates `statusField.fieldName`, all resolvable stage trigger names/values, and the top-level `trigger` compatibility fields.

- [ ] **Step 2: Run the focused test and verify RED.**

  ```powershell
  node --test --test-name-pattern="reconciles renamed phased metadata" taskboard/test/feishu-workflow-store.test.mjs
  ```

  Expected: `TRIGGER_OPTION_NOT_FOUND` from validating the stale name against refreshed metadata.

- [ ] **Step 3: Add the minimal metadata-name reconciliation helper.**

  Resolve fields and options only when an ID has exactly one match. Update field names and matched option values; preserve unresolved IDs/values for the repair UI. Set the legacy top-level trigger from the first enabled stage after reconciliation. Call the helper only on metadata refresh before structural validation.

- [ ] **Step 4: Run the focused store test GREEN, then the entire store suite.**

  ```powershell
  node --test taskboard/test/feishu-workflow-store.test.mjs
  ```

- [ ] **Step 5: Commit the store repair.**

  ```powershell
  git add taskboard/test/feishu-workflow-store.test.mjs taskboard/server/feishu-workflow-store.mjs
  git commit -m "fix: reconcile renamed workflow metadata"
  ```

---

### Task 2: Draft-Preserving UI Reconciliation and Strict Option Validation

**Files:**
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.tsx`

**Interfaces:**
- Consumes the current local `SubjectForm`, previous selected subject identity/version, and latest selected subject metadata.
- Produces a reconciled form that changes only metadata-owned names/option values and keeps operator-entered suffixes, source titles, attachment selections, and tolerances.

- [ ] **Step 1: Extend the rename test to assert the hidden legacy trigger payload.**

  Assert `patch.trigger.fieldName`, `patch.trigger.optionId`, and `patch.trigger.startValue` equal the first enabled stage after an option rename.

- [ ] **Step 2: Add a rerender regression preserving an unsaved suffix and audio title across a metadata version refresh.**

  Rerender the same subject with `configVersion + 1` and renamed field/option metadata. Assert the operator values remain, metadata-owned names update, and Save submits both sets correctly.

- [ ] **Step 3: Add missing and duplicate option-ID validation cases.**

  For an enabled stage whose ID has zero or two live matches, assert Save and Enable are disabled with a stage-specific error. Assert a unique ID with a stale name becomes dirty and is repaired on Save.

- [ ] **Step 4: Run component tests and verify RED.**

  ```powershell
  npm --prefix taskboard exec -- vitest run web/src/components/FeishuWorkflowPanel.test.tsx --environment jsdom
  ```

- [ ] **Step 5: Implement minimal same-subject reconciliation and validation.**

  Track the previous selected subject/version in a ref. On a version change for the same subject, reconcile metadata-owned names into the existing form; on a subject switch, fully initialize from persisted state. Reset audio draft caches only for a true persisted save/reload, and preserve them during metadata-only refresh. Require each enabled stage option ID to resolve exactly once and its value to match before Save or Enable. Serialize the top-level trigger from the first enabled stage for phased subjects.

- [ ] **Step 6: Run component tests GREEN plus typecheck.**

  ```powershell
  npm --prefix taskboard exec -- vitest run web/src/components/FeishuWorkflowPanel.test.tsx --environment jsdom
  npm --prefix taskboard run typecheck
  ```

- [ ] **Step 7: Commit the UI repair.**

  ```powershell
  git add taskboard/web/src/components/FeishuWorkflowPanel.test.tsx taskboard/web/src/components/FeishuWorkflowPanel.tsx
  git commit -m "fix: preserve workflow drafts on metadata refresh"
  ```

---

### Task 3: Review and Final Verification

**Files:**
- Review all changes since `c582f31bf5df017599c4a59e96c7e59734d5ef09`.

- [ ] **Step 1: Run focused store/API/component suites.**

  ```powershell
  node --test taskboard/test/feishu-workflow-store.test.mjs taskboard/test/feishu-workflow-api.test.mjs
  npm --prefix taskboard run test:components
  ```

- [ ] **Step 2: Request independent code review and resolve every Critical/Important finding.**

- [ ] **Step 3: Run the required repository suite with automatic execution disabled.**

  ```powershell
  $env:CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION=$null
  npm test
  git diff --check
  git status --short --branch
  ```

- [ ] **Step 4: Confirm the final branch remains local-only unless the user explicitly requests a push.**

