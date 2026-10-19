/** Package boards own their stage vocabulary independently of legacy subject views. */
export const PACKAGE_WORKFLOW_STAGES = Object.freeze({
  document_draft_zip: Object.freeze([
    "todo", "queued", "in_progress", "blocked", "in_review", "completed_editing",
    "upload_queue", "uploading", "uploaded",
  ]),
  vm_pmo_review_video: Object.freeze([
    "todo", "materials", "queued", "editing", "feishu_delivery", "awaiting_feishu_review",
    "nas_upload", "completed", "needs_attention",
  ]),
});
