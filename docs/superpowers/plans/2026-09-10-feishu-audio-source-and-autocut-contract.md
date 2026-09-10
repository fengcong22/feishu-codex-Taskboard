# Feishu Audio Source and Auto-Cut Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every fixed Feishu workflow stage an independent three-choice audio-source editor, validate Base attachment sources fail-closed through save and live enablement, preserve the existing manifest schema, and publish one complete Auto-Cut Lite handoff document.

**Architecture:** Keep the persisted audio wire model unchanged: the UI's three choices map to `video_original` or `replace_original` with either `docx_section` or `base_attachment`. Keep unsaved per-source values in a React ref keyed by `subjectKey` and `stageId`, outside the persisted subject form. Reuse normalized Feishu metadata at both Taskboard save time and Bridge live enablement to require every configured attachment field to exist and be type 17/Attachment.

**Tech Stack:** Node.js test runner, React 19, TypeScript, Vitest/Testing Library, Vite, PowerShell local scripts.

## Global Constraints

- Do not change the `source-manifest.json` schema version or add a third wire-level audio mode.
- Do not modify, build, install, or deploy `D:\codex\Auto-cut-lite`.
- Do not change loopback binding, event filtering, automatic-execution eligibility, package allowlisting, or credential handling.
- Never persist UI draft caches or include them in shared configuration or run manifests.
- Apply test-driven development: no production file may change before its focused test has failed for the intended reason.
- Commit each independently green task; never include credentials, `.runtime`, local registries, or unrelated worktree changes.
- Run the repository-root `npm test`, then perform desktop and narrow-viewport browser checks.

---

### Task 1: Fail-Closed Server and Live Metadata Validation

**Files:**
- Modify: `taskboard/test/feishu-phased-config.test.mjs`
- Modify: `taskboard/server/feishu-workflow-stages.mjs`
- Modify: `taskboard/test/feishu-workflow-store.test.mjs`
- Modify: `taskboard/server/feishu-workflow-store.mjs`
- Modify: `test/feishu-base-metadata.test.mjs`
- Modify: `src/feishu-base-metadata.mjs`

**Interfaces:**
- Consumes staged audio values in the existing camelCase/snake_case-compatible model.
- Produces normalized `{ mode: "video_original" }` or `{ mode: "replace_original", source, durationToleranceSeconds }` values plus a separate attachment-binding issue/assertion interface. Structural normalization remains permissive enough to retain a stale saved binding after metadata refresh; save, enable, share diagnostics, and Bridge live validation opt into strict field checks.

- [ ] **Step 1: Add focused normalization tests.**

  Extend the phased fixture metadata with attachment and non-attachment fields. Assert all of the following separately:

  ```js
  audio: {
    mode: "replace_original",
    source: { kind: "docx_section", anchorText: " 配音 " },
    durationToleranceSeconds: 1.5,
  }
  // normalizes to anchorText "配音"

  audio: {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  }
  // defaults durationToleranceSeconds to 3
  ```

  Add rejection assertions for an empty Docx anchor, a missing attachment field ID, an unknown mode/kind, and a zero/negative/non-finite tolerance. Confirm `video_original` strips any supplied source and tolerance. Separately test the new attachment-binding assertion against a field ID absent from known metadata and a resolved non-attachment field.

- [ ] **Step 2: Run the normalization test and verify RED.**

  Run:

  ```powershell
  node --test taskboard/test/feishu-phased-config.test.mjs
  ```

  Expected: the strict attachment-binding assertions fail because no separate strict binding validator exists yet.

- [ ] **Step 3: Add a strict attachment-binding validator without tightening structural normalization.**

  Keep `normalizeSource` responsible only for source shape and identifier syntax. Add an exported helper that walks every stage's `videoSource` and replacement `audio.source`, reports the exact stage/source path, rejects an unresolved `base_attachment` with `FIELD_NOT_FOUND`, and rejects a resolved non-attachment with `FIELD_TYPE_INVALID`. Treat an explicit `fields: []` as known empty metadata; allow callers to choose whether unavailable metadata is itself an error.

- [ ] **Step 4: Run the focused normalization test and verify GREEN.**

  Run the command from Step 2. Expected: all phased-config tests pass.

- [ ] **Step 5: Add store tests for stale refresh and strict save/enable.**

  Configure and save a valid Base attachment audio field, then refresh metadata with that field removed. Assert the refresh succeeds, increments the version, demotes an enabled subject to `draft`, and preserves the stale field ID for the UI to display. Assert saving that unchanged draft and enabling it both reject with `FIELD_NOT_FOUND`; repeat with the old attachment field changed to text and expect `FIELD_TYPE_INVALID`.

- [ ] **Step 6: Run the workflow-store test and verify RED.**

  ```powershell
  node --test taskboard/test/feishu-workflow-store.test.mjs
  ```

  Expected: save and enable currently accept an unknown attachment field, while a type-changed attachment may prevent refresh instead of preserving a repairable draft.

- [ ] **Step 7: Opt save and enable into strict attachment validation.**

  After the store has structurally normalized a draft, call the new strict validator before persisting an explicit save. Call it again before enablement. Convert validation failures into the store's existing `ApiError` shape without exposing field values. Do not call it from `upsertBasePreview`, ordinary row loading, or shared-draft import, so stale bindings remain visible and repairable.

- [ ] **Step 8: Run the workflow-store and phased normalization tests GREEN.**

  ```powershell
  node --test taskboard/test/feishu-phased-config.test.mjs taskboard/test/feishu-workflow-store.test.mjs
  ```

- [ ] **Step 9: Add live Bridge metadata tests.**

  Extend the phased subject fixture in `test/feishu-base-metadata.test.mjs` with stage video/audio attachment variants. Assert `assertPhasedSubjectMetadata` accepts configured attachment fields and rejects:

  ```text
  stages.initial.videoSource.fieldId absent from live fields
  stages.initial.videoSource.fieldId resolving to a non-attachment field
  stages.initial.audio.source.fieldId absent from live fields
  stages.initial.audio.source.fieldId resolving to a non-attachment field
  ```

  Also assert Docx sources do not require an attachment field lookup and `video_original` ignores stale source data.

- [ ] **Step 10: Run the live metadata test and verify RED.**

  Run:

  ```powershell
  node --test test/feishu-base-metadata.test.mjs
  ```

  Expected: staged source cases fail because `assertPhasedSubjectMetadata` currently validates only subject-level fields and trigger options.

- [ ] **Step 11: Validate every staged Base attachment against the live table.**

  Add a small helper beside `phasedField` that accepts a source and path, skips `docx_section`, resolves `base_attachment.fieldId` in the selected live table, and requires `isAttachmentField(field)`. Call it for every stage's `videoSource`; call it for `audio.source` only when `audio.mode === "replace_original"`. Reuse the existing configuration-changed error path and avoid exposing source values.

- [ ] **Step 12: Run all Task 1 focused suites.**

  ```powershell
  node --test taskboard/test/feishu-phased-config.test.mjs taskboard/test/feishu-workflow-store.test.mjs test/feishu-base-metadata.test.mjs
  ```

  Expected: all three suites pass with no warnings.

- [ ] **Step 13: Commit the validated metadata boundary.**

  ```powershell
  git add taskboard/test/feishu-phased-config.test.mjs taskboard/server/feishu-workflow-stages.mjs taskboard/test/feishu-workflow-store.test.mjs taskboard/server/feishu-workflow-store.mjs test/feishu-base-metadata.test.mjs src/feishu-base-metadata.mjs
  git commit -m "fix: validate phased attachment sources"
  ```

---

### Task 2: Manifest and Shared-Configuration Compatibility

**Files:**
- Modify: `taskboard/test/feishu-run-inputs.test.mjs`
- Modify: `taskboard/test/feishu-source-manifest.test.mjs`
- Modify: `taskboard/test/feishu-share-config.test.mjs`
- Modify: `test/workflow-config.test.mjs`
- Modify only if a RED test demonstrates a defect: `taskboard/server/feishu-run-inputs.mjs`
- Modify only if a RED test demonstrates a defect: `taskboard/server/feishu-source-manifest.mjs`
- Modify only if a RED test demonstrates a defect: `taskboard/server/feishu-workflow-store.mjs`

**Interfaces:**
- Consumes the normalized persisted stage audio model.
- Produces schema-v1 snake_case manifests and portable shared subjects containing only the active source configuration.

- [ ] **Step 1: Add exact run-input and manifest assertions.**

  Parameterize stage fixtures so one run uses Docx audio and one uses Base attachment audio. Assert exact emitted values:

  ```js
  {
    mode: "replace_original",
    duration_tolerance_seconds: 1.5,
    source: { kind: "docx_section", anchor_text: "配音" },
  }

  {
    mode: "replace_original",
    duration_tolerance_seconds: 3,
    source: {
      kind: "base_attachment",
      base_token: "bas_test",
      table_id: "tbl_test",
      record_id: "rec_test",
      field_id: "fld_audio",
    },
  }
  ```

  Assert `video_original` emits only `{ mode: "video_original" }` and that unknown fields/paths never survive canonicalization.

  For each fixed stage, include a numbered Docx audio anchor such as `二、PPT草稿+翻录` and assert Taskboard preserves that exact original string as `anchor_text`; numbering compatibility belongs to Auto-Cut Lite and Taskboard must not pre-normalize it.

- [ ] **Step 2: Run the focused manifest suites.**

  ```powershell
  node --test taskboard/test/feishu-run-inputs.test.mjs taskboard/test/feishu-source-manifest.test.mjs
  ```

  Expected: new assertions either pass as compatibility locks or fail at the precise unsupported mapping. If RED, make the smallest converter/validator change and rerun to GREEN.

- [ ] **Step 3: Add independent-stage share tests.**

  Give `initial`, `first_review`, and `final_review` respectively video original, Docx audio, and Base attachment audio with distinct tolerances. Export and import the share payload, then assert each stage preserves only its own active persisted configuration, local artifact paths remain removed, and no key matching `/draft|cache|temporary/i` appears anywhere in serialized JSON.

  Add dry-run diagnostic cases using current local metadata: an absent staged video/audio attachment emits `FIELD_NOT_FOUND`, a staged attachment that resolves to a non-attachment emits `FIELD_TYPE_INVALID`, and each diagnostic path identifies the stage and source. Import remains allowed only as a draft; diagnostics do not silently rewrite the binding.

  Add a Bridge configuration round-trip case in `test/workflow-config.test.mjs` that retains all three stage IDs and both existing source kinds without a schema change.

- [ ] **Step 4: Run the share test.**

  ```powershell
  node --test taskboard/test/feishu-share-config.test.mjs test/workflow-config.test.mjs
  ```

  Expected: pass, or RED identifying a real store portability defect. Make only the demonstrated store change and rerun to GREEN.

- [ ] **Step 5: Commit the compatibility locks.**

  Stage only files that changed in the RED/GREEN cycle. If no production defect was demonstrated, do not touch the conditional server files.

  ```powershell
  git add taskboard/test/feishu-run-inputs.test.mjs taskboard/test/feishu-source-manifest.test.mjs taskboard/test/feishu-share-config.test.mjs test/workflow-config.test.mjs
  git commit -m "test: lock phased audio source contracts"
  ```

---

### Task 3: Three-Choice Audio Editor with Scoped Draft Retention

**Files:**
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`
- Modify: `taskboard/web/src/components/FeishuStageEditor.tsx`
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.tsx`
- Modify: `taskboard/web/src/styles.css`

**Interfaces:**
- Produces UI-only `StageAudioSelection` and `FeishuStageAudioDraft` types plus `audioDraftFromStage(audio)`.
- `FeishuStageEditor` consumes `audioDraft` and emits `(audio, draft)` through `onAudioChange`.
- `FeishuWorkflowPanel` owns `Map<subjectKey, Partial<Record<stageId, draft>>>`; this map never enters `SubjectForm`.

- [ ] **Step 1: Replace the old component test with failing three-choice behavior tests.**

  Cover fixed option order (`视频原音`, `文档目录`, `Base 字段附件`), removal of the old segmented-button copy, one common detail control, visible-but-disabled detail/tolerance for video original, Docx text input, filtered Base attachment select, and the disabled `Base 字段附件（无可用字段）` option.

  Use stage-qualified accessible names such as `初稿音频来源`, `初稿音频来源详情`, `初稿音频目录标题`, `初稿音频附件字段`, and `初稿时长误差（秒）` so three expanded stages do not collide.

- [ ] **Step 2: Run the component suite and verify RED.**

  ```powershell
  npm --prefix taskboard run test:components -- --run
  ```

  Expected: tests fail because the editor still renders `声音方式` and two buttons and only supports Base attachment replacement in the UI.

- [ ] **Step 3: Implement the editor mapping and common controls.**

  Add:

  ```ts
  export type StageAudioSelection =
    | "video_original"
    | "docx_section"
    | "base_attachment";

  export interface FeishuStageAudioDraft {
    docxAnchorText: string;
    baseAttachmentFieldId: string;
    durationToleranceSeconds: number;
  }
  ```

  Derive the selection from the existing persisted audio. Map each UI choice back to the unchanged wire model. Switching sources first saves the active detail in the supplied draft, then restores the chosen source's detail. Do not auto-select the first attachment field. Show an unavailable configured field as a disabled selected placeholder so stale configuration is visible.

  Add these exact conversion functions beside the UI-only types:

  ```ts
  export function audioSelectionFromStage(
    audio: FeishuStageValue["audio"],
  ): StageAudioSelection {
    if (audio.mode === "video_original") return "video_original";
    return audio.source?.kind === "docx_section" ? "docx_section" : "base_attachment";
  }

  export function audioDraftFromStage(
    audio: FeishuStageValue["audio"],
  ): FeishuStageAudioDraft {
    return {
      docxAnchorText: audio.source?.kind === "docx_section" ? audio.source.anchorText ?? "" : "",
      baseAttachmentFieldId: audio.source?.kind === "base_attachment" ? audio.source.fieldId ?? "" : "",
      durationToleranceSeconds: audio.durationToleranceSeconds ?? 3,
    };
  }
  ```

  The source selector uses exactly these values and copy:

  ```tsx
  <option value="video_original">视频原音</option>
  <option value="docx_section">文档目录</option>
  <option value="base_attachment" disabled={attachmentFields.length === 0}>
    {attachmentFields.length === 0 ? "Base 字段附件（无可用字段）" : "Base 字段附件"}
  </option>
  ```

- [ ] **Step 4: Run the component suite and verify the editor tests GREEN.**

  Run the command from Step 2.

- [ ] **Step 5: Add failing panel-level isolation and serialization tests.**

  Render subjects with all three stages. Verify:

  ```text
  switching Docx -> Base -> Docx restores the unsaved Docx title
  switching Base -> video -> Base restores the unsaved field
  tolerance is shared between external sources and retained through video original
  an initial-stage value never appears in final_review
  a subject-A value never appears after loading subject B
  reloading a saved config initializes a fresh draft from persisted values
  save emits only the selected source and no draft/cache property
  a stale attachment ID blocks save and enablement with a stage-specific error
  ```

- [ ] **Step 6: Run the panel tests and verify RED.**

  Run the command from Step 2. Expected: retention/isolation tests fail because no subject/stage-scoped draft cache exists and stale attachment IDs are not validated in the panel.

- [ ] **Step 7: Add the scoped draft cache and strict client validation.**

  Keep drafts in:

  ```ts
  const audioDraftsBySubjectRef = useRef(
    new Map<string, Partial<Record<FeishuStageId, FeishuStageAudioDraft>>>(),
  );
  ```

  Initialize a subject's stage drafts from persisted audio whenever a real subject/config reload occurs, but preserve them through the existing dirty-form disable flow. Update the current persisted `stage.audio` and its UI draft together. Validate source requirements by `kind`, require a Base ID to belong to the current attachment-field set, and require a finite positive tolerance only for replacement audio.

  Keep UI-only state out of `SubjectForm` by updating through this boundary:

  ```ts
  function updateStageAudio(
    stageId: FeishuStageId,
    audio: FeishuStageValue["audio"],
    draft: FeishuStageAudioDraft,
  ) {
    if (!selected || !subjectForm?.stages) return;
    const subjectDrafts = audioDraftsBySubjectRef.current.get(selected.subjectKey) ?? {};
    audioDraftsBySubjectRef.current.set(selected.subjectKey, {
      ...subjectDrafts,
      [stageId]: draft,
    });
    updateStage(stageId, { ...subjectForm.stages[stageId], audio });
  }
  ```

- [ ] **Step 8: Update styles without changing the responsive structure.**

  Remove obsolete segmented-button selectors, keep the two-column `1fr 120px` common audio row, add a clear muted disabled appearance, and retain the existing narrow-screen single-column rule. Keep the established 30px control height and 5px radius.

- [ ] **Step 9: Run type checking, component tests, and production build.**

  ```powershell
  npm --prefix taskboard run typecheck
  npm --prefix taskboard run test:components -- --run
  npm --prefix taskboard run build:web
  ```

  Expected: all commands exit 0 without warnings introduced by this change.

- [ ] **Step 10: Commit the three-stage editor.**

  ```powershell
  git add taskboard/web/src/components/FeishuWorkflowPanel.test.tsx taskboard/web/src/components/FeishuStageEditor.tsx taskboard/web/src/components/FeishuWorkflowPanel.tsx taskboard/web/src/styles.css
  git commit -m "feat: add phased audio source selector"
  ```

---

### Task 4: Operator README and Transferable Auto-Cut Lite Contract

**Files:**
- Modify: `taskboard/README.md`
- Modify: `taskboard/README.zh-CN.md`
- Create: `taskboard/docs/auto-cut-lite-interface-requirements.md`

**Interfaces:**
- Documents the current Taskboard commit baseline and the read-only Auto-Cut compatibility baseline.
- Separates `CURRENT`, `REQUIRED`, and `OUT OF SCOPE` behavior.

- [ ] **Step 1: Update the Taskboard operator explanation.**

  In both language variants, replace the old generic sound-mode description with the three UI choices, per-stage independence, Docx title/Base attachment behavior, the shared positive tolerance, attachment-only filtering, stale-field fail-closed behavior, and the fact that the saved/manifest wire model remains two modes. Keep both variants semantically equivalent.

- [ ] **Step 2: Write the single handoff document from authoritative code and tests.**

  Start with a Chinese instruction block that requires the receiving Auto-Cut Lite source task to return: branch, full commit SHA, PR/link when available, a versioned candidate package, SHA-256, a Chinese Markdown test report, and a one-page delivery note. State explicitly that it must not install onto the current production computer.

  Include complete copyable schemas/examples for deployment discovery, the fixed `review-document-run` invocation, every `CODEX_AUTOCUT_*` variable and inherited-variable clearing, source manifest v1 and canonical SHA-256, execution input v1, immutable binding/record/document/source fields, result v1, package receipt v2, `taskctl artifact report`, exact ZIP validation, stable errors, and blocked/retry semantics.

  Mark the controlled heading-number fallback as `REQUIRED`: exact match first; then remove at most one supported leading number from both strings; preserve original manifest text; reject different bodies and ambiguous normalized matches; apply the same boundary rule to all video/review/audio Docx sections. Mark Taskboard UI/server behavior already delivered in this branch as `CURRENT`; mark deployment and Feishu write-back as `OUT OF SCOPE`.

- [ ] **Step 3: Validate document completeness mechanically.**

  Run searches that prove the document contains all three status labels, all three stage IDs, both source kinds, all injected environment-variable names, both schema versions, `review-document-run`, `taskctl artifact report`, delivery bundle requirements, numbering examples, and the no-deployment boundary.

  ```powershell
  rg -n "CURRENT|REQUIRED|OUT OF SCOPE|initial|first_review|final_review|docx_section|base_attachment|CODEX_AUTOCUT_|schema_version|review-document-run|taskctl artifact report|SHA-256|候选包|不得.*部署" taskboard/docs/auto-cut-lite-interface-requirements.md
  ```

  Expected: every required category has at least one deliberate occurrence; no secret, real token, or real absolute business path appears.

- [ ] **Step 4: Cross-check every documented contract against its producer or consumer.**

  Compare the final examples and field lists with:

  ```text
  taskboard/server/autocut-local-runner.mjs
  taskboard/server/feishu-source-manifest.mjs
  taskboard/server/feishu-run-inputs.mjs
  taskboard/server/app.mjs
  taskboard/server/artifact-service.mjs
  taskboard/cli/taskctl.mjs
  taskboard/shared/codex-environment.mjs
  ```

  Expected: command arguments, environment names, schema versions, result/receipt fields, hashes, report authentication, ZIP constraints, and stable errors agree with code. Remove any uncertain claim instead of guessing.

- [ ] **Step 5: Commit the operator documentation and handoff contract.**

  ```powershell
  git add taskboard/README.md taskboard/README.zh-CN.md taskboard/docs/auto-cut-lite-interface-requirements.md
  git commit -m "docs: publish Auto-Cut Lite interface contract"
  ```

---

### Task 5: End-to-End Verification and Review

**Files:**
- Review all files changed by Tasks 1-4.

- [ ] **Step 1: Run focused regression suites together.**

  ```powershell
  node --test taskboard/test/feishu-phased-config.test.mjs taskboard/test/feishu-workflow-store.test.mjs taskboard/test/feishu-run-inputs.test.mjs taskboard/test/feishu-source-manifest.test.mjs taskboard/test/feishu-share-config.test.mjs test/feishu-base-metadata.test.mjs test/workflow-config.test.mjs
  npm --prefix taskboard run test:components -- --run
  ```

- [ ] **Step 2: Run the required repository suite.**

  ```powershell
  npm test
  ```

  Expected: exit 0 with all tests passing.

- [ ] **Step 3: Start the local stack and check health.**

  ```powershell
  .\scripts\start-local.ps1
  .\scripts\check-local.ps1
  ```

  Do not use `-RequireFeishu` unless a real SDK connection is intentionally being verified. Do not simulate or mutate a production record.

- [ ] **Step 4: Verify the interface in desktop and narrow viewports.**

  Open the local Taskboard, inspect all three expanded stages, and exercise all audio-source transitions. At desktop and a narrow mobile viewport, confirm one detail control is present, disabled states are legible, long field names do not overlap, controls do not shift size, values remain isolated, and attachment empty/stale states are clear.

- [ ] **Step 5: Stop the local stack and inspect repository state.**

  ```powershell
  .\scripts\stop-local.ps1
  git status --short
  git diff --check
  ```

  Confirm no runtime state, credentials, local package registry, or files under `D:\codex\Auto-cut-lite` entered the diff.

- [ ] **Step 6: Request code review.**

  Review behavior against the approved design, with special attention to unknown attachment IDs, UI draft leakage, wire-schema drift, local path disclosure, and completeness of the Auto-Cut Lite handoff document. Resolve all blocking findings, rerun the affected focused tests, then rerun `npm test` before completion.

- [ ] **Step 7: Record the final review state.**

  ```powershell
  git log --oneline --decorate -8
  git status --short --branch
  ```

  Expected: feature commits are visible on `codex/dashboard-feature`, no accidental runtime or credential file is present, and any deliberate uncommitted change is explicitly reported.
