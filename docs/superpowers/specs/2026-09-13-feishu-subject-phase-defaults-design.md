# Feishu Subject Phase Defaults Design

## Goal

Every Feishu table imported into Taskboard must open with the same complete
workflow configuration surface: field bindings, initial draft, first review,
final review, Auto-Cut routing, artifact handling, and upload settings. Each
table keeps its own values and metadata bindings.

## Behavior

- A newly discovered table is initialized as a draft with all three fixed
  stage keys (`initial`, `first_review`, `final_review`).
- The initial stage is enabled by default; review stages remain disabled until
  the operator selects valid status options.
- Status, document, naming, attachment, and option identifiers are derived
  only from that table's metadata snapshot. No subject may copy a field ID,
  option ID, path, or user value from another subject.
- Existing phased subjects are unchanged on metadata refresh.
- Existing legacy subjects are upgraded only when they still lack the phased
  fields; their existing trigger, execution, package, upload, and display
  settings remain intact.
- A legacy subject that is already `disabled` stays disabled during this
  upgrade; only an `enabled` subject is demoted to `draft` after a metadata
  refresh. Re-adding a previously removed subject likewise does not
  implicitly re-enable it.
- Missing or ambiguous metadata leaves a repairable draft with the full stage
  structure visible. Enable/save validation remains strict and blocks invalid
  bindings.
- The same initialization and migration behavior applies to every future Base
  or table imported through the existing catalog endpoint.

## Data Flow

`upsertBasePreview()` builds a per-subject phased draft from the table's
`metadata.fields` and persists it in that subject's `config_json`. The
`subjectKey` (`baseToken:tableId`) remains the isolation boundary. The existing
React editor consumes the persisted subject and its own metadata, so no global
template or cross-subject state is introduced.

## Compatibility and Safety

The migration is draft-only and does not enable a subject or change the
Bridge's active snapshot. Existing local artifact paths remain local. Strict
phase validation continues to run on save and enable, and all existing
loopback, package allow-list, and credential boundaries remain unchanged.

## Verification

Regression tests will cover new-table initialization, legacy-subject upgrade,
per-subject field isolation, and preservation of existing phased configuration.
The full repository test, Taskboard typecheck, web build, and component tests
must pass before completion.
