# 飞书任务标题回退 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make future Feishu-triggered Taskboard cards use `视频名称`, then `集合文档`, then the record ID as their title source.

**Architecture:** Add optional per-table title field names/IDs to the validated Bridge configuration. On a matching event, the Bridge asks an injected official Feishu SDK record reader for the current record fields, selects the first non-empty configured title value, and passes it to the existing task-payload formatter; API failures are non-fatal and retain the record-ID fallback.

**Tech Stack:** Node.js ESM, `node:test`, `@larksuiteoapi/node-sdk`, local JSON configuration.

## Global Constraints

- Only loopback services and the already-authorized PMO app are used.
- No Feishu record writes are introduced.
- Existing tasks are not renamed.
- Missing title fields, empty values, and reader failures must never block task creation.
- Production code changes follow a failing-test-first cycle.

### Task 1: Extend table title configuration and selection helper

**Files:**
- Modify: `src/config.mjs`
- Modify: `config/bridge.local.json`
- Modify: `src/feishu-event.mjs`
- Create: `src/feishu-record-reader.mjs`
- Test: `test/config.test.mjs`
- Test: `test/feishu-event.test.mjs`
- Test: `test/feishu-record-reader.test.mjs`

**Interfaces:**
- `validateConfig()` returns optional `titleField`, `titleFieldId`, `fallbackTitleField`, and `fallbackTitleFieldId` on each table.
- `selectRecordTitle({ table, fieldValuesById, fieldsByName })` returns a trimmed string or `""`.

- [ ] **Step 1: Write failing tests** for config preservation and the three selection cases (primary title, fallback title, empty result).
- [ ] **Step 2: Run `node --test test/config.test.mjs test/feishu-record-reader.test.mjs` and verify the new assertions fail because the fields/helper do not exist.**
- [ ] **Step 3: Implement optional config fields, export the existing display-value normalization, and implement `selectRecordTitle` with ID-first/name-second lookup and whitespace/JSON/object handling.**
- [ ] **Step 4: Add the two configured field names and IDs to `config/bridge.local.json`, then run the focused tests and verify they pass.**

### Task 2: Enrich matching Bridge events through the official SDK reader

**Files:**
- Modify: `src/bridge.mjs`
- Modify: `src/index.mjs`
- Modify: `src/feishu-record-reader.mjs`
- Test: `test/bridge.test.mjs`
- Test: `test/feishu-record-reader.test.mjs`

**Interfaces:**
- `createFeishuRecordTitleResolver({ client, logger })` returns `async (event, table) => string` and calls `client.bitable.v1.appTableRecord.get({ path: { app_token, table_id, record_id } })`.
- `createBridge({ ..., resolveRecordTitle })` enriches a decision event before calling `buildTaskPayload`.

- [ ] **Step 1: Add a failing Bridge test with an injected resolver and assert the created task title uses the resolved primary/fallback value.**
- [ ] **Step 2: Run `node --test test/bridge.test.mjs` and verify the new test fails because Bridge does not call a resolver.**
- [ ] **Step 3: Implement non-fatal title enrichment after `decideRecordChange` and before `buildTaskPayload`; log a warning and retain the original event on resolver failure.**
- [ ] **Step 4: In `src/index.mjs`, create the official SDK `Client` only when the listener is enabled and inject the resolver into the Bridge through a closure.**
- [ ] **Step 5: Run focused Bridge/reader tests and verify they pass.**

### Task 3: Regression and live verification

**Files:**
- Modify: `README.md`
- Test: all existing `test/*.test.mjs`

- [ ] **Step 1: Document the per-table title field settings and the fallback order.**
- [ ] **Step 2: Run `npm test` and confirm zero failures.**
- [ ] **Step 3: Restart the local Bridge using the existing startup script so the new configuration is loaded.**
- [ ] **Step 4: Trigger one safe test transition only after the user changes a test record, then verify the new Taskboard card title and that the record ID remains in its description.**
