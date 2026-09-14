# Windows Source Onboarding Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a Chinese Windows source-deployment runbook that a target computer's already available Codex can execute to deploy and validate the stack with that user's own Feishu application, Base, and local configuration.

**Architecture:** Add one self-contained Codex-facing Markdown runbook under `docs/` and one discoverability link in the root README. The runbook mirrors the existing scripts and `AGENTS.md` safety contract, separates shared source files from per-machine secrets, defines automatic execution versus human pause points, and requires a redacted verification report.

**Tech Stack:** Markdown, PowerShell commands, existing Node.js scripts, Feishu official documentation links, GitHub source repository.

## Global Constraints

- Use the canonical repository URL `https://github.com/fengcong22/feishu-codex-Taskboard` in all new commands and links.
- Assume Codex is already available and logged in on the target computer; do not add Codex installation, update, or login steps.
- Require Node.js `>=22.13`, two lockfile-exact `npm ci` installs, the complete test command, and a clean full worktree afterward before real Feishu validation.
- Keep Bridge and Taskboard on `127.0.0.1`; do not change ports or listener boundaries.
- Use the target computer's existing Codex environment and the target user's own Feishu app credentials, Base, table, fields, workspace paths, and runtime state.
- Never request, copy, print, commit, or share `%USERPROFILE%\.codex`, another computer's private local JSON configuration, `.env.local`, `.runtime`, tokens, or Bridge secrets. Creating this computer's ignored JSON files from tracked examples is allowed.
- Keep `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` unset during deployment and validation; simulated events never qualify for automatic execution.
- Run the sensitive/Git environment gate before the first Git, Node, npm, Codex, or repository-script invocation in every new PowerShell process; an empty variable still counts as set. Besides Git/Node/npm override families, reject `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `SSL_CERT_FILE`, and `CURL_CA_BUNDLE`.
- Accept only fully qualified paths on ready fixed local drives for the clone target, enabled package workspaces, and all executable paths; reject mapped network drives and reparse-point path components, and normalize existing files with `Resolve-Path` before use.
- Resolve Git, Node.js, npm, and Codex once in phase A, retain those exact paths in the deployment context, and use the same files in every later direct call or repository start/stop block. Reject inherited `CODEX_EXECUTABLE`; a non-default Codex path requires explicit user confirmation through a local run-only variable. Require `node.exe` and `npm.cmd` to be a same-directory installed pair, invoke direct npm operations as the confirmed Node plus the paired `node_modules/npm/bin/npm-cli.js`, and make root-script bare `npm` resolve to that same pair through the checked PATH.
- Resolve `CODEX_HOME` once in phase A as the target user's default directory or an explicitly confirmed existing local fixed-drive directory; inject that exact directory with the exact `CODEX_EXECUTABLE` into every block that starts Taskboard/Codex, without reading, printing, or copying its contents.
- Isolate clone and fetch from system/global Git configuration with `GIT_CONFIG_NOSYSTEM=1` plus a newly created zero-byte global config file; never inject a relative `include.path` from command scope.
- Point npm's default registry configuration at `https://registry.npmjs.org/`, do not set `replace-registry-host=always`, and use `npm ci` so existing lockfile `resolved` hosts and the approved worktree remain unchanged; a lockfile supply-chain migration is a separate reviewed change.
- Use a fresh, previously nonexistent clone directory for the first deployment and every later version; do not reuse or update an existing worktree in place, and do not copy its `.git` or `.runtime`.
- Do not claim that starting the repository automatically creates a Feishu Base event subscription; the colleague or Base administrator must complete the official Feishu setup.
- Do not modify Bridge or Taskboard runtime behavior.

---

### Task 1: Write the Chinese Windows deployment runbook

**Files:**
- Create: `docs/windows-source-install-guide.zh-CN.md`
- Read: `AGENTS.md`, `README.md`, `config/bridge.example.json`, `config/autocut-packages.example.json`, `scripts/start-local.ps1`, `scripts/check-local.ps1`, `scripts/stop-local.ps1`, `scripts/simulate-ready.ps1`

**Interfaces:**
- Consumes: Existing repository commands, configuration schemas, loopback ports, and Feishu event behavior.
- Produces: A Codex execution contract with automatic steps, human pause points, and a redacted final report for a new Windows machine.

- [x] **Step 1: Add the scope and privacy boundary.**

  Document the canonical GitHub URL, the shared source files, and the private per-machine files. State that the target user still uses their own Codex account and Feishu tenant app, and that no current-machine login state, credentials, paths, task history, or runtime state is transferred.

- [x] **Step 2: Add prerequisite and clone commands.**

  Tell Codex to check Git for Windows, Node.js `>=22.13`, and whether the existing `codex.exe` is discoverable with local verification commands. Do not install, update, log in to, or repair Codex; return missing or unusable prerequisites to the user. Reject inherited `CODEX_EXECUTABLE`; only an explicitly user-confirmed local path supplied through the current run's local variable may override discovery. Resolve Git, Node.js, npm, npm's paired CLI entry, and Codex as existing fully qualified local-drive files and retain those exact paths without printing them. Require Node and npm to be a same-directory pair, capture the npm version through the confirmed Node, and make later direct npm operations use that Node plus `npm-cli.js`. Explain that Rust, Visual Studio Build Tools, and Windows SDK are not required for source-mode operation. Before the first external command, reject inherited Feishu, Bridge, automatic-execution, Git, Node, npm, TLS-override, proxy, and CA variables by existence rather than non-empty value. Clone from the canonical origin into a user-confirmed, fully qualified fixed-local-drive path that does not yet exist, using the confirmed Git executable, an empty template, disabled system configuration, and a newly created zero-byte Git config. Before any npm or repository script runs, require a clean checkout that exactly matches the canonical origin's freshly fetched `main` or tag; then create stable zero-byte Git/npm isolation configs under the ignored `.runtime/bootstrap` directory for dependency installation and later launches. A complete approved commit SHA must be a commit in the freshly fetched canonical `main` history. Do not trust existing local tags or remote-tracking refs, mapped network drives, reparse-point path components, or user/global `.npmrc` files.

  ```powershell
  $workDirectory = '<user-confirmed absolute work directory>'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_CONFIG_GLOBAL = '<new zero-byte config file>'
  & $confirmedGitExecutable -c credential.interactive=never -c protocol.allow=never -c protocol.https.allow=always clone --config core.hooksPath=NUL --template='<new empty template directory>' --no-local https://github.com/fengcong22/feishu-codex-Taskboard.git $workDirectory
  Set-Location -LiteralPath $workDirectory
  $originUrl = ([string](& $confirmedGitExecutable remote get-url origin 2>$null)).Trim()
  # Validate the canonical repository identity without printing the stored URL.
  & $confirmedGitExecutable status --porcelain=v1 --untracked-files=all
  ```

- [x] **Step 3: Add dependency installation and test gates.**

  Instruct Codex to run both installs and the complete test command:

  ```powershell
  & $confirmedNodeExecutable $confirmedNpmCli ci
  & $confirmedNodeExecutable $confirmedNpmCli ci --prefix taskboard
  & $confirmedNodeExecutable $confirmedNpmCli test
  ```

  Make clear that a failed test stops the process before real Feishu connection.
  Do not set `replace-registry-host=always`. Explain that the isolated npm configuration uses the official default registry while existing approved `resolved` URLs remain unchanged. Require `npm ci` to fail on lockfile/manifest mismatch and require the complete repository worktree to remain clean after both installs and tests. Assert that the root test script's bare `npm` resolves through PATH to the confirmed same-directory `npm.cmd`/Node pair.

- [x] **Step 4: Add personal Feishu application setup.**

  Define the pause message Codex gives the user for the official SDK long-connection event `drive.file.bitable_record_changed_v1`, the absence of a public callback requirement, the application-identity permission review, Base resource ACL, and optional Wiki node read access. Link the official Feishu event, long-connection, permission, Bitable, and Wiki pages. Tell Codex to direct the user to follow the developer console's current “required permissions” and `missing_scopes` output rather than guessing a scope name or adding write permissions. Explicitly state that the repository does not call the one-time Base event-subscription API; if the tenant requires it, a Base owner/manager/admin must complete the official setup.

- [x] **Step 5: Add local configuration instructions.**

  Tell Codex how to copy the two example JSON files without overwriting existing files. Use one legacy `tables` single-start-value entry as the required first harmless validation path: bind new state paths to the current clone, have the user fill only the dedicated test Base/table/field identifiers locally, set `mode = manual`, require enabled `defaultPackageAlias = Auto-cut-copyA`, and keep `packageField`/`packageFieldId` null. Update only the harmless demo package path. Do not import a Taskboard-managed phased subject for this first validation or try to disable all phases; the UI requires at least one enabled phase. Explain that a later phased workflow is separate and needs at least one enabled stage plus its complete ZIP/driver-report fixture. Require `host` `127.0.0.1` and `taskboardUrl` `http://127.0.0.1:47823`. Provide a redacted `.env.local` example containing only the user's own `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. Explain that `start-local.ps1` generates one per-start Bridge secret for both services and that automatic execution remains off.

- [x] **Step 6: Add safe and real validation paths.**

  Fail closed before every start when advanced environment overrides could select another config, dotenv, Taskboard checkout, package registry, runtime file, listener mode, automatic-execution policy, process-level Feishu credentials, TLS/proxy/CA behavior, or extra `.env.local` settings. Use the exact phase-A Git/Node.js/npm paths for repository scripts, validate the same-directory Node/npm pair and npm version, make direct npm calls through the confirmed Node plus `npm-cli.js`, and inject the exact phase-A Codex path and `CODEX_HOME` into each Taskboard/Codex start process, failing on any path change or PowerShell shadowing. Reject enabled package workspaces unless they are existing directories on ready fixed local drives and their path chains contain no reparse points. Separate default local health checks from real Feishu validation, and explicitly assert `disabled` because the existing default check command does not. Explain the fixed-ID/fixed-fixture limitation of `simulate-ready.ps1`; compare Taskboard task ID sets before and after both calls, and validate both responses so a pre-existing task, stale duplicate, ignored, blocked, retry, or dead-letter result cannot pass. Explain the `-EnableFeishu`/`-RequireFeishu` commands, the meaning and limitation of `sdk_managed`, and the requirement to change a record only in a designated test Base. State that simulation cannot auto-execute and that end-to-end delivery is at-least-once, not exactly-once. The first real harmless validation must use the dedicated legacy `tables` start-value entry with `mode = manual`, `defaultPackageAlias = Auto-cut-copyA`, null package fields, and the tracked `examples/harmless-auto-cut` package. It must not import a phased subject or disable all stages. Before the user's one manual start, verify with fixed-code output that the new real-event task's frozen package snapshot points to that example and retains the tracked harmless prompt. Capture the selected `todo` task without a `threadId` from `GET /api/tasks/{taskId}` and the pre-click ID set from `GET /api/local/ai/threads`; after one manual click, require the task to bind a previously unseen thread. Capture its only run from `GET /api/local/ai/threads/{threadId}`, retain that exact run ID for every later query, and reject multiple runs. Require `run.threadId == task.threadId == snapshot.thread.id`, then accept only `completed` with a nonempty `finishedAt` and `exitCode === 0`; fail on `failed`, `interrupted`, unknown status, missing terminal fields, or timeout. Never use `runs.at(-1)` as final proof. Require the tracked demo directory to remain clean after this dynamic evidence succeeds while automatic execution stays disabled.

- [x] **Step 7: Add daily operations, fresh-version deployment, and troubleshooting.**

  Document Codex-run start/check/stop commands, require each new version to use another fresh clone directory, list log locations, and keep the fixed troubleshooting order. Do not provide an in-place update flow or migrate old local configuration automatically. Prohibit deleting or hand-editing state/lock files, changing loopback to LAN/public addresses, or putting paths/commands/prompts/secrets in Feishu cells. Human double-click launchers are outside this Codex-facing runbook.

- [x] **Step 8: Add the paste-ready Codex prompt.**

  Make the runbook itself the prompt: tell Codex to read `AGENTS.md` and this guide, work only in the selected clone, install both dependency trees, run tests, create only ignored local configuration, pause for Feishu app creation/App Secret/permission approval, keep automatic execution disabled, report redacted verification results, and never request or disclose another computer's private data.

### Task 2: Add README discoverability

**Files:**
- Modify: `README.md` near the existing “团队交接与健康检查” section

**Interfaces:**
- Consumes: `docs/windows-source-install-guide.zh-CN.md`.
- Produces: A stable relative Markdown link visible to maintainers and new colleagues.

- [x] **Step 1: Add one concise Chinese entry-point paragraph.**

  Link to `./docs/windows-source-install-guide.zh-CN.md` and state that it is the source-mode Windows handoff guide for the target computer's already available Codex and the user's own Feishu application. Do not duplicate the guide or place credentials in the README.

### Task 3: Review and verify the documentation

**Files:**
- Review: `docs/windows-source-install-guide.zh-CN.md`, `README.md`

- [x] **Step 1: Check repository URLs and forbidden private material.**

  Run:

  ```powershell
  rg -n "feishu-codex-bridge|feishu-codex-Taskboard|FEISHU_APP_SECRET|CODEX_FEISHU_BRIDGE_SECRET|\.env\.local|%USERPROFILE%\\.codex|127\.0\.0\.1|drive\.file\.bitable_record_changed_v1" docs/windows-source-install-guide.zh-CN.md README.md
  ```

  Expected: all new clone/link commands use `feishu-codex-Taskboard`; secret names appear only in redacted or prohibition contexts; no real token, path, or secret is present.

  Also fail the review if the runbook contains command-scope `include.path`, direct npm calls that do not use the confirmed Node/npm CLI pair, root-script PATH that can resolve bare `npm` elsewhere, acceptance of inherited `CODEX_EXECUTABLE`, start blocks that can rediscover Codex or omit the confirmed `CODEX_HOME`, an enabled-workspace validator without fixed-drive and reparse-point checks, a phased first-run fixture, `replace-registry-host=always`, an install/test sequence without a final clean-worktree assertion, or a final execution check that selects the last run rather than a captured run ID.

- [x] **Step 2: Validate Markdown links and whitespace.**

  Run:

  ```powershell
  git diff --check
  git status --porcelain=v1 --untracked-files=all
  ```

  Review every relative link target and every PowerShell command against the existing scripts. Confirm that the guide does not promise automatic Base subscription, public networking, exact-once delivery, or a directly usable placeholder fixture.

- [x] **Step 3: Run the existing documentation-adjacent test gate.**

  Run:

  ```powershell
  & $confirmedNodeExecutable $confirmedNpmCli test
  ```

  Record the result without claiming success if the environment prevents a test from completing.

- [x] **Step 4: Commit the documentation change only when the user explicitly requests it.**

  Do not perform this step as part of documentation creation alone. With explicit user authorization, use:

  ```powershell
  git add README.md taskboard/README.md taskboard/README.zh-CN.md docs/windows-source-install-guide.zh-CN.md docs/superpowers/specs/2026-09-11-windows-source-onboarding-guide-design.md docs/superpowers/plans/2026-09-11-windows-source-onboarding-guide.md package.json package-lock.json taskboard/package.json taskboard/package-lock.json scripts/check-local.ps1 test/operations-hardening.test.mjs
  git commit -m "docs: add Windows source onboarding guide"
  ```
