# Taskboard Unified AI Editing Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep Taskboard edits in the current checkout so existing user changes remain present. Create separate Lite and Slicing worktrees from each repository's main branch. Do not edit the deployed Lite directory.

**Goal:** Add a Taskboard-managed, user-confirmed AI planning workflow for every currently enabled package and for future packages that opt into the shared protocol.

**Architecture:** Taskboard resolves package identity only from trusted Feishu provenance and the immutable task package snapshot, sends one no-tools OpenAI-compatible generation request, and persists immutable calls and plans locally. Each package declares its own capabilities, evidence, schema, validation, and execution behavior; Taskboard revalidates the exact proposal and dispatches it only after explicit confirmation through the existing execution gates.

**Tech Stack:** Taskboard Node.js 22.13+, SQLite (node:sqlite), React/TypeScript/Vite/Vitest, @napi-rs/keyring, Node fetch; Auto-Cut Lite Python 3.10-3.12 and pytest; Auto-Cut Slicing Python 3.10-3.12 and pytest.

**Spec:** docs/superpowers/specs/2026-11-03-taskboard-unified-ai-edit-planning-design.md

## Global Constraints

- The first provider integration supports OpenAI-compatible APIs.
- The provider client sends one structured generation request with no tools or function calls.
- Provider credentials are stored in the operating-system credential vault; SQLite stores only non-secret profile data and an opaque credential reference.
- The package alias comes from the trusted task origin and frozen package snapshot, never from a request body, task description, or label.
- Ordinary tasks, simulated origins, and forged markers cannot create or execute plans.
- Only evidence required by the selected package and requested capabilities may be sent to the provider; source videos and unrelated attachments are not sent by default.
- Word-level operations require ASR bound to the exact source SHA-256; visual operations require source identity, SHA-256, and exact frame timestamps.
- Generation does not change task status, approvals, downloads, or delivery state. Plan confirmation is not Feishu or VM approval.
- Every model proposal passes the corresponding package's deterministic validation before confirmation or execution.
- Unsupported, ambiguous, and evidence-deficient operations remain visible and require clarification; no operation is silently dropped or rewritten.
- A package without a compatible declaration keeps its existing runner and behavior; the generic protocol contains no hardcoded package alias list.
- The enabled package aliases in the current local registry are Auto-cut-lite and auto-cut-slicing; the first acceptance pass adapts both through their source repositories.

## Workspaces and Existing Changes

- Taskboard work stays in the current checkout at E:\codex\feishu-codex-Taskboard-main; inspect the current diff in taskboard/server/app.mjs, taskboard/server/database.mjs, and other overlapping files before each edit. Preserve all pre-existing edits and untracked files.
- Lite source work uses E:\codex\Auto-cut-lite-src, in a new worktree at E:\codex\Auto-cut-lite-taskboard-ai-planning on branch codex/taskboard-ai-planning-20261103, based on main.
- Slicing source work uses E:\codex\Auto-cut-slicing-src, in a new worktree at E:\codex\Auto-cut-slicing-taskboard-ai-planning on branch codex/taskboard-ai-planning-20261103, based on main.
- Never edit E:\codex\Auto-cut-lite, which is the managed deployment directory.
- Do not stage or commit a whole Taskboard file that already contains user changes. Before any Taskboard commit, inspect the staged diff and verify it contains only this feature's hunks.

---

### Task 1: Define the Package Planning Protocol

**Repository:** taskboard/

**Files:**
- Create: server/ai-edit-plan-protocol.mjs
- Test: test/ai-edit-plan-protocol.test.mjs

**Interfaces:**

    readPlanningDeclaration(packageRecord)
      -> null | { packageIdentity, protocol, capabilities, constraints,
                  inputSchema, outputSchema, evidence, runtime, entrypoint }

    invokePlanningAdapter({ packageRecord, declaration, verb, input, signal })
      -> Promise<closed JSON response>

The shared protocol identifier is taskboard.package-plan.v1. readPlanningDeclaration reads only the frozen package workspace's PACKAGE-MANIFEST.json, requires a closed interface.aiPlanning object with that exact protocol value, and verifies that the resolved entrypoint is an ordinary file inside the canonical workspace. invokePlanningAdapter accepts only prepare_evidence, validate, or execute; resolves node/python to an absolute Taskboard-approved runtime; uses spawn with shell: false; caps JSON stdin at 16 MiB, stdout at 4 MiB, retained stderr at 64 KiB, and rejects unknown response fields. validate has a 120-second timeout; prepare_evidence and execute have a 120-minute ceiling and support the existing cancellation policy.

- [ ] **Step 1: Add tests for manifest opt-in and path containment.** Write tests that an absent declaration returns null, a valid declaration is returned with package identity and manifest digest, and ../outside.py, an absolute path, a symlinked entrypoint, unknown fields, and an unsupported protocol version fail with AI_EDIT_PACKAGE_INVALID.
- [ ] **Step 2: Run node --test test/ai-edit-plan-protocol.test.mjs.** Confirm the new import fails because the module does not exist.
- [ ] **Step 3: Implement the closed manifest reader and shell-free adapter invoker.** Define protocol constants and maximum input/output sizes in this module; reject unknown verbs before spawning; serialize exactly { protocol, version, verb, input } to stdin; parse exactly one JSON object from stdout; and map process failures to safe AI_EDIT_PACKAGE_* codes without returning stderr or paths.
- [ ] **Step 4: Test a fake Node adapter round trip and all fail-closed paths.** Verify malformed JSON, extra response fields, nonzero exit, timeout, oversized output, and an unknown verb never yield an accepted response.

### Task 2: Persist Provider Profiles, Calls, Plans, and Receipts

**Repository:** taskboard/

**Files:**
- Modify: server/database.mjs
- Create: test/ai-edit-plan-database.test.mjs

**Interfaces:**

    createAiEditProviderProfile(input)
    getAiEditProviderProfile(id)
    listAiEditProviderProfiles()
    updateAiEditProviderProfile(id, expectedVersion, changes)
    deleteAiEditProviderProfile(id, expectedVersion)

    createAiEditCall(input)
    getAiEditCall(id)
    listAiEditCalls(filters)

    createAiEditPlan(input)
    getAiEditPlan(id)
    listAiEditPlans(taskId)
    updateAiEditPlan(id, expectedVersion, changes)

Provider rows contain profile ID, label, endpoint, model ID, opaque credential reference, and optimistic version only. Call rows contain provider/model identity, elapsed time, usage, outcome, and safe error code. Plan rows retain the exact original notes, provider/model identity, Taskboard and package protocol versions, schema digest, raw proposal, evidence summary/digests, validation result, confirmation actor/time/hash, independent execution state, and package receipt. Confirmation states are needs_clarification, awaiting_confirmation, confirmed, or rejected; allowed transitions are needs_clarification to awaiting_confirmation and awaiting_confirmation to confirmed or rejected. Execution states are not_started, queued, running, completed, failed, or stale; normal transitions are not_started to queued, queued to running, and running to completed or failed, with any pre-execution binding failure moving to stale. No database input or row includes a credential value.

- [ ] **Step 1: Write migration and CRUD tests.** Verify database reopen/migration, exact untrimmed note preservation, immutable proposal and package identity, version conflicts, evidence and plan hashes, safe call outcomes, and independent confirmation/execution states.
- [ ] **Step 2: Run node --test test/ai-edit-plan-database.test.mjs.** Confirm the missing methods/tables fail.
- [ ] **Step 3: Add tables, indexes, row mappers, and optimistic updates.** Use closed SQL state checks; reject updates to immutable notes, proposal, evidence, provider/model identity, and protocol fields after insert. Store provider profiles in Taskboard's existing SQLite database and only credential references.
- [ ] **Step 4: Add state-transition tests.** A repeated confirmation for the same plan version/hash must not create a second execution; a version/hash mismatch must fail without changing the row; a new model generation creates a new plan attempt.

### Task 3: Add Local Provider Settings and OS-Vault Credentials

**Repository:** taskboard/

**Files:**
- Create: server/ai-edit-provider-settings.mjs
- Create: server/ai-edit-credentials.mjs
- Test: test/ai-edit-provider-settings.test.mjs
- Modify: package.json
- Modify: package-lock.json

**Interfaces:**

    normalizeProviderProfile(input) -> { id, label, baseUrl, model, credentialRef }
    createCredentialStore({ keyring }) -> { set(profileId, secret), resolve(profileId), delete(profileId) }

normalizeProviderProfile rejects URL userinfo, query, fragment, model IDs that are empty, longer than 200 characters, or contain control characters, and non-HTTPS endpoints except HTTP loopback. It stores a normalized base URL with one trailing slash so appending chat/completions preserves a versioned path such as /v1/. The credential store uses @napi-rs/keyring for production and an injected in-memory backend in tests. Credential resolution is server-internal and is never exposed through profile reads or UI responses.

- [ ] **Step 1: Write profile and vault tests.** Cover HTTPS endpoint normalization, loopback-only HTTP, rejection of remote HTTP and embedded credentials, and secret save/resolve/replace/delete through an injected backend.
- [ ] **Step 2: Run node --test test/ai-edit-provider-settings.test.mjs.** Confirm the module imports fail.
- [ ] **Step 3: Implement profile validation and the vault wrapper.** Use a fixed Taskboard service namespace plus the stable profile ID as the vault key; return only a boolean credential-present state to the API; ensure error messages contain no secret or raw vault error text. Add the production binding with npm install @napi-rs/keyring and record the resolved version in package-lock.json.
- [ ] **Step 4: Add the keyring dependency and redaction checks.** Verify JSON serialization of profiles, thrown errors, and API-ready settings never contains the credential value.

### Task 4: Implement the No-Tools OpenAI-Compatible Provider

**Repository:** taskboard/

**Files:**
- Create: server/ai-edit-provider.mjs
- Test: test/ai-edit-provider.test.mjs

**Interface:**

    generateStructuredEditPlan({
      profile, credential, packageDeclaration, rawNotes, evidence, signal, fetchImpl
    }) -> { requestedModel, returnedModel, content, usage }

The client sends exactly one JSON generation request per planning call, using the selected model, package capability/constraint/schema declaration, exact original notes, and selected evidence. It never sends tools, functions, shell commands, file paths, source video bytes, or unrelated attachments. The serialized request and response are each capped at 8 MiB; generation has a 120-second timeout. Provider bodies and authorization headers are excluded from logs and errors.

- [ ] **Step 1: Write a local fake-provider test.** Start a loopback HTTP fixture, capture the request body and headers, and assert the selected model, package declaration, raw notes, scoped evidence, JSON response format, and absence of tools/functions.
- [ ] **Step 2: Run node --test test/ai-edit-provider.test.mjs.** Confirm the provider module is missing.
- [ ] **Step 3: Implement OpenAI-compatible JSON generation.** Construct the chat-completions URL from the normalized base URL, pass the credential only in the Authorization header, parse the returned model/content/usage, and return a safe coded error for non-2xx, timeout, refusal, invalid JSON, or oversized response.
- [ ] **Step 4: Test failure redaction and settings discovery.** Assert no response body or key appears in errors; test optional model discovery separately from generation so a planning call still sends only one generation request.

### Task 5: Implement Planning, Clarification, Revalidation, and Dispatch

**Repository:** taskboard/

**Files:**
- Create: server/ai-edit-planning.mjs
- Test: test/ai-edit-planning.test.mjs
- Consume: server/ai-edit-plan-protocol.mjs, server/ai-edit-provider.mjs, server/ai-edit-provider-settings.mjs, server/database.mjs

**Interfaces:**

    AiEditPlanningService.createPlan({ taskId, rawNotes, expectedTaskVersion, signal })
    AiEditPlanningService.listPlans({ taskId })
    AiEditPlanningService.confirmPlan({
      taskId, planId, expectedVersion, planSha256, actor
    })

The service resolves the task only through the server-registered Feishu origin and frozen package snapshot, rejects deliverySource === "simulation", checks expectedTaskVersion, resolves the registered package workspace from that snapshot, and binds the plan to the snapshot and manifest digest. It obtains evidence only through the package adapter's prepare_evidence verb, then validates the exact provider proposal using validate. It persists the original proposal and all findings before returning. Unsupported or incomplete plans are needs_clarification; valid plans are awaiting_confirmation.

    const evidence = await invokePlanningAdapter({
      packageRecord, declaration, verb: "prepare_evidence",
      input: { taskContext, rawNotes }, signal,
    });
    const generated = await generateStructuredEditPlan({
      profile, credential, packageDeclaration: declaration,
      rawNotes, evidence: evidence.providerEvidence, signal,
    });
    const validation = await invokePlanningAdapter({
      packageRecord, declaration, verb: "validate",
      input: { taskContext, evidence: evidence.binding, proposal: generated.content }, signal,
    });
    return persistCallAndPlan({ rawNotes, generated, evidence, validation });

On confirmation, the service checks the current task origin and snapshot, package identity and manifest digest, plan version and hash, and every source/evidence digest; it reruns package validation on the byte-identical proposal and dispatches only that proposal if validation remains valid. Package execution is reached through existing Taskboard scheduling and approval gates. Confirmation alone does not create or clear Feishu/VM approvals, acquire material, upload artifacts, or change delivery state. Duplicate confirmation is idempotent and cannot start a second executor attempt.

- [ ] **Step 1: Write tests for trusted scope and generation side effects.** Use fake provider/adapter/database dependencies to test ordinary tasks, absent snapshots, package-less tasks, forged markers, and simulated origins are rejected; verify a successful or clarification generation preserves task status, approval records, download records, delivery records, and original note bytes.
- [ ] **Step 2: Run node --test test/ai-edit-planning.test.mjs.** Confirm the service module is missing.
- [ ] **Step 3: Implement dependency-injected service methods.** Persist a safe call record on provider/package failures; persist a plan for every returned structured proposal, including invalid proposals; include only evidence summaries/digests in call rows; keep original evidence bytes out of SQLite.
- [ ] **Step 4: Add confirmation and execution tests.** Verify revalidation uses the exact stored proposal, changed source/package/protocol/evidence/plan blocks execution as stale, duplicate confirmation dispatches once, and executor errors create a safe receipt without bypassing existing lifecycle gates.

### Task 6: Dispatch Confirmed Plans Through Existing Execution Gates

**Repository:** taskboard/

**Files:**
- Modify: server/feishu-execution-coordinator.mjs
- Modify: server/autocut-local-runner.mjs
- Modify: server/vm-pmo-orchestrator.mjs
- Modify: server/vm-pmo-runtime.mjs
- Test: test/feishu-execution-coordinator.test.mjs
- Test: test/vm-pmo-orchestrator.test.mjs
- Test: test/vm-pmo-runtime.test.mjs

**Interface:**

    dispatchConfirmedPlan({ task, origin, packageSnapshot, plan, actor })

Dispatch is keyed by immutable plan ID and confirmed version/hash. Lite execution acquires the existing package resource lease and Taskboard lifecycle before calling the package adapter. Slicing initial-stage execution can attach only to the same trusted task/run after its existing approval is ready and its approved acquisition hash matches; review-stage execution reuses only the frozen, already confirmed parent-delivery hash and does not request a new VM approval. Both paths recheck package identity and current-run bindings. A plan cannot create a VM approval, reserve/download source material, start a new task/run, or write delivery state by itself. The exact confirmed proposal and binding evidence are handed to the package executor; Taskboard keeps its existing status notifications and resource ownership.

- [ ] **Step 1: Write coordinator and VM lifecycle tests.** Verify an unconfirmed plan cannot dispatch, a repeated plan ID/version/hash starts only one executor, a Lite plan holds the configured package slot, an initial Slicing run waits for its existing approval and matches the approved acquisition SHA, and a review run reuses only its frozen parent delivery without a new approval.
- [ ] **Step 2: Run the three targeted node --test files.** Confirm the new dispatcher hooks/tests fail before implementation.
- [ ] **Step 3: Add the plan ID and hash to the existing execution reservation.** Use the existing durable coordinator and VM run binding; do not create a parallel task-status or approval state machine. Resolve the package from the frozen snapshot at dispatch time and call only its fixed execute verb.
- [ ] **Step 4: Test lifecycle isolation and recovery.** Assert plan generation and confirmation do not create approvals, downloads, VM runs, artifacts, uploads, or Feishu writebacks; assert dispatch refuses changed approval/source/package bindings and duplicate dispatches return the existing execution result.

### Task 7: Add Loopback-Guarded HTTP APIs

**Repository:** taskboard/

**Files:**
- Modify: server/app.mjs
- Test: test/ai-edit-planning-http.test.mjs

**Routes:**

    GET/PUT    /api/local/ai-edit/providers
    PUT/DELETE /api/local/ai-edit/providers/:id/credential
    POST       /api/local/ai-edit/providers/:id/test
    GET/POST   /api/local/tasks/:id/ai-edit-plans
    POST       /api/local/tasks/:id/ai-edit-plans/:planId/confirm

Provider/task write routes use the existing local Host/Origin/client guards. Task routes call requireTrustedFeishuTask(task, { requirePackage: true }), reject origin.deliverySource === "simulation", and derive the package only from the immutable package snapshot. Request bodies reject unknown keys and cannot select a package alias.

- [ ] **Step 1: Write HTTP tests before adding routes.** Cover provider profile reads/writes, credential write-only behavior, connection tests, ordinary/simulated/forged task rejection, frozen package resolution, confirmation version/hash conflict, loopback Host/Origin guards, and malformed/extra body fields.
- [ ] **Step 2: Run node --test test/ai-edit-planning-http.test.mjs.** Confirm route tests fail with NOT_FOUND.
- [ ] **Step 3: Wire the service into createTaskboardServer and implement the routes.** For plan creation accept only { rawNotes, expectedTaskVersion }; for confirmation accept only { expectedVersion, planSha256 }; derive the actor with the existing request helper; never serialize credentials, raw provider errors, source paths, or evidence bytes.
- [ ] **Step 4: Assert state isolation through HTTP.** Snapshot task, approval, download, Feishu writeback, and delivery rows before generation and assert byte-equivalent values after both valid and clarification responses.

### Task 8: Adapt Auto-Cut Lite

**Repository:** E:\codex\Auto-cut-lite-taskboard-ai-planning, based on E:\codex\Auto-cut-lite-src main.

**Files:**
- Modify: scripts/release/build_lite_plugin.py
- Modify: scripts/release/validate_lite_plugin_package.py
- Create: scripts/utils/taskboard_plan_adapter.py
- Create: tests/test_taskboard_plan_adapter.py
- Modify: tests/test_validate_lite_plugin_package.py
- Modify: tests/test_runtime_integrity.py
- Modify: plugins/auto-cut-lite/README.md
- Modify: docs/source-manifest.md

Lite's generated manifest declares only the capabilities its current revision workflow can validate and execute. The adapter uses a closed Lite plan schema and maps supported fields to the maintained revision request format. validate calls deterministic revision validation without creating a draft; execute revalidates the exact confirmed input and invokes the maintained revision runner. Unsupported operations and missing/changed source-bound evidence return explicit per-operation findings. It does not export video or change Taskboard/Feishu states. New plans use only a registered package snapshot whose frozen manifest digest includes this declaration; historical snapshots are not rewritten.

- [ ] **Step 1: Create the Lite worktree from main and verify its branch and clean status.** Keep the source checkout and deployed Lite directory untouched.
- [ ] **Step 2: Write adapter and release tests.** Use synthetic fixtures for a supported revision, unsupported animation, missing ASR for a word operation, changed source SHA, and exact raw-note retention. Assert an unsupported operation remains in the findings and is not removed from the proposal.
- [ ] **Step 3: Run python -m pytest tests/test_taskboard_plan_adapter.py -q.** Confirm the new adapter test fails because the adapter and manifest declaration are absent.
- [ ] **Step 4: Implement the adapter protocol.** Read one bounded JSON object from stdin, validate the fixed verb, call existing revision-model/runner validation functions, and emit one closed JSON response. Add interface.aiPlanning to the generated PACKAGE-MANIFEST.json and verify the release validator preserves the declaration and entrypoint.
- [ ] **Step 5: Test execution isolation.** Verify validation creates no draft or output; execution rejects an unconfirmed plan and changed plan/source/evidence hashes; receipts bind the confirmed plan hash and source hash.
- [ ] **Step 6: Update Lite documentation and run python -m pytest tests/test_taskboard_plan_adapter.py tests/test_validate_lite_plugin_package.py tests/test_runtime_integrity.py tests/test_revision_runner.py -q.** Commit only reviewed Lite worktree changes.

### Task 9: Adapt Auto-Cut Slicing

**Repository:** E:\codex\Auto-cut-slicing-taskboard-ai-planning, based on E:\codex\Auto-cut-slicing-src main.

**Files:**
- Modify: PACKAGE-MANIFEST.json
- Create: auto_cut_slicing/taskboard_adapter.py
- Test: tests/test_taskboard_adapter.py
- Modify: docs/taskboard-contract.md
- Modify: README.md

Slicing declares its supported range selection, exact word deletion, mute, complete-word start cue, synchronized speech/visual cue, and freeze-frame operations from VM contract v2. prepare_evidence supplies only source-bound ASR or selected source/timestamp-bound frame evidence required by the proposal. validate maps the package plan into the maintained job/VM v2 validators without rendering. execute rechecks the frozen plan and evidence and uses the established draft/render path only when the Taskboard task's existing material and approval gates are satisfied. New plans require a frozen package snapshot whose manifest digest includes this declaration; existing task snapshots are never rewritten.

- [ ] **Step 1: Create the Slicing worktree from main and verify its branch and clean status.** Keep the source checkout untouched.
- [ ] **Step 2: Write Slicing adapter tests.** Cover a valid exact range, a uniquely source-bound word operation, missing/changed ASR, missing/mismatched frame evidence, unsupported operation, and VM review image rejection. Verify validation never creates an MP4.
- [ ] **Step 3: Run python -m pytest tests/test_taskboard_adapter.py -q.** Confirm it fails because the adapter is absent.
- [ ] **Step 4: Implement the adapter and declaration.** Use closed JSON request/response objects and existing compile_job, parse_instruction, alignment, visual, and VM v2 validators; reject unknown operations and fields without normalizing or dropping them.
- [ ] **Step 5: Test execution gates and receipts.** Verify source/ASR/frame/plan hash changes block execution, unconfirmed input is rejected, validation cannot render, and execution cannot create or mutate approval/delivery state.
- [ ] **Step 6: Document the package contract and run python -m pytest tests/test_taskboard_adapter.py tests/test_cli.py tests/test_vm_pmo.py -q.** Commit only reviewed Slicing worktree changes.

### Task 10: Add Provider Settings and Plan Review UI

**Repository:** taskboard/

**Files:**
- Modify: web/src/api.ts
- Modify: web/src/types.ts
- Create: web/src/components/AiEditPlanningSettings.tsx
- Create: web/src/components/AiEditPlanningSettings.test.tsx
- Modify: web/src/components/LocalSettingsDialog.tsx
- Create: web/src/components/AiEditPlanPanel.tsx
- Create: web/src/components/AiEditPlanPanel.test.tsx
- Modify: web/src/components/TaskDetail.tsx
- Modify: web/src/styles.css
- Modify: package.json (test:components)

Settings edit provider, endpoint, model, and credential. Credential input is write-only; after save, the UI receives only credentialPresent. The task panel is rendered only when the server reports a trusted package snapshot and compatible declaration. It displays original notes, exact structured proposal, package validation findings, evidence summary, provider/model/protocol identity, and separate confirmation and execution states. The confirmation control is disabled unless server validation and freshness checks pass.

- [ ] **Step 1: Write component tests.** Verify a saved secret is never shown again, absent/ordinary/unadapted task data hides the panel, clarification findings are visible, stale or invalid plans cannot be confirmed, and a valid confirmation sends the displayed plan hash/version.
- [ ] **Step 2: Run npx vitest run web/src/components/AiEditPlanningSettings.test.tsx web/src/components/AiEditPlanPanel.test.tsx --environment jsdom.** Confirm missing imports/components fail.
- [ ] **Step 3: Add typed API methods and UI.** Connect profile CRUD, credential replacement/removal, model selection, plan list/create, and explicit confirmation to the routes in Task 7; keep all plan data server-authoritative.
- [ ] **Step 4: Register both tests in test:components and rerun them.** Assert credentials and raw API errors are never rendered, and confirmation is disabled for needs_clarification, stale hashes, or non-awaiting state.

### Task 11: Add Cross-Package Acceptance and Documentation

**Repository:** Taskboard root and taskboard/

**Files:**
- Modify: README.md
- Modify: taskboard/README.md
- Modify: taskboard/README.zh-CN.md
- Test: taskboard/test/ai-edit-planning.test.mjs
- Test: taskboard/test/ai-edit-planning-http.test.mjs
- Test: taskboard/web/src/components/AiEditPlanPanel.test.tsx

- [ ] **Step 1: Document the operator workflow.** Explain OpenAI-compatible profile/model setup, OS-vault credential handling, package opt-in, evidence privacy, clarification, plan confirmation, and the fact that confirmation is not approval. Do not document credentials, local paths, or secrets.
- [ ] **Step 2: Add generic compatibility acceptance tests.** Verify both fixture declarations can be discovered without alias-specific Taskboard code; an unadapted fixture still uses its legacy runner and has no planning route; ordinary, simulated, and forged-marker tasks remain excluded.
- [ ] **Step 3: Run Taskboard targeted and full verification from taskboard/:**

      node --test test/ai-edit-plan-protocol.test.mjs test/ai-edit-provider-settings.test.mjs test/ai-edit-provider.test.mjs test/ai-edit-plan-database.test.mjs test/ai-edit-planning.test.mjs test/feishu-execution-coordinator.test.mjs test/vm-pmo-orchestrator.test.mjs test/vm-pmo-runtime.test.mjs test/ai-edit-planning-http.test.mjs
      npm run typecheck
      npm run build:web
      npm test

- [ ] **Step 4: Run the Lite and Slicing commands from their respective worktrees.** Use the targeted package suites specified in Tasks 8 and 9, then run each repository's full pytest suite if the targeted suites pass.
- [ ] **Step 5: Review all three repository diffs.** Confirm the Taskboard current worktree retains every pre-existing user edit, no credentials or runtime state were added, and package worktree commits contain only the adapters, declarations, tests, and documentation for this feature.

## Self-Review

- **Spec coverage:** provider/model settings and OS-vault credentials are Tasks 2-4 and 10; call/plan/receipt persistence is Task 2; trusted package discovery and no-tools generation are Tasks 1, 4-7; evidence and deterministic validation are Tasks 5, 8, and 9; confirmation/revalidation and isolated execution are Tasks 5-7; current-package adapters and acceptance are Tasks 8-9; future opt-in and unadapted compatibility are Tasks 1 and 11; README and full verification are Task 11.
- **Placeholder scan:** no TBD/TODO or unspecified acceptance step remains; each test task identifies concrete cases and command.
- **Interface consistency:** Task 5 uses the exact invokePlanningAdapter verbs from Task 1; Task 6 accepts only confirmed plan ID/version/hash; DB methods match provider, call, and plan service responsibilities; HTTP body fields match the confirmation service signature; both package adapters use the same fixed JSON protocol while keeping package plan schemas distinct.
