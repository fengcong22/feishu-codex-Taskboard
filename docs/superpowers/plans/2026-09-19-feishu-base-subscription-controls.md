# Feishu Base Subscription Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Taskboard controls to inspect, subscribe, and cancel each configured Feishu Base's record-change event subscription.

**Architecture:** Bridge is the only process using the Feishu SDK. Taskboard verifies the requested Base is in its local workflow catalog, then proxies an authenticated loopback request to Bridge. The navigator obtains and mutates status via Taskboard APIs and holds state per Base row.

**Tech Stack:** Node.js HTTP server, `@larksuiteoapi/node-sdk`, React 19, TypeScript, Node test runner, Vitest.

## Global Constraints

- Bridge and Taskboard remain bound to `127.0.0.1` only.
- Browser code must never receive Feishu credentials or call Feishu APIs directly.
- Subscription changes are per Base and never stop or delete existing Taskboard tasks.
- All returned errors are safe codes and generic messages.

---

### Task 1: Bridge Subscription Boundary

**Files:**
- Create: `src/feishu-base-subscription.mjs`
- Modify: `src/index.mjs`
- Modify: `src/server.mjs`
- Test: `test/feishu-base-subscription.test.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- Produces `createFeishuBaseSubscriptionClient({ client })` with `get(baseToken)`, `subscribe(baseToken)`, and `unsubscribe(baseToken)` returning `{ subscribed: boolean }`.
- Produces authenticated Bridge routes `GET /api/feishu/workflow/bases/:baseToken/subscription`, `POST /api/feishu/workflow/bases/:baseToken/subscription`, and `DELETE /api/feishu/workflow/bases/:baseToken/subscription`.

- [ ] Write tests that expect `getSubscribe`, `subscribe`, and `deleteSubscribe` to receive `{ path: { file_token }, params: { file_type: "bitable" } }`, and expect every successful mutation to read back `is_subscribe`.
- [ ] Run `node --test test/feishu-base-subscription.test.mjs test/server.test.mjs` and observe failures for the absent module and routes.
- [ ] Implement token validation, SDK result validation, generic safe failure codes, authenticated route dispatch, and index wiring.
- [ ] Re-run the targeted tests and confirm they pass.

### Task 2: Taskboard Proxy Contract

**Files:**
- Modify: `taskboard/server/app.mjs`
- Modify: `taskboard/server/feishu-workflow-api.mjs`
- Test: `taskboard/test/feishu-workflow-api.test.mjs`

**Interfaces:**
- Produces `GET|POST|DELETE /api/local/feishu/workflow/bases/:baseToken/subscription`.
- Consumes a Bridge response shaped `{ subscription: { subscribed: boolean } }`.
- Returns `{ subscription: { subscribed: boolean } }` without persisting it.

- [ ] Add a failing test proving a known Base is proxied with the Taskboard client header and secret, while unknown Base, unsafe bridge location, and malformed Bridge response fail safely.
- [ ] Run `node --test taskboard/test/feishu-workflow-api.test.mjs` and observe the route failure.
- [ ] Add the known-Base validation and a small shared proxy helper in `app.mjs`; add the route and method/body validation in `feishu-workflow-api.mjs`.
- [ ] Re-run the targeted test file and confirm it passes.

### Task 3: Navigator Controls

**Files:**
- Modify: `taskboard/web/src/api.ts`
- Modify: `taskboard/web/src/components/FeishuBaseNavigator.tsx`
- Modify: `taskboard/web/src/App.tsx`
- Test: `taskboard/web/src/components/FeishuBaseNavigator.test.tsx`

**Interfaces:**
- Produces `getFeishuBaseSubscription`, `subscribeFeishuBase`, and `unsubscribeFeishuBase` API helpers.
- Extends `FeishuBaseNavigatorProps` with per-Base subscription actions.

- [ ] Write a failing component test for a Base that renders `Not subscribed`, subscribes after click, and renders `Subscribed`; add a separate cancellation test that requires confirmation and leaves tasks untouched.
- [ ] Run `npm --prefix taskboard exec vitest run web/src/components/FeishuBaseNavigator.test.tsx --environment jsdom` and observe the expected failure.
- [ ] Implement live per-Base status state, refresh control, subscription action, cancel confirmation, pending state, and accessible feedback; wire App API calls and existing error surface.
- [ ] Run the targeted component test and confirm it passes.

### Task 4: Integration Verification and Documentation

**Files:**
- Modify: `README.md`
- Test: `test/feishu-base-subscription.test.mjs`
- Test: `test/server.test.mjs`
- Test: `taskboard/test/feishu-workflow-api.test.mjs`
- Test: `taskboard/web/src/components/FeishuBaseNavigator.test.tsx`

- [ ] Document that subscription is per Base, separate from local listener health, and that cancellation affects future events only.
- [ ] Run targeted Bridge, Taskboard, and UI tests; then run `npm test`.
- [ ] Review the final diff for secrets, remote listeners, and unwanted runtime/config changes.
