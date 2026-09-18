# Custom ZIP Generation Directory Implementation Plan

**Goal:** Implement the user-approved choice between the package default ZIP directory and a custom local directory, without changing Auto-Cut-Lite's exact-file protocol or historical task bindings.

**Architecture:** Persist optional `zipOutputMode` (`package_default` or `custom`) alongside the resolved `zipSourceDirectory`. Legacy records without a mode retain their saved path. New packages prefer a manifest default after inspection. Custom mode retains its path during repeated inspection, and validates an existing writable absolute directory before save/enable. Default preparation keeps its manifest-only, save/enable-only creation behavior.

**Tech Stack:** Node filesystem APIs, local Taskboard HTTP API, React/TypeScript, Node test runner and Vitest.

## Constraints

- The previously approved design is sufficient authorization to implement; no new workflow or Lite deployment is included.
- Lite 1.6.15 already honors `CODEX_AUTOCUT_PACKAGE_ZIP_PATH`; read its deployed contract/code only.
- Custom mode accepts an existing accessible directory on this machine, including mapped storage accessible to the service account. It does not create arbitrary custom paths.
- `POST /api/local/autocut/packages/validate-output-directory` accepts `{ directory }`, returns `{ directory }`, validates absolute path, directory existence and write access without mutation. Invalid or unavailable input returns the stable `PACKAGE_CUSTOM_ZIP_OUTPUT_INVALID` error.
- Persist the mode only upon explicit save. Legacy records omit it; loading or upgrading cannot rewrite paths, aliases, project IDs, task snapshots or real registry files.
- Existing runs continue using their frozen package/subject roots; new runs must accept the configured custom root without substituting current live configuration.

## Tasks

- [x] Server: add failing tests for valid/invalid optional mode, persisted selection, frozen snapshots, custom paths outside workspace, missing/file/relative paths and read-only validation. Implement the optional field in package API/store, validate custom paths on save/enable and expose the validation endpoint.
- [x] UI: add tests for custom/default switching, custom values surviving inspection and reload, validation before save/enable, returning to default after fresh inspection, timeout/failure/stale response handling and legacy paths. Add the selector, helper text, persisted mode, bounded validation API and resolved path preview. Preserve existing history and manual fallback for old packages.
- [x] Integration: inspect exact runtime root checks, add a custom-root regression and change Taskboard checks only if its immutable package root is currently rejected by an older subject root.
- [x] Documentation: explain mode behavior and custom directory validation in README and the Lite contract; no new Lite protocol fields.
- [ ] Verify: run focused server/config/runtime tests, frontend tests and typecheck. Review changes. Build/restart the local stack preserving its listener setting only if no executions/uploads are active. Verify live inspection and unchanged registry hash.

## Verification commands

```powershell
node --test taskboard/test/feishu-package-api.test.mjs taskboard/test/feishu-package-output.test.mjs taskboard/test/feishu-package-config.test.mjs
npm --prefix taskboard run typecheck
npm --prefix taskboard run test:components
git diff --check
```
