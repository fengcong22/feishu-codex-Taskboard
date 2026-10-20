export interface AutoCutDiagnosticInput {
  errorCode?: string | null;
  failedPhase?: string | null;
  lastPhase?: string | null;
  executionKind?: "local" | "codex" | null;
}

type Guidance = { summary: string; checks: string[]; retryHint: string };

const PHASES: Record<string, { label: string; checks: string[] }> = {
  input_prepare: { label: "准备任务输入", checks: ["检查学科配置中的文档、命名及剪辑意见字段，并确认 PMO 当前记录已填写。"] },
  environment_check: { label: "检查执行环境", checks: ["检查 Auto-Cut 包部署，以及运行 Taskboard 的 Windows 账户能否访问飞书 CLI、登录信息和输出目录。"] },
  preflight: { label: "运行预检", checks: ["检查剪辑包部署校验、飞书 CLI 登录和本机输出目录读写权限。"] },
  document_fetch: { label: "读取文档", checks: ["检查 PMO 中配置的文档链接字段：链接是否完整，文档是否仍可打开。", "检查运行 Taskboard 的账户所用飞书 CLI 登录状态及该文档的访问权限；浏览器能打开不代表 CLI 有权限。", "检查飞书网络连接，以及文档是否符合剪辑包要求的章节和格式。"] },
  asset_download: { label: "下载素材", checks: ["检查文档中的素材链接是否有效、素材访问权限，以及网络和下载目录空间。"] },
  input_compile: { label: "整理剪辑输入", checks: ["检查文档中的切片或审核意见、时间段和素材引用是否符合剪辑包格式。"] },
  source_hash: { label: "校验素材", checks: ["检查下载的视频是否完整可播放、本机文件是否可读，以及磁盘空间。"] },
  source_asr: { label: "识别源视频语音", checks: ["检查源视频音轨、火山语音服务配置与额度，以及服务网络连接。"] },
  classification: { label: "分析剪辑内容", checks: ["检查剪辑意见格式、语音识别结果和剪辑包分析服务配置。"] },
  reverse_asr: { label: "核对语音内容", checks: ["检查语音服务连接与额度，并在剪辑包日志中核对音频处理结果。"] },
  draft_write_validate: { label: "生成并校验剪映草稿", checks: ["检查草稿输出目录是否可写、磁盘空间是否足够，以及剪辑包草稿校验结果。"] },
  package_publish: { label: "打包 ZIP", checks: ["检查 ZIP 输出目录是否可写、磁盘空间，以及文件是否被其他程序占用。"] },
  artifact_report: { label: "校验并登记 ZIP", checks: ["检查 Taskboard 本机服务是否正常，以及剪辑包生成的 ZIP 和结果回执是否通过校验。"] },
};

const FIX_THEN_RETRY = "处理上述问题后，再点击「按当前配置重新执行」。同一错误反复出现时，先查看本次日志。";
const GUIDANCE = new Map<string, Guidance>();
function register(codes: string[], summary: string, checks: string[], retryHint = FIX_THEN_RETRY) {
  for (const code of codes) GUIDANCE.set(code.toLowerCase(), { summary, checks, retryHint });
}
register(["AUTOCUT_LARK_IDENTITY_UNAVAILABLE"], "无法读取有效的飞书登录身份。", ["在运行 Taskboard 的 Windows 账户下检查飞书 CLI 登录状态及用户授权。"], "恢复登录或重新授权后，再重试本次任务。");
register(["AUTOCUT_LARK_CLI_UNAVAILABLE"], "无法访问剪辑包配置的飞书 CLI。", ["检查剪辑包部署中登记的飞书 CLI 是否存在，以及运行 Taskboard 的账户是否有执行权限。"]);
register(["AUTOCUT_READINESS_UNAVAILABLE"], "无法读写剪辑包的预检状态。", ["检查剪辑包运行状态目录的读写权限和磁盘空间；如配置了自定义目录，核对其路径。"]);
register(["AUTOCUT_OUTPUT_UNAVAILABLE"], "无法写入本机剪辑输出目录。", ["检查学科配置和剪辑包绑定的任务、草稿、ZIP 输出目录是否存在且可写，磁盘是否已满。"]);
register(["AUTOCUT_RUNTIME_UNAVAILABLE", "AUTOCUT_PROCESS_UNAVAILABLE"], "剪辑包运行环境或启动程序不可用。", ["在 Auto-Cut 包路由中检查工作区和包验证结果；在剪辑包工作区检查部署及 Python 运行环境。"]);
register(["AUTOCUT_ENVIRONMENT_UNAVAILABLE", "AUTOCUT_ENVIRONMENT_TIMEOUT", "AUTOCUT_PREFLIGHT_TIMEOUT"], "执行环境检查未通过或预检超时。", ["检查运行账户的飞书 CLI 登录、网络连接及预检和输出目录权限，再查看本次日志确认具体阻塞项。"]);
register(["AUTOCUT_TIMEOUT_INVALID"], "剪辑超时配置无效。", ["检查本机服务的 Auto-Cut 超时设置，应为正整数毫秒。"]);
register(["AUTOCUT_RUN_TIMEOUT"], "本次剪辑超过了执行时限。", ["查看最后记录的阶段，检查对应服务是否无响应，以及素材大小是否需要更长处理时间。"]);
register(["AUTOCUT_RUN_INTERRUPTED"], "本次剪辑被中断。", ["检查是否停止了任务、退出或重启了本机服务。"]);
register(["document_link_missing", "document_link_ambiguous"], "没有取得唯一有效的文档链接。", ["检查学科配置的文档字段，以及 PMO 当前记录是否提供了一个有效的剪辑文档链接。"]);
register(["docx_anchor_missing"], "未找到剪辑包要求的文档章节。", ["检查剪辑文档是否包含包要求的录屏目录、素材或意见章节，以及学科中的章节配置是否匹配。"]);
register(["source_pair_asr_integrity"], "源音频或语音对齐数据未通过完整性校验，剪辑已停止。", ["在剪辑包工作区查看本次 job_state.json 的 source_asr 错误，核对音频时间戳、音频覆盖范围及语音对齐结果。", "由剪辑包维护者区分素材缺失、时间戳精度问题和对齐结果异常；修复后保留音频完整性校验。"], "修复素材或剪辑包后再重试；输入和包未改变时，重复点击重试通常仍会受阻。");
register(["naming_value_missing", "naming_value_not_unique"], "命名字段为空或无法确定唯一名称。", ["检查 PMO 命名字段的文本或公式结果，并核对学科配置选择的命名字段。"]);
register(["FEISHU_BRIDGE_UNAVAILABLE", "FEISHU_BRIDGE_CONTEXT_FAILED"], "无法通过 Bridge 读取本次任务所需记录。", ["检查本机 Bridge 服务、飞书连接状态，以及应用对该多维表格的访问权限。"]);
register(["AUTOCUT_ARTIFACT_REPORT_FAILED", "AUTOCUT_ARTIFACT_REPORT_TIMEOUT", "AUTOCUT_ARTIFACT_REPORT_INVALID"], "剪辑产物未能在面板中完成登记。", ["检查 Taskboard 本机服务和产物校验日志；先核对 ZIP 是否已生成，避免手动重复上传。"]);
register(["autocut_result_missing"], "剪辑包没有提交本次运行的结果回执，尚不能确定具体失败原因。", ["打开本次日志，查看最后一条失败信息；缺少回执本身无法判断是素材、授权还是执行环境问题。", "若日志显示剪辑已经完成，请在剪辑包工作区检查结果回执的生成与上报。"]);
register(["autocut_result_invalid", "autocut_package_receipt_invalid", "autocut_package_receipt_missing", "autocut_artifact_missing", "AUTOCUT_RUN_BINDING_MISMATCH"], "本次产物或结果回执未通过校验。", ["在剪辑包工作区检查当前运行的结果回执、ZIP 与运行绑定是否一致，并查看对应校验错误。"], "修复剪辑包的结果输出或上报后重试；不要用上一轮产物替代本次结果。");

const GENERIC_CODES = new Set(["autocut_failed", "autocut_process_failed", "autocut_run_blocked"]);

/** Use closed code/phase dictionaries; never interpret or copy runtime error text. */
export function autoCutDiagnostic(input: AutoCutDiagnosticInput) {
  const code = input.errorCode?.toLowerCase() ?? "";
  const knownCode = GUIDANCE.has(code) || GENERIC_CODES.has(code);
  const failed = input.failedPhase && Object.hasOwn(PHASES, input.failedPhase) ? PHASES[input.failedPhase] : null;
  const last = input.lastPhase && Object.hasOwn(PHASES, input.lastPhase) ? PHASES[input.lastPhase] : null;
  const specific = GUIDANCE.get(code);
  return {
    code: knownCode ? input.errorCode! : "未记录可识别错误码",
    phase: failed ? `失败阶段：${failed.label}`
      : last ? `最后记录阶段：${last.label}（未确认失败位置）` : "失败阶段：未记录",
    execution: input.executionKind === "local" ? "本机 Auto-Cut 执行"
      : input.executionKind === "codex" ? "Codex 执行" : "执行方式未记录",
    summary: specific?.summary ?? (failed ? `${failed.label}阶段失败，具体原因尚未记录。` : "本次运行受阻，现有记录不足以确定具体原因。"),
    checks: specific?.checks ?? (failed ?? last)?.checks ?? ["打开本次日志，查看最后一条失败信息；若仍不明确，复制排查信息并交给维护人员定位。"],
    retryHint: specific?.retryHint ?? FIX_THEN_RETRY,
  };
}
