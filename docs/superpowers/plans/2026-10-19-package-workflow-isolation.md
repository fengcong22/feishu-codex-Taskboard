# Package Workflow Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Give each editing package its own board and complete the automatic MP4 review/NAS loop without local acceptance.

**Architecture:** Reuse trusted VM task/run, delivery and archive services. Add a read-only package board projection and package-scoped presentation settings; preserve the legacy ZIP board. Repair shared-field dispatch and enforce package-scoped MP4 lineage at the existing service boundaries.

**Tech Stack:** Node ESM, node:sqlite, React/TypeScript, node:test and Vitest.

**Spec:** docs/superpowers/specs/2026-10-19-package-workflow-isolation-design.md

## Global constraints

- Preserve current uncommitted work on codex/vm-pmo-video-editing. Do not commit, merge, push, change live configuration, or perform live delivery during this work.
- Keep authenticated Bridge registration, loopback bindings, explicit automatic permission and frozen snapshots.
- ZIP completion remains unique ZIP publication; VM round completion remains unique verified MP4 delivery/readback.
- Actual render start causes processing writeback. Awaiting Feishu review is automatic, not a local approval step.

## Task 1: Shared-field event dispatch

- [x] In test/vm-workflow-decision.test.mjs add real single-field initial/review/archive transition cases. Verify node --test test/vm-workflow-decision.test.mjs fails because archive currently captures stage events.
- [x] Update src/vm-workflow-decision.mjs to route only an entering archive option to archive, while initial/review edges continue to stage registration and leave edges retain todo-only archival.
- [x] Run decision and bridge tests; preserve simulation and event_id checks.

## Task 2: Package-bound lineage and automatic completion evidence

- [x] Add regressions in taskboard/test/vm-pmo-runtime.test.mjs and delivery/archive tests for two packages sharing one record/field, two review rounds, stale archive source, and distinct review trigger fields.
- [x] Update vm-mp4-delivery.mjs, vm-task-registration.mjs, vm-pmo-runtime.mjs and vm-pmo-final-archive.mjs to bind parent/archive evidence to the package and template, preserving old rows through trusted snapshots. No new source download on review.
- [x] Expose a side-effect-free package board status read in a focused server module and local app route. Return taskId, run state, approval state, writeback state and archive state without credentials, paths or instructions. Package selection must not activate a package.
- [x] Run focused VM service/API tests. Keep existing manual plan/writeback retries functional.

## Task 3: Package-scoped boards and preferences

- [x] Add projection tests for mixed packages and complete VM lifecycle in taskboard/test/package-workflow-board.test.mjs.
- [x] Implement taskboard/web/src/packageWorkflowBoard.mjs and a dedicated VM board component using existing task cards, per-package view/stage settings and trusted status endpoint. Preserve queued/render timing and show waiting for Feishu review instead of local acceptance.
- [x] Add package selection to App.tsx, separate tasks and ZIP uploads by saved origin, scope asynchronous requests to subject/package, retain historical packages and original snapshots.
- [x] Verify component interaction, typecheck and frontend build.

## Task 4: Integration, documentation and review

- [x] Exercise offline initial → review → review → approved archive fixtures, same-field dispatch, restart recovery and mixed-package isolation.
- [x] Update README.md and AGENTS.md with package board scopes and workflow business completion. Review the final diff for provenance/credential regression and legacy ZIP changes.
- [x] Run node --test, npm --prefix taskboard run typecheck, build:web and test:components, plus git diff --check. Report existing failures separately from new regressions.
- [x] Build/restart local panel only after verifying that no active run would be interrupted; run check-local.ps1. Do not mutate production records for verification.

## Verification record (2026-10-19)

- Focused event dispatch, registration, runtime, MP4 delivery, archive, HTTP, settings and board projection: 137/137 passed.
- Full component suite: 325/325 passed; TypeScript and production web build passed.
- Full root node suite: 2,540 passed, 8 skipped, 3 failed under parallel load (upload recovery startup timeout, local Wrangler bad-port error, legacy local-report Bridge timeout). All three affected files then passed in isolation with concurrency 1: 94/94. The aggregate invocation itself was not green.
- Real offline executor fixture covered initial delivery, two review rounds, one original approval/download, parent freezing, stale archive rejection, restart and final NAS publication in a temporary directory. No test used live Feishu/NAS delivery.
- Independent review findings were fixed and re-reviewed: distinct review-field metadata, held-slot queue projection, canceled/backlog card scoping and removed-package history lookup. Final scoped review found no blocker.
- Checked persisted run/upload states before restart; no active render or upload. Restarted with the existing enabled Feishu listener mode. check-local.ps1 -RequireFeishu passed; both live package board GETs returned the correct template and nine columns. Existing Bridge dead-letter count remains 18.
- No commit, merge, push or workflow activation performed. Existing uncommitted work is preserved.
- Production rollout remains explicit: the current auto-cut-slicing subject snapshot is version 8 with initial enabled and review/finalArchive disabled. Bind and enable the review trigger/instructions and approved-archive option/NAS destination through the package configuration before attempting the live end-to-end review loop.

## Post-implementation configuration and acceptance

- The user subsequently authorized local configuration and activation of snapshot version 9: review enters on `2-视频修改`, delivery writes `1-视频审核`, and approved archive enters on `3-出片`. Review reads the configured text and optional screenshot fields; the initial archive destination is the user's Windows Desktop, configured locally rather than committed.
- Persisted evidence for test task FEI-28 confirms MP4 delivery and a published final-archive job. Rechecked that the destination file exists, matches the confirmed delivery SHA-256 and byte count, and the user confirmed playback. This is live initial-delivery/archive evidence; two review rounds remain covered by the offline integration fixture rather than a claim of live review-loop acceptance.
- Review screenshots remain unsupported by the current execution protocol. Empty screenshots permit text-only review; nonempty screenshots block with `VM_REVIEW_IMAGES_UNSUPPORTED` rather than being silently ignored.
- Simplified the initial/review stage toggles into their headings and replaced stale notices that said review/archive were unavailable.
- After acceptance, the user authorized committing the verified changes to the existing development branch. The earlier implementation-only restriction against committing no longer applies; local credentials, active configuration, state databases and media remain excluded.

## Pre-commit review and final verification

- The serialized full `npm run test:ci` completed with exit 0: 2,558 backend tests passed, 8 skipped, 325 component tests passed, and typecheck/production web build passed. This supersedes the earlier parallel aggregate failure above.
- Independent review prompted narrow fixes for pre-upgrade initial run identities, legacy runtime identity metadata, explicit v2/fixed-driver execution gating for initial as well as review, and planning retries that reuse the frozen confirmed review parent without consulting the approval queue.
- A final regression reproduced stale task-version acceptance both before a retry and during asynchronous source validation. Retry now checks the expected task version at entry and again within the same immediate transaction that advances the planning attempt; a conflict leaves the run and immutable input history unchanged.
- After the last code changes, the six-file orchestrator/runtime/HTTP/registration/delivery/archive suite passed 112/112 with exit 0. Typecheck, production web build and all 325 component tests were rerun successfully.
- Candidate-file checks found no local configuration, runtime databases, media, private keys or OAuth callback URLs in the 98 reviewed paths. Commit remains local to `codex/vm-pmo-video-editing`; no main merge or push is part of this acceptance.
- Final independent read-only review confirmed the version-race remediation and reported no remaining commit blockers.
