# Feishu project Codex workspace resolution

The project Codex panel must resolve the current Feishu subject's fixed package alias through the local package registry. Subject project IDs identify Base/table pairs and are not package project IDs. A null project workspace is expected for these subjects.

For local project-level requests without a task, find the non-removed subject belonging to a non-removed Base and the source-managed Feishu project. Use its saved `packageRoute` only when `routeMode` is `fixed` and the alias identifies an enabled local package. Missing aliases, missing/disabled/draft packages, and unavailable directories fail with controlled errors; do not fall back to a same-ID package or arbitrary project path. Subject draft/disabled lifecycle controls event intake, not manual project chat access.

Catalog, composer, thread creation, and subsequent turns already share `resolveAiChatContext`; the fix belongs there. Existing trusted task requests continue to resolve the server-owned package snapshot/alias. Ordinary tasks do not gain access to a subject's package from markers or labels. Project chat gains neither trusted Auto-Cut provenance nor automatic execution eligibility nor the task-only non-Git exception.

Use the saved current subject configuration for manual project chat, independent of the enabled event snapshot. Existing conversation workspace-change checks continue to reject a turn when the binding changes. No changes to local registries, credentials, Bridge state, listener settings, event processing, or ports are required.

Regression verification uses temporary databases, example subject metadata, a local stub Codex executable, and loopback ephemeral servers. Cover different subject/package IDs, catalog and conversation success, revalidation after package changes, source isolation, task snapshot preservation, and unchanged package deletion/restore behavior. Run the repository's standard tests and independent code review before delivery.
