// Closed vocabulary only: never forward runtime text, paths, or provider data.
const PHASES = Object.freeze({
  input_prepare: "准备任务输入",
  environment_check: "检查执行环境",
  preflight: "运行预检",
  document_fetch: "读取文档",
  asset_download: "下载素材",
  input_compile: "整理剪辑输入",
  source_hash: "校验素材",
  source_asr: "识别源视频语音",
  classification: "分析剪辑内容",
  reverse_asr: "核对语音内容",
  draft_write_validate: "生成并校验剪映草稿",
  package_publish: "打包 ZIP",
  artifact_report: "校验并登记 ZIP",
});
const STATUSES = Object.freeze({
  running: "进行中", complete: "已完成", resumed: "已复用", failed: "失败", skipped: "已跳过", retrying: "重试中",
});

export function normalizeAutoCutProgress(value) {
  if (!value || typeof value.phase !== "string" || typeof value.status !== "string"
    || !Object.hasOwn(PHASES, value.phase) || !Object.hasOwn(STATUSES, value.status)) return null;
  const { phase, status } = value;
  return { phase, status, content: `${PHASES[phase]} · ${STATUSES[status]}` };
}
