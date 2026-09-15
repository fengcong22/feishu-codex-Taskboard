# Auto-Cut execution environment repair

**Goal:** Eligible automatic phased Auto-Cut jobs and explicitly consented phased retries use the existing local runner, fail promptly on missing runtime prerequisites, and register their exact verified ZIP through Taskboard.

**Architecture:** Preserve the existing execution coordinator's provenance, policy, package, and concurrency checks. Select the existing local runner for automatic phased jobs and consented retries after those checks. Run a bounded prerequisite check in the same account/environment as that runner, with fixed executable paths. Keep artifact reporting and reconciliation in Taskboard. Manual starts, consent-free retries and ordinary/legacy AI execution retain existing routing and permissions, with fixed Node/taskctl paths for artifact-capable Codex runs.

**Scope:** Source and isolated tests only. Do not restart the live services, change credentials or production state, replay FEI-29, or edit the deployed Auto-Cut package.

**Baseline:** Clean commit `69675ef`; live Taskboard PID 49840 was started at 2026-09-15 20:59:08 from `D:/codex/codex-feishu/taskboard/server/index.mjs`. Its in-memory revision is not exposed. FEI-29's stored execution and the current source agree that first runs select Codex with `workspace-write`; the local runner is currently restricted to consented retries.

## Work and validation

- [x] Runner tests first: extend `taskboard/test/autocut-local-runner.test.mjs` with missing/inaccessible CLI, authentication/readiness directories, timeout, cancellation, safe error output, and fixed-path process launch scenarios. Observed expected failures before implementing the fixes.
- [x] Implement bounded preflight and runtime timeout in `taskboard/server/autocut-local-runner.mjs`; consume the installed deployment/runtime contract, preserve the sanitized environment and exact run paths, and terminate owned subprocesses on timeout. The real package emits preflight progress on stderr; covered by a regression that failed before correction.
- [x] Lifecycle tests first: extend `taskboard/test/feishu-autocut-run-lifecycle.test.mjs` for initial/recovered automatic runs without Codex or taskctl, successful verified ZIP registration, registration failures, and release of active claims. Observed expected failures before implementing the fixes.
- [x] Update `taskboard/server/app.mjs` to use local execution for eligible automatic phased runs and consented retries, retain registration validation, and bound local report waits.
- [x] Document prerequisite checks, failure codes, routing, isolated validation, and deployment steps in README.
- [x] Run targeted Node tests, then repository `npm test` (Node suites, typecheck, web build, component tests) inside this isolated worktree.
- [x] Independently review the final diff against AGENTS.md and fix actionable findings. Record evidence and any remaining external package integration limitation.

## Delivery evidence

- Source branch: `codex/fix-autocut-execution-environment`, worktree `D:/codex/worktrees/codex-feishu-autocut-environment`; original `D:/codex/codex-feishu` remains clean on `main` at `69675ef`. No commit, merge, deployment, service restart, production replay or state/credential edit was performed.
- Final `npm test` exited 0 on 2026-09-15: Node tests 1585 passed, 3 skipped, 0 failed (1588 total); TypeScript typecheck and web build passed; 61 component tests in 5 files passed. Logs are local ignored files `.runtime/autocut-repair-tests-final.log` and `.runtime/autocut-final-runner-tests.log`. The web build retains its existing large-chunk warning.
- Isolated lifecycle verification covers automatic start/restart recovery, fixture editing output, real ZIP/receipt/hash registration and `done`; failures block and release claims. The manual Codex fallback invokes the injected absolute Node + CLI with empty PATH. Policy tests retain machine-switch, production-source and package-white-list boundaries.
- Independent review found and verified fixes for stderr preflight progress and Windows CLI resolution mismatch. The runner now rejects unsupported Windows entrypoints, differing adjacent Node installations and redirected shims. Both regressions were observed failing before correction. Review recheck found no remaining blocking issues; the reviewer independently reran 19 runner/prompt tests successfully.
- Deployment and prerequisites are described in the root README's Auto-Cut execution section and `taskboard/README.md`. Windows supports the deployed npm shim layout; alternative native EXE/JS layouts fail early until their resolver contract can be guaranteed. ZIP file IO precedes the five-minute HTTP report deadline and can extend shutdown time.

**Cross-workspace integration:** Auto-Cut's own readiness error handling was delivered separately. The user initially authorized Taskboard fixture validation, then installed `1.6.9+codex.20260915222824`. At 2026-09-15 23:51 CST, the deployment report and installed plugin manifest both matched that version. The real installed CLI identity/readiness probe passed in 338 ms, with unchanged readiness content and isolated job/drafts/ZIP directories; the local receipt is `.runtime/integration-1.6.9/probe-summary.json`. This is prerequisite validation only. The full real-media chain still requires a dedicated test record/document from the user; FEI-29 must not be replayed and the production services have not been switched.

## Authorized local deployment follow-up

On 2026-09-16 the user authorized the next step after stopping FEI-30, which had been launched by the old Taskboard with `workspace-write` and blocked on `lark_cli_unavailable`. This extends the original source-only scope to local deployment and one FEI-30 retry with the existing configured ASR and local output operations. Preserve its earlier attempt and all other tasks, especially FEI-29; do not publish remotely or alter Feishu source records. Before restarting, confirm no active work and back up configuration and state. Keep the existing automatic-execution setting, account, loopback ports and package whitelist. Deploy the reviewed source locally, check health, then retry FEI-30 through the existing consented retry endpoint so the new run uses the local runner and normal ZIP/receipt/hash registration.
