# VM Review Workflow Implementation Plan

**Goal:** Enable a trustworthy review-edit cycle that uses the latest confirmed MP4 as its parent, delivers a new MP4 without another VM download approval, and only completes after PMO attachment read-back and stage writeback.

**Architecture:** Add a versioned VM package protocol for review rounds while preserving the frozen initial-only v1 behavior. Taskboard freezes the current delivered artifact, source hash, instruction snapshot, round number, and output name before invoking the local package; the package receives no Feishu credentials and cannot choose paths. Review output uses the existing durable MP4 delivery queue, appends to the configured attachment field after re-reading it, verifies read-back, then retries stage writeback independently.

**Tech Stack:** Node.js 22.13+, SQLite, Python 3.10-3.12, FFmpeg/ffprobe, Feishu SDK, `node:test`, `pytest`, `ruff`.

**Spec:** `docs/superpowers/specs/2026-10-09-vm-pmo-review-video-interface-draft.md`; protocol compatibility is defined by `E:/codex/Auto-cut-slicing-src/docs/vm-pmo-offline-contract-v1.md` and its versioned successor.

## Global Constraints

- Taskboard and Bridge bind only to `127.0.0.1`; VM credentials and `CODEX_FEISHU_BRIDGE_SECRET` never enter package input, logs, task text, or Git.
- Only a task registered through the authenticated Bridge VM endpoint, with an enabled automatic snapshot and allowlisted package, may execute; simulated and ordinary tasks remain ineligible.
- Review tasks use the previous confirmed MP4 and do not request a new VM download approval.
- Every review round freezes a managed parent artifact identity and SHA-256; retries reuse the same round, parent, instruction snapshot, and filename.
- The Auto-Cut package interprets frozen review text, resolves semantic operations, and blocks unsupported or ambiguous edits using source-hash-bound evidence. Taskboard does not parse opinions or derive timeline edits.
- Semantic VM edits obtain word timing through the clipper's existing local ASR configuration; ASR credentials never enter Taskboard input, child arguments, or logs.
- Existing `document_draft_zip` v1 protocol, runner, completion condition, and archive behavior remain unchanged.

---

### Task 1: Freeze Versioned Review Protocol

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-vm-pmo-review-video-interface-draft.md`
- Create: `docs/vm-pmo-review-offline-contract-v2.md`
- Modify: `E:/codex/Auto-cut-slicing-src/PACKAGE-MANIFEST.json`
- Modify: `E:/codex/Auto-cut-slicing-src/auto_cut_slicing/vm_pmo.py`
- Test: `E:/codex/Auto-cut-slicing-src/tests/test_vm_pmo.py`

**Interfaces:**
- v1 continues to accept only `initial`, `vm_original`, `parent: null`, and its existing exact-range profile.
- v2 accepts `initial` or `review`; `review` requires `timeline_basis: "previous_review_video"` and a parent containing managed delivery ID, run ID, artifact ID, SHA-256, bytes, and duration.
- For semantic instructions, the package creates and persists a source-hash-bound ASR alignment in the fixed run directory before compilation; retries validate and reuse that file rather than requesting another transcript.
- Each instruction result is either resolved with evidence-bound segments and operations or blocked with no renderable output.

- [x] Add v2 fixtures for valid parent-bound range edits, an exact word deletion, repeated-phrase ambiguity, source-hash mismatch, and protected-word conflicts; mock only the external ASR provider and use explicit synthetic word timestamps.
- [x] Run focused package tests; retain the initial-only v1 behavior while exercising the v2 cases.
- [x] Implement v2 validation and planning; semantic instructions use the local transcription adapter and persist source-bound evidence before compilation.
- [x] Add render tests proving the parent file hash, plan hash, round identity, output path, and semantic evidence remain bound through retry.
- [x] Run the full package pytest suite (325 passed) and Ruff. The optional smoke script was attempted but is blocked by the local `auto-cut-lite` checkout revision not matching `auto-cut-dependency.lock.json`.
- [x] Update the package VM protocol documentation with the v1/v2 compatibility boundary and blocked cases.

### Task 2: Freeze Review Round and Parent in Taskboard

**Files:**
- Modify: `taskboard/server/vm-task-registration.mjs`
- Modify: `taskboard/server/vm-task-download-bindings.mjs`
- Modify: `taskboard/server/vm-pmo-orchestrator.mjs`
- Modify: `taskboard/server/vm-pmo-run-input.mjs`
- Modify: `taskboard/server/vm-pmo-result-validator.mjs`
- Modify: `taskboard/server/vm-pmo-runtime.mjs`
- Test: `taskboard/test/vm-task-registration.test.mjs`
- Test: `taskboard/test/vm-task-download-bindings.test.mjs`
- Test: `taskboard/test/vm-pmo-run-input.test.mjs`
- Test: `taskboard/test/vm-pmo-result-validator.test.mjs`
- Test: `taskboard/test/vm-pmo-orchestrator.test.mjs`
- Test: `taskboard/test/vm-pmo-runtime.test.mjs`

**Interfaces:**
- A registered `review` task snapshots its review round, exact parent delivery, current instruction field values, common name, and output filename before preparation.
- Initial tasks keep the existing approval/download binding. Review tasks resolve the parent artifact from Taskboard's confirmed delivery store and never call the approval adapter.
- `prepareVmPmoRunInput` writes v2 input and execution context with the parent file as the source and `timeline_basis: "previous_review_video"`.

- [x] Add tests for review-stage entry, rejection without a confirmed parent, and proving no approval lookup/enqueue occurs.
- [x] Add retry/restart tests that preserve the same parent SHA, review round, instruction snapshot, and `<name>_第N稿.mp4` path.
- [x] Implement the narrow registration and orchestration changes while keeping initial runs on the v1 protocol.
- [x] Validate the v2 package identity and review input/output using the versioned package manifest snapshot.
- [x] Run focused and full Taskboard tests; initial-only execution retains the existing ZIP behavior. Taskboard tests verify that review text is echoed from the frozen input without interpreting package operations; Auto-Cut tests cover protected-word conflicts.

### Task 3: Deliver Review MP4 and Complete Stage Safely

**Files:**
- Modify: `taskboard/server/vm-mp4-delivery.mjs`
- Modify: `taskboard/server/vm-mp4-feishu-adapter.mjs`
- Modify: `taskboard/server/vm-stage-writeback.mjs`
- Modify: `taskboard/server/vm-writeback-store.mjs`
- Test: `taskboard/test/vm-mp4-delivery.test.mjs`
- Test: `taskboard/test/vm-mp4-feishu-adapter.test.mjs`
- Test: `taskboard/test/vm-stage-writeback.test.mjs`
- Test: `taskboard/test/vm-writeback-store.test.mjs`

**Interfaces:**
- Delivery identity is `(run_id, artifact_sha256, record_id, attachment_field_id)` and is persisted before external upload.
- Binding re-reads the PMO attachment field, preserves existing files, appends this token only when absent, and verifies the token by reading the record back.
- Confirmed delivery updates the per-record latest-delivered pointer; the review task completes only after its configured stage writeback succeeds or is recorded for independent retry.

- [x] Add tests for preserving existing attachments, an already-present token, uncertain upload/bind results, conflicts, and writeback retry without rerender.
- [x] Implement append-and-read-back delivery with bounded retries and safe error codes; upload token creation alone is not delivery.
- [x] Persist the exact delivered artifact pointer and advance the next review parent only after read-back confirmation.
- [x] Test that old-round writeback cannot overwrite a record that has advanced to another stage or round.
- [x] Run the focused delivery and writeback tests as part of the full Taskboard suite.

### Task 4: Open Review Activation and Bridge Routing

**Files:**
- Modify: `taskboard/server/feishu-workflow-store.mjs`
- Modify: `taskboard/server/vm-workflow-activation.mjs`
- Modify: `src/bridge-host.mjs`
- Modify: `src/feishu-workflow-router.mjs`
- Test: `taskboard/test/vm-workflow-activation.test.mjs`
- Test: `taskboard/test/vm-bridge-sync-http.test.mjs`
- Test: `test/bridge-host.test.mjs`
- Test: `test/feishu-workflow-router.test.mjs`

**Interfaces:**
- Activation may enable configured `initial` and `review` stages only when the live VM v2 package manifest and all selected Base fields/options validate.
- Review events are produced only on an absent-to-present transition into the configured review option; ordinary, simulated, and non-Bridge tasks remain ineligible.
- Final archive uses an independently configured trigger and durable worker; it remains opt-in and consumes only the confirmed delivery pointer.

- [x] Add activation tests for review contract gates, v2 package acceptance, missing bindings, invalid status options, and unchanged ZIP behavior.
- [x] Add Bridge routing tests for review entry, sustained-state dedupe, leave/re-enter round increment, and simulated-source rejection.
- [x] Implement review-stage activation and routing without changing the ZIP workflow router.
- [x] Update `AGENTS.md`, `README.md`, and VM integration guides to distinguish VM MP4 completion from ZIP publication completion.
- [x] Run focused bridge and activation tests as part of the full Taskboard suite.

### Task 5: End-to-End Review Verification

**Files:**
- Modify: `scripts/check-vm-pmo-offline.mjs`
- Modify: `docs/vm-pmo-offline-integration.md`
- Test: `taskboard/test/vm-pmo-http.test.mjs`
- Test: package VM v2 offline tests

- [x] Extend offline verification with synthetic parent videos, repeated review rounds, semantic instruction evidence, and blocked ambiguous edits.
- [x] Independently validate output hashes, full decode, duration, 1920x1080/25 fps profile, and audio behavior.
- [x] Confirm offline execution uses only synthetic local `.runtime` artifacts and does not call Feishu, request approval, upload, write back, or touch archive destinations.
- [x] Run repository tests and the VM v2 offline command. The offline run passed all 18 checks. Taskboard `node --test` reported 2463 passed, 1 intermittent upload-recovery startup timing failure, and 8 skipped; that test passed alone. Typecheck, web build, and all 312 component tests passed. Auto-Cut pytest passed all 326 tests and Ruff passed.
- [x] Complete the independent code review. Keep semantic interpretation in Auto-Cut; Taskboard verifies frozen-input and package-result bindings, plan structure, and media integrity without parsing opinions.

---

## Final Archive Worker

Implemented as a separate authenticated Bridge route and durable worker. It consumes only the confirmed latest-delivered pointer, revalidates the source SHA, copies to a temporary file in the target directory, validates bytes, and publishes without overwriting. Same-name/same-SHA is idempotent; same-name/different-SHA is a visible conflict. Recovery never rerenders or searches attachments for a presumed latest file.

## Self-Review

- Coverage: registration, parent freezing, versioned package contract, package-owned semantic evidence, delivery, writeback, activation, Bridge routing, final archive, offline verification, and required documentation are implemented and tested.
- Compatibility: initial-only VM v1 and the existing ZIP v1 protocol stay independent; review requires the new VM package version.
- Verification: Taskboard `node --test` passed 2463 tests, with one upload-recovery startup timing test failing under the full parallel run and passing when isolated; 8 tests were skipped. Typecheck, web build, and 312 component tests passed. The web build reports a CSS pseudo-element warning and the existing large-chunk advisory. Auto-Cut `python -m pytest -q` passed (326 tests), `python -m ruff check .` passed, and the VM v2 offline integration passed all 18 checks. `python scripts/smoke_test.py` could not pass because the ignored local upstream checkout does not match the pinned dependency revision.
- Remaining gate: real test-record acceptance. No live approval, Feishu update, or local package registry configuration was changed in this implementation pass.
