# Auto-Cut ZIP Output Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let Taskboard read a declared relative ZIP output directory from an Auto-Cut-Lite package, safely create it only during an explicit save or enable action, and preserve manual configuration for older packages.

**Architecture:** The package manifest remains the source of a relative directory declaration. Taskboard resolves that declaration inside the verified workspace, rejects traversal and reparse escapes, and returns the local resolved path during package inspection. The package editor auto-fills the declared path after an explicit verification; it retains the manual absolute-path fallback when the package does not declare an output directory.

**Tech Stack:** Node.js filesystem APIs, Taskboard local HTTP API, React and TypeScript, Node test runner, Vitest.

## Global Constraints

- Accept only `interface.zipOutput.relativeDirectory` from the fixed `PACKAGE-MANIFEST.json` manifest. Plugin identity/version continue to come from `.codex-plugin/plugin.json`.
- The declaration is relative, nonempty, has no `.` or `..` segments, and has no Windows, POSIX, UNC, or drive-qualified absolute form.
- Resolve and create only below the verified workspace; resolve the directory after creation and reject any reparse-point escape.
- Workspace verification remains read-only. Creation runs only before an explicit package save or enable request.
- A missing declaration preserves the existing manual `zipSourceDirectory` behavior.
- The final ZIP file path remains Taskboard-owned and Auto-Cut-Lite must still report only that exact injected path.

---

### Task 1: Parse and Prepare the Declared Directory

**Files:**
- Modify: `taskboard/server/feishu-package-identity.mjs`
- Modify: `taskboard/server/feishu-package-api.mjs`
- Test: `taskboard/test/feishu-package-api.test.mjs`

**Interfaces:**
- Produces `inspection.zipOutput`, either `null` or `{ relativeDirectory, directory }`.
- Produces `POST /api/local/autocut/packages/prepare-output-directory`, which accepts `{ workspacePath }` and returns the server-resolved directory.

- [x] **Step 1: Write failing API tests** for a package declaring `"zipOutput": { "relativeDirectory": "output" }`, a traversal declaration, and explicit preparation that creates the missing directory below the workspace.
- [x] **Step 2: Run** `node --test taskboard/test/feishu-package-api.test.mjs` and verify the declaration tests fail because `zipOutput` is absent and the preparation route does not exist.
- [x] **Step 3: Implement the manifest parser and preparation helper.** Validate the declaration before resolving it; walk components with `lstat`, `mkdir`, `realpath`, and `path.relative` to ensure the prepared directory remains below the resolved workspace and reject directory links.
- [x] **Step 4: Add the read-only inspection result and preparation endpoint.** The preparation endpoint must re-read the fixed manifest rather than accepting a client-provided relative path.
- [x] **Step 5: Re-run** `node --test taskboard/test/feishu-package-api.test.mjs` and verify all tests pass.

### Task 2: Auto-Fill the Package Editor

**Files:**
- Modify: `taskboard/web/src/types.ts`
- Modify: `taskboard/web/src/api.ts`
- Modify: `taskboard/web/src/components/FeishuPackageManager.tsx`
- Test: `taskboard/web/src/components/FeishuPackageManager.test.tsx`

**Interfaces:**
- Consumes `inspection.zipOutput` from Task 1.
- Calls `prepareFeishuPackageOutputDirectory(workspacePath)` before saving a fresh manifest-derived directory.

- [x] **Step 1: Write failing component tests** that verify a declared directory is auto-filled after verification, is labelled as Lite-provided, and preparation is invoked before saving. Add a legacy test that retains a manually entered directory where `zipOutput` is `null`.
- [x] **Step 2: Run** `npm exec vitest -- run web/src/components/FeishuPackageManager.test.tsx --environment jsdom` and verify the new assertions fail because the declaration is not represented in the client.
- [x] **Step 3: Implement the API type and client request.** Only the workspace path is sent to the preparation endpoint.
- [x] **Step 4: Implement editor behavior.** Rename the field to `ZIP 生成目录`; after a current inspection with a declaration, set the form directory to the server result and make it read-only. Before save or enable, prepare the directory and reject a stale or changed manifest result.
- [x] **Step 5: Re-run** the focused component test and `npm run typecheck` from `taskboard`.

### Task 3: Document the Contract

**Files:**
- Modify: `README.md`
- Modify: `taskboard/docs/auto-cut-lite-interface-requirements.md`

- [x] **Step 1: Document** the package-manifest field, the manual fallback, the save/enable-only creation point, and the invariant that Taskboard owns the exact final ZIP path.
- [x] **Step 2: Run** `git diff --check` and verify no whitespace errors are reported.

### Task 4: Verify the Integrated Change

**Files:**
- Test: `taskboard/test/feishu-package-api.test.mjs`
- Test: `taskboard/web/src/components/FeishuPackageManager.test.tsx`
- Test: `taskboard/web/src/api.package-read.test.tsx`

- [x] **Step 1: Run** `node --test taskboard/test/feishu-package-api.test.mjs taskboard/test/feishu-package-config.test.mjs`.
- [x] **Step 2: Run** `npm exec vitest -- run web/src/components/FeishuPackageManager.test.tsx web/src/api.package-read.test.tsx --environment jsdom` from `taskboard`.
- [x] **Step 3: Run** `npm run typecheck` and `npm run build:web` from `taskboard`.
- [x] **Step 4: Request code review** for path containment, creation timing, backwards compatibility, and UI state handling.

## Review and Verification Notes

- Server tests: 37 passed, including package-manifest-only declarations, directory links, read-only inspection, and no package-update broadcast.
- Final frontend suite: 138 passed. Covers re-verification failure provenance, declaration withdrawal, saved-path preservation, and disabling only the saved settings while retaining unsaved edits.
- Client API tests use `.test.tsx` alongside other frontend tests and are included in `test:components`; Node's automatic `.test.ts` discovery must not run Vitest files.
- The installed Lite package was initially 1.6.14 without a declaration. At final live verification it had independently updated to 1.6.15, declaring `output`; the live API successfully read the new declaration. This Taskboard implementation did not modify deployed Lite files or the live registry (revision 18 and file SHA-256 unchanged).
- Root `npm test`: after correcting the Vitest file discovery issue, the full Node run recorded 1,801 passed, 3 skipped, and 3 failures involving temporary ports/Bridge availability. Rerunning the three affected files sequentially passed all 115 tests; this was not a clean single full-suite run.
- Final typecheck, production web build, and `check-local.ps1 -RequireFeishu` passed. Services restarted with the previously enabled listener preserved; no active executions or uploads were present before restart.
