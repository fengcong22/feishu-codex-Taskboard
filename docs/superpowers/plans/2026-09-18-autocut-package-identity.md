# Auto-Cut Package Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new Auto-Cut package validate a selected workspace, derive stable identity defaults, and show a read-only versioned package name without altering existing routing keys.

**Architecture:** A local Taskboard API reads only fixed JSON manifests below a user-selected absolute workspace and returns normalized display metadata plus collision-safe internal IDs. The package editor uses that result only as an unsaved draft; the registry continues to persist and route by its existing `alias` and `projectId` fields.

**Tech Stack:** Node.js ESM, Taskboard local HTTP API, React/TypeScript, Vitest, node:test.

## Global Constraints

- Keep Bridge and Taskboard on loopback; do not expose the inspection API beyond the existing local API.
- Read `.codex-plugin/plugin.json` and `PACKAGE-MANIFEST.json` only; do not execute package code or scripts.
- Display plugin versions as `major.minor.patch`, excluding build metadata such as `+codex...`.
- Do not rewrite an existing package's `alias`, `projectId`, stored name, active references, or history.
- Lock persisted aliases and project IDs against later API mutation.

---

### Task 1: Package Workspace Inspection API

**Files:**
- Create: `taskboard/server/feishu-package-identity.mjs`
- Modify: `taskboard/server/feishu-package-api.mjs`
- Test: `taskboard/test/feishu-package-api.test.mjs`

**Interfaces:**
- Produces `inspectAutoCutPackageWorkspace({ workspacePath, existingPackages })` returning `{ displayName, pluginVersion, runtimeVersion, defaultPrompt, alias, projectId }`.
- Produces `POST /api/local/autocut/packages/inspect-workspace` with `{ workspacePath }`; it does not persist a registry entry.

- [ ] **Step 1: Write failing API tests** for parsing `plugin.json` and `PACKAGE-MANIFEST.json`, normalizing `1.6.9+codex.202609...` to `1.6.9`, reading a default prompt, and returning collision-safe candidate IDs.

- [ ] **Step 2: Run the focused test** with `node --test taskboard/test/feishu-package-api.test.mjs` and confirm the endpoint is absent.

- [ ] **Step 3: Add the read-only inspection helper and API branch.** Accept an absolute existing directory, parse only the two fixed JSON paths, return normalized metadata, and use safe API errors for malformed or missing manifests.

- [ ] **Step 4: Run the focused test** and confirm it passes.

### Task 2: Lock Technical Routing IDs

**Files:**
- Modify: `taskboard/server/feishu-package-config.mjs`
- Test: `taskboard/test/feishu-package-config.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Existing `store.saveDraft(alias, patch, expectedRevision)` accepts initial aliases and project IDs but rejects changes to either field on a persisted package with `PACKAGE_IDENTITY_IMMUTABLE`.

- [ ] **Step 1: Write failing store tests** that create a package, then assert later alias and project ID patches are rejected while ordinary execution setting patches still save.

- [ ] **Step 2: Run the focused test** with `node --test taskboard/test/feishu-package-config.test.mjs` and confirm identity mutation remains accepted before the implementation.

- [ ] **Step 3: Add store-level identity checks** before registry persistence; retain all current reference and revision guards.

- [ ] **Step 4: Document the immutable routing-key rule** in the package-management README section.

- [ ] **Step 5: Run the focused test** and confirm it passes.

### Task 3: Package Manager Validation Flow

**Files:**
- Modify: `taskboard/web/src/api.ts`
- Modify: `taskboard/web/src/types.ts`
- Modify: `taskboard/web/src/components/FeishuPackageManager.tsx`
- Modify: `taskboard/web/src/components/FeishuPackageManager.test.tsx`
- Modify: `taskboard/web/src/styles.css`

**Interfaces:**
- `inspectFeishuPackageWorkspace(workspacePath)` calls the local inspection endpoint.
- The new-package form has a `验证并读取` action that pre-fills its unsaved hidden routing IDs and stored name.

- [ ] **Step 1: Write failing component tests** that require a workspace validation action, show `Auto-cut-lite1.6.9` and core version, prefill an unsaved form, and hide technical IDs for persisted packages.

- [ ] **Step 2: Run the focused component test** with `npm --prefix taskboard exec vitest -- run web/src/components/FeishuPackageManager.test.tsx --environment jsdom` and confirm it fails.

- [ ] **Step 3: Add the API client, types, editor state, and compact read-only identity display.** Keep models, reasoning, ZIP source directory, concurrency, resource groups, and prompt as user-reviewed execution fields.

- [ ] **Step 4: Run the focused component test** and confirm it passes.

### Task 4: Integration Verification

**Files:**
- Verify only: package API, package store, package manager, full typecheck, production web build, local stack health.

- [ ] **Step 1: Run** `node --test taskboard/test/feishu-package-api.test.mjs taskboard/test/feishu-package-config.test.mjs`.
- [ ] **Step 2: Run** `npm --prefix taskboard exec vitest -- run web/src/components/FeishuPackageManager.test.tsx --environment jsdom`.
- [ ] **Step 3: Run** `npm --prefix taskboard run typecheck` and `npm --prefix taskboard run build:web`.
- [ ] **Step 4: Run** `git diff --check` and `.\\scripts\\check-local.ps1`.
