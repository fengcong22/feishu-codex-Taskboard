# Taskboard Unified AI Editing Plans

## Purpose

Add one Taskboard-managed AI editing plan workflow for every package that opts into a versioned planning protocol. Taskboard owns provider/model configuration, local credentials, call records, plan persistence, review, confirmation, and execution dispatch. Each package owns its editing capabilities, plan format, deterministic validation, evidence interpretation, and execution.

The first provider integration supports OpenAI-compatible APIs. The current Lite and Slicing packages will each receive an independent adapter and acceptance tests. Future packages can expose the same Taskboard adapter lifecycle while declaring their own capabilities and plan format. Packages without the declaration keep their existing behavior.

## Goals

- Let Taskboard configure model providers and models and manage API credentials locally.
- Generate a package-specific structured plan from the user's original editing notes.
- Keep model generation separate from all local execution and state mutation.
- Persist the original notes, provider/model identity, Taskboard and package protocol versions, plan, evidence summary, validation result, confirmation state, and execution receipt.
- Require package-owned deterministic validation before a plan can be confirmed or executed.
- Revalidate the frozen plan and its source/evidence bindings when the user confirms it.
- Give only evidence types required by the selected package and requested operations to the provider.
- Preserve the current behavior of packages that have not opted in.

## Non-goals

- Replacing the existing Taskboard AI chat or Codex execution service.
- Giving the model shell, file, database, browser, package execution, or Taskboard state tools.
- Making an AI plan confirmation equivalent to a Feishu or VM approval.
- Changing Bridge event selection, task routing, automatic execution policy, approval policy, or delivery completion rules.
- Requiring every package to use the same editing operations, plan schema, evidence types, or internal editing engine.
- Sending source videos to a model by default.

## Architecture

Taskboard adds a local planning service separate from `AiChatService`. Its provider client sends a single structured generation request with no tools or function calls. The provider selection and model are Taskboard settings. Credentials are stored in the operating system credential vault; Taskboard's database stores only non-secret provider configuration and an opaque credential reference.

Each package opts in through a data-only declaration in its package manifest. The declaration has a package protocol ID and version, capability descriptions, constraints, input and output schemas, evidence requirements, and a workspace-relative package adapter entrypoint. Taskboard verifies the entrypoint remains inside the registered package workspace and calls it through a fixed JSON request/response protocol. The package implementation remains responsible for deterministic validation and execution. Model output never supplies an executable, path, argument vector, or adapter operation.

The package's validation response identifies each accepted operation and every unsupported, ambiguous, unsafe, or evidence-deficient operation. Taskboard preserves the model proposal and presents these issues for clarification or explicit package-defined confirmation. It must never silently drop an operation or rewrite the proposal to make it pass.

## Data Flow

1. A user opens a Taskboard task, selects the registered package, and enters editing notes.
2. Taskboard loads the package's current planning declaration and captures the package protocol/version and task/source binding.
3. Taskboard asks the package adapter for only the evidence allowed by the declaration and needed for the requested capabilities.
4. The no-tools provider client sends the original notes, the package's declared capabilities/constraints/plan schema, and the selected evidence. It does not send the source video unless a package explicitly requires a bounded visual input.
5. Taskboard stores the original notes and raw structured proposal, then asks the package validator to validate it against the frozen task/source context and evidence.
6. The user reviews the exact proposal and validation findings. Invalid or incomplete plans remain in `needs_clarification`; valid plans enter `awaiting_confirmation`.
7. On explicit user confirmation, Taskboard verifies the actor and plan version, rechecks the package identity/protocol, source hashes and evidence digests, and asks the package validator to validate the same plan again.
8. If revalidation succeeds, Taskboard records the confirmation and dispatches the exact validated plan to the package executor. The executor returns a receipt that Taskboard binds to the plan and execution attempt.

Plan generation does not change task status, VM/Feishu approval state, download state, or delivery state. Confirmation is not approval. Package execution remains subject to existing Taskboard task ownership, source acquisition, approval, resource scheduling, and delivery gates. Any status transition caused by execution uses the existing Taskboard-owned lifecycle.

## Package Planning Protocol

The opt-in package declaration is immutable for a given package identity/revision and includes:

- Planning protocol ID and supported version.
- Per-capability IDs, descriptions, constraints, and risk/confirmation requirements.
- A closed plan input schema and plan output schema, which may be different for each package.
- Evidence types and their bindings, including whether content or only a digest/summary may be sent to the provider.
- A workspace-relative adapter entrypoint and supported fixed verbs: `prepare_evidence`, `validate`, and `execute`.
- Package and protocol versions included in validation and execution receipts.

The fixed adapter protocol uses JSON on stdin/stdout and returns closed, versioned response objects. Unknown response fields, adapter versions, capability IDs, or operations fail closed. A package may return `valid`, `needs_clarification`, or `rejected`; the response must identify each issue and its affected source note/operation. The `execute` verb accepts only a Taskboard-confirmed, hash-bound plan plus its frozen context.

Taskboard discovers package planning declarations by reading the registered package manifest. It does not maintain an alias-based capability table. A missing or incompatible declaration disables only AI planning for that package; it does not disable or change the legacy package runner.

## Evidence and Privacy

- Word-level operations require ASR evidence bound to the exact source SHA-256. Evidence includes the relevant recognized words and unique timestamps needed by the selected package validator; approximate model timestamps alone never authorize word edits.
- Visual operations require selected frames or frame evidence with source identity, source SHA-256, and exact timestamps. A package must reject evidence that does not match the source or its supported visual protocol.
- Other evidence is package-declared and operation-scoped. Taskboard does not send unrelated attachments, whole videos, or unrelated history.
- Each plan record stores evidence type, source identity, content digest, provider/adapter identity, and a safe summary. Large evidence bytes are held in run-owned local files only when required and are not embedded in call logs.
- Provider credentials never enter SQLite settings, call records, package input files, Feishu data, model prompts, error messages, or logs. Raw provider error bodies are not persisted.
- Provider URL, model ID, usage where available, latency, call outcome, and a safe error code are recorded locally.

## Persistence and Confirmation

Plan records and call records are local Taskboard database data. A plan record retains:

- Task and registered package identity/revision.
- Unmodified user notes.
- Provider ID, model ID, Taskboard planning protocol version, package protocol ID/version, and schema digest.
- Raw model proposal and package validation response.
- Source/evidence summaries and SHA-256 bindings.
- Independent confirmation and execution states, timestamps, confirming actor, confirmed plan hash, and package receipt.

Confirmation and execution state are separate. A plan cannot move to `confirmed` or `executing` without an explicit confirmation request for the current plan version and hash. A failed source, package, schema, or evidence recheck marks the plan stale or requires clarification and prevents execution. Re-running model generation creates a new immutable plan attempt; it does not overwrite the previous proposal or receipt.

## User Interface

- Local settings provide provider profiles, compatible endpoint, model selection, credential entry/update/removal, and a connection test. Model discovery may be used when the endpoint supports it; manual model ID selection remains available.
- A task's package planning view starts a new plan, shows prior plan attempts, and presents the original notes, structured plan, required evidence summary, validation findings, model/protocol identity, and confirmation state.
- Unsupported or unresolved items are shown with the package-provided reason and clarification request. Confirmation is unavailable while validation is incomplete or stale.
- No model secret or raw HTTP error is shown in the UI.

## Package Adapters

Lite and Slicing implement their own declared capabilities and schemas. Each validates the model proposal against its existing package contract before it can be confirmed, and executes only its own validated format. Their exact capability lists remain package-owned and may differ. Acceptance tests include valid operations and representative unsupported/evidence-deficient requests; tests do not weaken existing package safety rules.

Future packages can opt in by shipping a compatible declaration and adapter. Taskboard's shared protocol tests validate discovery, schema/version handling, state transitions, evidence binding, and adapter error behavior without a hardcoded alias list.

## Failure Behavior

- Provider unavailable, invalid JSON, schema mismatch, or refusal: persist a safe failed call record and keep task/approval/delivery state unchanged.
- Package reports unsupported/ambiguous operation or missing evidence: persist the proposal and findings as `needs_clarification`; do not execute.
- Package declaration or adapter protocol mismatch: fail closed for planning and leave legacy execution unchanged.
- Source hash, evidence digest, plan hash, or package identity changes before confirmation/execution: mark stale and require a new plan or clarification; never adapt the plan silently.
- Package executor failure: persist the package's safe receipt/error code and let the existing Taskboard lifecycle own any task state transition.

## Acceptance Tests

Taskboard tests cover provider configuration and credential redaction, call/plan persistence, no-tool request construction, missing/invalid model output, per-package declaration discovery, clarification and confirmation transitions, source/evidence/plan staleness, and the guarantee that generation does not mutate task, approval, or delivery state. Provider tests use a local fake OpenAI-compatible endpoint.

Each opted-in package tests its manifest declaration, valid plan validation/execution path, unsupported operation rejection, missing evidence, mismatched source-bound ASR, missing or mismatched visual evidence, and receipt binding. Package tests use synthetic fixtures and do not access production Feishu or deployed runtime data.

An unadapted package acceptance test verifies its current runner and API behavior remain unchanged. README documentation is updated in each affected repository. The full Taskboard test suite, the relevant Lite test suite, and the relevant Slicing test suite are run before completion.
