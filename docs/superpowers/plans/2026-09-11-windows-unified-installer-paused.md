# Windows Unified Installer, Migration, and Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Paused by the user on 2026-09-11. This file is a retained implementation plan, not authorization to create branches, change code, build an installer, create a tag, publish a Release, or alter repository settings.

**Goal:** When work is resumed, deliver one unsigned Windows x64 current-user installer that contains the current Taskboard and Feishu Bridge functionality, preserves persistent data across upgrades, supports private cross-computer migration, and later provides user-confirmed signed updates with rollback.

**Architecture:** Extend the existing Codex Taskboard Tauri/NSIS application as the single installed application. Its native launcher owns two Node child processes—Taskboard on `127.0.0.1:47823` and Feishu Bridge on `127.0.0.1:47824`—while program files remain replaceable and persistent data remains under the current Windows user's application-data directories.

**Tech Stack:** Windows x64, Tauri 2, Rust 1.88, NSIS current-user installer, Node.js 22.23.2 runtime, JavaScript ES modules, React/Vite, SQLite, Windows DPAPI, GitHub Actions, GitHub Releases.

## Global Constraints

- Keep `v1.0.0` unchanged. Never move, overwrite, delete, or recreate it with different capitalization.
- Implement feature code only on `codex/` branches. Merge each reviewed phase into `main` before creating the next phase branch.
- Bind Taskboard and Bridge only to IPv4 loopback. Never expose either service to LAN or the public Internet.
- Bridge never starts Codex. The Tauri launcher may open Codex after both local services reach their expected state.
- Automatic execution remains off unless `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` is explicitly enabled.
- Only tasks registered through the Bridge-only authenticated Taskboard endpoint may qualify for automatic execution.
- Simulated events are always non-production and never qualify for automatic execution.
- Never put Feishu credentials, Bridge secrets, migration passwords, local registries, databases, runtime state, or private migration packages in Git or GitHub Releases.
- The generic installer does not contain external project workspaces such as `auto-cut-lite`. A private migration package may include a workspace only when the user explicitly selects it.
- Preserve Taskboard history, attachments, settings, Bridge deduplication state, retry queues, dead letters, workflow configuration, and package bindings during updates.
- Treat malformed configuration, state, credentials, or migration data as a fail-closed error. Never create an empty replacement over damaged data.
- Ordinary uninstall removes program files and keeps persistent user data. Permanent data deletion remains a separate, explicit operation.
- The source repository is public at `https://github.com/fengcong22/feishu-codex-Taskboard`; updater clients must not require a GitHub account or embedded access token.

## Current Baseline

- Remote `main` points to `c786e05743fa8a2239b261a0fcf269acd55aa020`.
- Public tag `v1.0.0` points to the same commit.
- No GitHub Release existed when this plan was paused.
- Taskboard already has a Windows Tauri/NSIS build command and bundles a verified Node runtime.
- The existing Windows installer packages Taskboard but not the root Feishu Bridge.
- Source-mode data currently lives under `.runtime`; installed Taskboard data already uses `%APPDATA%\Codex Taskboard`.
- No installer implementation code, installer branch, new release tag, or installer artifact was created during the planning session.

## Intended File Boundaries

When implementation resumes, keep responsibilities separated as follows:

- `src/installation/layout.mjs`: installed data-directory and file-layout contract.
- `src/installation/safe-file.mjs`: stable regular-file, link-count, containment, and atomic-replacement checks.
- `src/installation/backup.mjs`: Taskboard SQLite and Bridge state snapshots plus restore manifests.
- `src/installation/source-migration.mjs`: source-deployment discovery and same-computer migration transaction.
- `src/installation/migration-container.mjs`: versioned `scrypt` + AES-256-GCM private migration package.
- `src/installation/migration-cli.mjs`: newline-delimited stdin/stdout adapter used only by the native launcher.
- `taskboard/src-tauri/src/secure_store.rs`: Windows DPAPI current-user secret protection.
- `taskboard/src-tauri/src/service_manager.rs`: Taskboard/Bridge ordered start, health, restart, and stop.
- `taskboard/src-tauri/src/installation_commands.rs`: privileged Tauri commands for settings, backup, and migration.
- `taskboard/src-tauri/src/update_coordinator.rs`: update-state machine and handoff to an independent helper.
- `taskboard/web/src/components/DesktopSettings.tsx`: local Tauri settings and migration experience.
- `taskboard/scripts/prepare-tauri-app.mjs`: deterministic packaged-resource assembly.
- `taskboard/scripts/verify-windows-package.mjs`: installer-content, secret, path, and runtime checks.
- `.github/workflows/check.yml`: root Windows build verification.
- `.github/workflows/release-windows.yml`: reviewed tag-only Windows Release pipeline.

---

### Task 1: Resume Safely and Audit the Public Baseline

**Files:**
- Read: all tracked files and reachable Git history
- Modify only after review: `README.md`, `AGENTS.md`, root licensing files

**Interfaces:**
- Consumes: public repository state and `v1.0.0`.
- Produces: a clean, reviewed `main` baseline from which the first feature branch may be created.

- [ ] **Step 1: Verify remote identity, visibility, tag, and clean worktree.**

  ```powershell
  git fetch origin --prune --tags
  git status --short --branch
  git remote -v
  git rev-parse v1.0.0^{}
  git merge-base --is-ancestor v1.0.0 origin/main
  gh repo view fengcong22/feishu-codex-Taskboard --json visibility,url,defaultBranchRef
  ```

  Expected: visibility is `PUBLIC`, default branch is `main`, the tag resolves to `c786e05743fa8a2239b261a0fcf269acd55aa020`, and no credential/runtime file is tracked.

- [ ] **Step 2: Run a history-aware secret scan before adding release assets.**

  Use an approved scanner against all reachable commits and review only redacted finding metadata. Also list historical filenames matching `.env`, secrets, credentials, databases, `.runtime`, and local registries. Any real exposed credential must be revoked and rotated before continuing; deleting it from the latest tree is not sufficient.

- [ ] **Step 3: Confirm the public repository has an explicit root license and public-safe README.**

  The root license must cover the Bridge and clarify the bundled Taskboard license/notice. README examples must use placeholders, not real Base tokens, paths, project aliases, or credentials.

- [ ] **Step 4: Run the baseline verification gate.**

  ```powershell
  npm ci
  npm ci --prefix taskboard
  npm test
  git diff --check
  ```

  Expected: every command exits `0` before a feature branch is created.

---

### Task 2: Implement Persistent Layout, Secrets, Backups, and Migration

**Branch:** `codex/unified-persistence-migration`, created from the latest reviewed `main`.

**Files:**
- Create: `src/installation/layout.mjs`
- Create: `src/installation/safe-file.mjs`
- Create: `src/installation/backup.mjs`
- Create: `src/installation/source-migration.mjs`
- Create: `src/installation/migration-container.mjs`
- Create: `src/installation/migration-cli.mjs`
- Create: `test/installation-layout.test.mjs`
- Create: `test/installation-backup.test.mjs`
- Create: `test/source-migration.test.mjs`
- Create: `test/private-migration.test.mjs`
- Create: `taskboard/src-tauri/src/secure_store.rs`
- Modify: `taskboard/src-tauri/src/main.rs`
- Modify: `taskboard/src-tauri/Cargo.toml`
- Modify: `src/index.mjs`
- Modify: `README.md`
- Modify: `taskboard/README.md`
- Modify: `taskboard/README.zh-CN.md`
- Modify: `AGENTS.md`

**Interfaces:**
- `resolveInstalledLayout({ appData, localAppData })` returns immutable absolute paths for Taskboard, Bridge, secrets, backups, migration staging, and logs.
- `createBackup({ layout, reason, clock })` returns `{ backupId, root, manifestPath }` only after SQLite integrity, Bridge state, and per-file SHA-256 checks pass.
- `restoreBackup({ layout, backupRoot })` restores only a verified manifest created by `createBackup`.
- `inspectSourceDeployment(root)` returns a migration inventory without changing the source.
- `migrateSourceDeployment({ source, targetLayout, lifecycle })` performs copy, validation, and switch without deleting source data.
- `exportMigrationPackage({ layout, outputPath, password, selectedWorkspaces })` defaults `selectedWorkspaces` to an empty array.
- `importMigrationPackage({ inputPath, password, targetLayout, replaceExisting })` defaults `replaceExisting` to `false` and always disables real listening and effective automatic execution on the target.
- `protect_current_user` and `unprotect_current_user` in `secure_store.rs` use Windows DPAPI and never log plaintext.

- [ ] **Step 1: Write failing layout and stable-file tests.**

  Assert this Windows layout exactly:

  ```text
  %APPDATA%\Codex Taskboard\taskboard.sqlite
  %APPDATA%\Codex Taskboard\attachments\
  %APPDATA%\Codex Taskboard\artifacts\
  %APPDATA%\Codex Taskboard\Feishu Bridge\config\bridge.json
  %APPDATA%\Codex Taskboard\Feishu Bridge\config\packages.json
  %APPDATA%\Codex Taskboard\Feishu Bridge\state\events.json
  %APPDATA%\Codex Taskboard\Feishu Bridge\state\workflow.json
  %APPDATA%\Codex Taskboard\Feishu Bridge\secrets\feishu.dpapi
  %APPDATA%\Codex Taskboard\Feishu Bridge\secrets\bridge-secret.dpapi
  %LOCALAPPDATA%\Codex Taskboard\Logs\
  ```

  Reject relative paths, symlinks, hard-linked/multi-link state files, path traversal, directory targets where regular files are required, and targets outside the resolved application-data root.

- [ ] **Step 2: Run the focused tests RED, implement the layout boundary, then rerun GREEN.**

  ```powershell
  node --test test/installation-layout.test.mjs
  ```

- [ ] **Step 3: Add Windows DPAPI tests before implementation.**

  Test same-user round-trip, different entropy rejection, damaged ciphertext, atomic file replacement, restrictive current-user file placement, and redacted error text. On non-Windows targets, the module must compile and return a stable `UNSUPPORTED_PLATFORM` result.

  ```powershell
  cargo test --manifest-path taskboard/src-tauri/Cargo.toml secure_store
  ```

- [ ] **Step 4: Implement DPAPI using current-user scope.**

  Add the Windows API features required for `CryptProtectData`, `CryptUnprotectData`, and `LocalFree`. Do not use machine scope and do not persist plaintext `.env.local` files. Generate the Bridge secret from 32 cryptographically random bytes when it does not already exist.

- [ ] **Step 5: Write backup and restore failure-injection tests.**

  Cover SQLite `backup()` plus `PRAGMA integrity_check`, Bridge state under its existing OS-backed lock, manifest SHA-256, atomic destination replacement, interrupted staging cleanup, damaged source refusal, restore hash mismatch, and retention of `pending`, `retry_wait`, and `dead_letter` records.

  ```powershell
  node --test test/installation-backup.test.mjs test/state-lock.test.mjs test/state-store.test.mjs
  ```

- [ ] **Step 6: Implement backup/restore and source migration transactionally.**

  Migration must copy rather than move, create a timestamped pre-migration backup, leave the source untouched on every failure, refuse to merge two non-empty Taskboard databases, and write an idempotent completion marker only after both installed services pass validation.

- [ ] **Step 7: Write private migration package tests.**

  Lock the file format to magic `CFMIG01`, format version `1`, `scrypt` parameters `N=131072`, `r=8`, `p=1`, a 256-bit key, AES-256-GCM, random salt and nonce, and a minimum 12-character password. Test wrong passwords, tampered headers, ciphertext, authentication tags, manifests, hashes, version bounds, duplicate paths, absolute paths, `..` traversal, case-colliding Windows paths, symlinks, junctions, and non-empty target refusal.

  ```powershell
  node --test test/private-migration.test.mjs
  ```

- [ ] **Step 8: Implement export/import with safe defaults.**

  Always exclude process IDs, locks, logs, caches, temporary files, the Bridge secret, Codex login/profile data, and unselected project workspaces. For selected workspaces, exclude `.env*`, known credential files, `node_modules`, build caches, logs, and links escaping the workspace. On import, generate a new Bridge secret, re-protect Feishu credentials with target-user DPAPI, disable listening and effective automatic execution, and require local path rebinding before execution.

- [ ] **Step 9: Run the complete phase gate and request review.**

  ```powershell
  npm test
  cargo test --manifest-path taskboard/src-tauri/Cargo.toml
  git diff --check
  git status --short --branch
  ```

  Review must focus on credential lifetime, path containment, state-lock reuse, migration idempotency, rollback completeness, and absence of private data. Merge only after all blocking findings are resolved.

---

### Task 3: Build the Unified Windows Installer and Launcher

**Branch:** `codex/unified-windows-installer`, created only after Task 2 is reviewed and merged into `main`.

**Files:**
- Create: `taskboard/src-tauri/src/service_manager.rs`
- Create: `taskboard/src-tauri/src/installation_commands.rs`
- Create: `taskboard/web/src/desktopSettingsApi.ts`
- Create: `taskboard/web/src/components/DesktopSettings.tsx`
- Create: `taskboard/web/src/components/DesktopSettings.test.tsx`
- Create: `taskboard/src-tauri/windows/hooks.nsh`
- Create: `taskboard/scripts/verify-windows-package.mjs`
- Create: `taskboard/test/windows-unified-package.test.mjs`
- Modify: `taskboard/scripts/prepare-tauri-app.mjs`
- Modify: `taskboard/src-tauri/src/main.rs`
- Modify: `taskboard/src-tauri/tauri.conf.json`
- Modify: `taskboard/src-tauri/tauri.windows.conf.json`
- Modify: `taskboard/src-tauri/capabilities/default.json`
- Modify: `taskboard/web/vite.config.ts`
- Modify: `taskboard/package.json`
- Modify: `.github/workflows/check.yml`
- Modify: `README.md`
- Modify: `taskboard/README.md`
- Modify: `taskboard/README.zh-CN.md`
- Modify: `taskboard/docs/windows-uninstall.md`
- Modify: `AGENTS.md`

**Interfaces:**
- `ServiceManager::start_all` validates resources, starts Taskboard, waits for its authenticated health response, starts Bridge, waits for `/health`, then opens the Taskboard/Codex surface.
- `ServiceManager::stop_all` stops Bridge before Taskboard and terminates only identity-matching children.
- `ServiceSnapshot` exposes Taskboard, Bridge, listener, queue, setup, and degraded-state information without secrets.
- Tauri settings commands use local IPC; credentials never pass through the loopback HTTP service or browser storage.
- `verify-windows-package.mjs <setup.exe>` returns exit `0` only when required resources exist and forbidden private files/strings are absent.

- [ ] **Step 1: Add failing deterministic-resource tests.**

  Require packaged Node, Taskboard server/frontend/shared modules, Bridge `src`, the complete production dependency tree for `@larksuiteoapi/node-sdk`, migration helpers, offline Chinese documents, licenses, and a resource manifest. Explicitly reject `.env.local`, `config/bridge.local.json`, `config/taskboard-feishu-packages.json`, `.runtime`, SQLite files, local absolute business paths, tokens, Bridge secrets, and external workspaces such as `auto-cut-lite`.

- [ ] **Step 2: Extend `prepare-tauri-app.mjs` and verify the staged resources.**

  Keep Node version `22.23.2` and its pinned Windows x64 archive SHA-256. Copy only allowlisted directories and production modules; do not copy either repository wholesale.

  ```powershell
  npm --prefix taskboard run app:prepare -- --target x86_64-pc-windows-msvc
  node --test taskboard/test/windows-unified-package.test.mjs
  ```

- [ ] **Step 3: Write service-order and identity tests RED.**

  Assert `Taskboard start → Taskboard health → Bridge start → Bridge health → open UI`, and `block new Bridge work → Bridge stop → Taskboard stop`. Test Taskboard start failure, Bridge degraded mode, reused ports, stale PID records, process replacement, repeated launch, user exit, and shared non-empty per-machine Bridge secret. Assert both URLs remain exactly on `127.0.0.1` and that simulated events never receive automatic-execution eligibility.

- [ ] **Step 4: Extract and implement `service_manager.rs`.**

  Preserve the existing launcher's process-identity protections and single-instance lock. A second click must activate the existing instance. Taskboard may remain running when Bridge fails, but the tray/settings status must say Bridge is unavailable. The Bridge environment receives fixed configuration paths and the same DPAPI-protected secret as Taskboard; it never receives a path or command from a Feishu cell.

- [ ] **Step 5: Write the first-run/settings component tests RED.**

  Cover three first-run choices—same-computer source migration, encrypted migration-package import, and fresh setup—plus masked Feishu credential entry, listener status, queue counts, package path rebinding, explicit automatic-execution consent, backup/restore, logs/docs links, autostart default off, and disabled execution when Codex is missing.

- [ ] **Step 6: Implement the local Tauri settings window.**

  Build the settings page as a packaged local WebView and call privileged native commands through Tauri IPC. Never write credential values to `localStorage`, Taskboard HTTP requests, command-line arguments, logs, or task descriptions. First launch opens settings; later launches open Taskboard unless configuration health requires attention.

- [ ] **Step 7: Add current-user shortcuts and uninstall retention.**

  Configure NSIS `installMode: "currentUser"`. Create a Start menu entry, create a desktop shortcut by default, provide an install-complete “launch now” action, and remove shortcuts during uninstall. Do not force taskbar pinning. Uninstall removes program files while retaining `%APPDATA%\Codex Taskboard`, `%LOCALAPPDATA%\Codex Taskboard\Logs`, and the installed Taskboard Skill.

- [ ] **Step 8: Build and inspect the unsigned installer.**

  ```powershell
  npm --prefix taskboard run app:build:windows
  node taskboard/scripts/verify-windows-package.mjs taskboard/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
  ```

  Expected: one unsigned Windows x64 current-user `setup.exe`; verification confirms bundled services, Node, docs, shortcuts, and absence of private content.

- [ ] **Step 9: Extend root Windows CI and run a clean-machine matrix.**

  CI must install both lockfiles, run root `npm test`, build the real unsigned NSIS package, verify it, and upload it as a non-Release artifact. Test a clean Windows x64 VM with Codex installed but without Node, npm, Rust, or source; test fresh setup, same-machine migration, encrypted cross-user import, restart, ordinary uninstall, and reinstall with retained data.

- [ ] **Step 10: Run the full phase gate and request review.**

  ```powershell
  npm test
  npm --prefix taskboard run typecheck
  npm --prefix taskboard run build:web
  cargo test --manifest-path taskboard/src-tauri/Cargo.toml
  git diff --check
  ```

  After automated checks, use the harmless example and a designated Feishu test table. Do not repeatedly mutate a production record. Merge only after review and recorded clean-machine evidence.

---

### Task 4: Add Signed, User-Confirmed Updates and Rollback

**Branch:** `codex/safe-windows-updater`, created only after Task 3 is reviewed and merged into `main`.

**Files:**
- Create: `taskboard/src-tauri/src/update_coordinator.rs`
- Create: `taskboard/src-tauri/src/bin/codex-taskboard-update-helper.rs`
- Create: `taskboard/test/windows-update-policy.test.mjs`
- Create: `taskboard/test/windows-update-assets.test.mjs`
- Create: `taskboard/scripts/sync-release-version.mjs`
- Create: `taskboard/scripts/create-windows-update-metadata.mjs`
- Create: `taskboard/scripts/verify-windows-release.mjs`
- Create: `.github/workflows/release-windows.yml`
- Create: `CHANGELOG.md`
- Create: `docs/windows-installation.zh-CN.md`
- Create: `docs/windows-migration.zh-CN.md`
- Create: `docs/windows-update-and-recovery.zh-CN.md`
- Modify: `package.json`
- Modify: `taskboard/package.json`
- Modify: `taskboard/src-tauri/Cargo.toml`
- Modify: `taskboard/src-tauri/tauri.conf.json`
- Modify: `taskboard/src-tauri/tauri.windows.conf.json`
- Modify: `taskboard/src-tauri/src/main.rs`
- Modify: `taskboard/web/src/components/DesktopSettings.tsx`
- Modify: `README.md`
- Modify: `taskboard/README.md`
- Modify: `taskboard/README.zh-CN.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Stable clients read `https://github.com/fengcong22/feishu-codex-Taskboard/releases/latest/download/latest.json`.
- Beta clients use a separate public beta metadata endpoint selected only after explicit opt-in.
- `UpdateCoordinator::prepare` downloads into staging, verifies channel, semantic version, Tauri update signature, and SHA-256, checks maintenance blockers, then creates a data/program recovery point.
- The independent update helper waits for the application to exit, replaces program files, starts the new version, validates a one-time health marker, and restores the previous program/data snapshot when validation fails.

- [ ] **Step 1: Create a dedicated updater signing key under owner control.**

  Generate the Tauri updater key pair in an approved offline or protected environment. Commit only the public key. Store the private key and its password as protected GitHub Actions secrets, never as repository files, artifacts, logs, command-line output, or application resources. This updater signature is required even while the NSIS installer remains Authenticode-unsigned.

- [ ] **Step 2: Write channel, version, signature, and hash tests RED.**

  Accept stable releases only on the default channel. Accept `v1.2.0-beta.N` only after beta opt-in. Reject downgrades, equal versions, malformed metadata, wrong repository URLs, missing signatures, signature mismatch, hash mismatch, platform mismatch, and stable/beta channel crossover.

- [ ] **Step 3: Implement staged update preparation.**

  Never install during an active Auto-Cut run, upload, database migration, migration export/import, backup, or restore. Do not force-stop work. Download only after a user click, verify before stopping services, then stop Bridge before Taskboard and create the recovery point.

- [ ] **Step 4: Write helper failure-injection tests before program replacement.**

  Inject failures after download, service stop, backup, program copy, schema migration, Taskboard start, Bridge start, and health validation. Every case must either leave the old version running unchanged or restore the last known-good program and data. If rollback itself fails, leave services stopped, effective automatic execution off, and emit a stable redacted recovery code.

- [ ] **Step 5: Implement the independent update helper.**

  Pass only validated absolute paths and random one-time tokens. Never pass secrets or unresolved environment variables. Validate helper executable identity, parent version, target version, staging hashes, install root containment, and recovery manifest before replacement. Keep one last known-good version and one pre-update data snapshot.

- [ ] **Step 6: Make the root package version authoritative.**

  `scripts/sync-release-version.mjs` must read the root `package.json` version and synchronize `taskboard/package.json`, `taskboard/src-tauri/Cargo.toml`, and `taskboard/src-tauri/tauri.conf.json`. The release preflight rejects any mismatch between root version, component manifests, tag, metadata, installer filename, and updater payload.

- [ ] **Step 7: Build a tag-only public Release workflow.**

  Accept only a new reviewed tag contained in `main`. Reject tag deletion, forced movement, dirty/manual source substitution, missing update secrets, or a pre-existing Release. Build on GitHub-hosted Windows x64, run all tests, generate the unsigned NSIS installer and signed updater asset, produce `latest.json`, signatures, `SHA256SUMS`, Chinese documentation, changelog, and third-party notices, scan assets for secrets/private data, then create a draft Release for owner review before publication.

- [ ] **Step 8: Rehearse beta-to-beta, beta-to-stable, and rollback paths.**

  On disposable Windows users or VMs, compare task counts, task identities, attachments, workflow state, package registry, pending/retry/dead-letter counts, listener mode, and automatic-execution policy before and after each transition. Record hashes and test results without recording secrets or full sensitive paths.

- [ ] **Step 9: Run the final verification gate.**

  ```powershell
  npm test
  npm --prefix taskboard run typecheck
  npm --prefix taskboard run build:web
  cargo test --manifest-path taskboard/src-tauri/Cargo.toml
  npm --prefix taskboard run app:build:windows
  git diff --check
  git status --short --branch
  ```

- [ ] **Step 10: Stop for explicit release authorization.**

  Do not create `v1.2.0-beta.1`, push a tag, or publish a Release as an implicit implementation step. Present the exact reviewed `main` commit, clean verification evidence, installer filename, updater filename, signatures, and SHA-256 values. Create and push `v1.2.0-beta.1` only after the user gives a separate explicit release instruction.

---

## Resume Order

1. Re-open this plan and confirm its constraints still match the repository.
2. Complete Task 1 and resolve every public-history or licensing issue.
3. Create and complete `codex/unified-persistence-migration`; review and merge.
4. Create and complete `codex/unified-windows-installer`; review and merge.
5. Produce an internal unsigned installer artifact for clean-machine testing.
6. Create and complete `codex/safe-windows-updater`; review and merge.
7. Obtain explicit authorization before creating `v1.2.0-beta.1` or publishing a Release.

## Completion Criteria

- One installer works on Windows x64 without system Node, npm, Rust, or a source checkout.
- The installed user has Start menu and desktop launch entries; repeated launch activates one instance.
- Taskboard and Bridge start and stop in the required order and listen only on `127.0.0.1`.
- Current Taskboard and Bridge business functionality is present; external packages remain separately controlled and allowlisted.
- Same-computer migration, encrypted cross-computer migration, reinstall, update, and rollback preserve verified persistent data.
- Credentials use current-user DPAPI and never enter Git, logs, HTTP, or browser storage.
- Updates require user confirmation and a valid application-level signature; failed updates demonstrably restore the last known-good state.
- README, `AGENTS.md`, Chinese offline guides, changelog, notices, and Release assets agree with actual behavior.
- Every implementation branch passes automated tests, clean Windows validation, harmless simulation, designated Feishu test-table validation, and code review before merge.
