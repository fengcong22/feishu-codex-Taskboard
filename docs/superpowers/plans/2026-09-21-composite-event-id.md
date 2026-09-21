# Composite Event ID Compatibility Repair

**Goal:** Allow Bridge-generated composite event IDs to reach Auto-Cut input preparation without changing event identity or existing task history.

**Design:** Keep schema v1 and the existing 256-character limit. Give `binding.event_id` a dedicated validator for nonempty alphanumeric/underscore/hyphen segments separated by colons. Keep all other ID validators unchanged. Retain the original event ID in manifests, runner environment, results, receipts and deduplication.

**Constraints:** No production events, credential changes, service restarts, database rewrites or deployed Auto-Cut package edits. Preserve `v1.1.0`; publish a new repair tag only after review and successful CI.

## Implementation

- [x] Add failing manifest tests for secondary-field, batched and fallback event IDs, stable hashes and invalid segments; retain strict checks for other IDs.
- [x] Add a Bridge normalization to run-input regression using real normalization and synthetic initial/review/final events.
- [x] Add an authenticated lifecycle regression covering original composite ID propagation through manifest, runner environment, result and receipt, including mismatched bindings.
- [x] Implement the dedicated event ID validator in `taskboard/server/feishu-source-manifest.mjs`.
- [x] Inspect installed Auto-Cut-Lite consumer validation read-only and verify compatible manifests without running editing tasks. Document any consumer upgrade requirement.
- [x] Update README and `taskboard/docs/auto-cut-lite-interface-requirements.md` with the event ID contract and upgrade/retry guidance.
- [x] Run focused regression tests and obtain independent review.
- [x] Run the full local verification gate and investigate any failures.
- [ ] Push and confirm the complete GitHub CI gate before merging/releasing `v1.1.1`.

## Validation

Focused: `node --test --test-concurrency=1 taskboard/test/feishu-source-manifest.test.mjs taskboard/test/feishu-run-inputs.test.mjs taskboard/test/feishu-autocut-run-lifecycle.test.mjs test/dual-status-field.test.mjs test/feishu-event.test.mjs`.

Acceptance: accepted composite IDs remain byte-for-byte equal throughout the run; malformed values and changed result/receipt identities fail; task/run IDs still cannot contain colons; no production data is used.

## Evidence

- Red: the new manifest and Bridge-to-input tests reproduced `binding.event_id is invalid`; all four composite lifecycle/retry cases returned HTTP 409 before the validator change.
- Green: 49 focused manifest/input/Bridge tests and all four composite lifecycle/retry cases passed after the change. The local runner environment capture preserves a multi-segment ID and overrides an inherited untrusted event ID.
- The local installed Lite runtime reports `VERSION` 1.7.0 and already permits colons. Five synthetic manifests (plain, secondary field, batch, fallback and length 256) were written only to a temporary directory and loaded by its actual `load_source_manifest` using the deployment-report Python with `-B`. All five preserved event identity and matched Taskboard's canonical SHA-256. Temporary files were removed; no editing workflow, external Feishu operation or deployed-file modification occurred. This does not attest to the other computer's Lite version.
- Independent review found no merge-blocking issues in the validator, identity propagation or regression coverage.
- Local `npm run test:ci` completed the Node suite with 1881 passing, 3 skipped and 1 failing test. The sole failure was `feishu-share-config.test.mjs` during fixture HTTP setup, with Fetch `bad port`; its isolated rerun passed. An earlier Wrangler migration `bad port` failure also passed in isolation (3/3) and in this full run. Both use OS-assigned ports; this machine's TCP dynamic range is 1024-15000, overlapping Fetch's prohibited ports. No production port or machine network setting was changed. This local gate is recorded as failed, not green.
- The remaining gate commands were run independently: TypeScript checking passed, web build passed, and all 151 component tests across 8 files passed. GitHub must run the complete gate successfully before merge and release.
