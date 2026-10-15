# Package Workflow Profiles Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review each task.

**Goal:** All supported editing packages own restorable subject configuration drafts, activated separately from editing.

**Architecture:** Extend package drafts and reuse existing ZIP validation/versioned activation; keep VM preview-only, local boundary and immutable task snapshots.

**Spec:** `docs/superpowers/specs/2026-10-12-package-workflow-profiles-design.md`.

**Constraints:** Work in current checkout preserving uncommitted foundation; no commits, production actions, service restarts or token/config exposure.

- [x] Backend: draft profiles for ZIP, backward-compatible lazy/history migration and legacy writes, profile activation with two revision checks, active alias response. Own store/draft API/backend tests.
- [x] Frontend: typed profile API, full-identity caches, restoration, independent save/enable, active indicator, pending edits and conflict handling. Own frontend and component tests.
- [x] Integration: app route dispatch for enable path, docs, isolated HTTP validation; preserve shared export and deletion semantics.
- [x] Review: independent scoped review, fix findings, run full npm test, record visual QA capability and final result.
