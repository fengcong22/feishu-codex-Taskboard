/** Package boards own their stage vocabulary independently of legacy subject views. */
export const PACKAGE_WORKFLOW_STAGES = Object.freeze({
  document_draft_zip: Object.freeze([
    "todo", "queued", "in_progress", "blocked", "in_review", "completed_editing",
    "upload_queue", "uploading", "uploaded",
  ]),
  // Same task lifecycle as the Lite ZIP flow; only the package's editing differs.
  document_edit_zip: Object.freeze([
    "todo", "queued", "in_progress", "blocked", "in_review", "completed_editing",
    "upload_queue", "uploading", "uploaded",
  ]),
  vm_pmo_review_video: Object.freeze([
    "todo", "materials", "queued", "editing", "feishu_delivery", "awaiting_feishu_review",
    "nas_upload", "completed", "needs_attention",
  ]),
});
