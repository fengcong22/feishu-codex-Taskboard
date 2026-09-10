# Auto-Cut Lite 接口需求与交付合同

> 这是一份可以直接复制给另一台电脑上的 Auto-Cut Lite 源码开发任务的完整文档。请把本文件原样交给开发任务，并在开发完成后把本文要求的交付目录、链接和报告原样交回 Taskboard 维护任务复核。

## 0. 给源码开发任务的直接说明（请先阅读）

请先确认当前目录是带 `.git` 的真实 Auto-Cut Lite 源码仓库，而不是安装目录，并报告 Git remote 仓库地址；无法确认时请停止，不要修改。确认后新建一个独立分支，实现本文所有标记为 `REQUIRED` 的内容，并保持 `CURRENT` 契约兼容。请勿把变更直接安装、覆盖或部署到用户当前生产电脑；只在源码仓库中开发、测试并构建候选包。不要索要或记录 GitHub 密码、Personal Access Token 或飞书凭据。

完成后必须一次性交付以下内容：

1. 新分支名称和完整的 Git commit SHA（不是缩写 SHA）。
2. 如果当前环境有 GitHub 推送权限，先推送分支并提供分支链接；如按团队流程创建了 Pull Request，再同时提供 PR 链接。没有权限时也必须提供本地分支和完整 SHA，并明确写出“尚未推送 GitHub”。Git commit 是源码仓库的版本记录，不等于已经推送 GitHub，也不等于已经部署。
3. 从该提交构建的、可部署但尚未安装到当前生产电脑的候选包，使用包含版本号的清晰文件名。
4. 候选包的 SHA-256（小写、64 个十六进制字符）。
5. 一份中文 Markdown 测试报告：逐项列出本文验收矩阵、执行命令、实际通过/失败结果和仍存在的限制，不能只写“已完成”。
6. 一页中文交付说明：汇总分支、commit、GitHub 分支/PR（如有）、候选包位置、SHA-256、测试报告位置和部署前提。

推荐交付目录如下（名称可增加版本号，但结构要清楚）：

```text
autocut-lite-delivery-<version>/
├─ candidate/<versioned-package>
├─ candidate/<versioned-package>.sha256
├─ test-report.zh-CN.md
└─ delivery-note.zh-CN.md
```

源码本身保留在源码仓库，不必重复塞入候选包。用户只需把本文件交给源码开发任务，完成后把上述目录和源码定位原样交回；用户不需要自行分析日志或判断是否可以部署。

## 1. 文档身份与状态标记

- 文档版本：`1.1`。
- 更新日期：`2026-09-11`。
- Taskboard 基线分支：`codex/dashboard-feature`；已批准实施计划基线为完整 commit `8fab8a7d17178bc4e02c159709683ed64f03bc68`。当前功能、跨端校验和合同文本的权威实现基线，统一以本文件所在的最终 Git commit 为准，避免后续修订引用过期提交。
- Taskboard 负责的接口生产者：`taskboard/server/autocut-local-runner.mjs`、`feishu-source-manifest.mjs`、`feishu-run-inputs.mjs`、`app.mjs`、`artifact-service.mjs`、`cli/taskctl.mjs` 和 `shared/codex-environment.mjs`。
- Auto-Cut Lite 兼容基线：只读核对的源码完整 commit 为 `c950e82bfa1c955f2081e73c5a34cb825f9a2053`，本机已部署包版本为 `1.6.7+codex.20260908133808`，其 `PACKAGE-MANIFEST.json` SHA-256 为 `2bf1d8f766475b2a66faf6d6223f8c7006b397e160cdc04c51c73b34faa13f1c`。该核对未修改、构建或部署 Auto-Cut Lite；本文件描述的 `review-document-run`、Lite ZIP、结果回执和运行时发现契约以此作为 `CURRENT` 兼容参照。

每条要求都使用以下标记：

- `CURRENT`：Taskboard 当前已提供且升级不得破坏的契约。
- `REQUIRED`：本次 Auto-Cut Lite 源码版本必须新增或调整的行为。
- `OUT OF SCOPE`：本次不实现；不得以“顺便处理”为由扩大范围。

## 2. 范围和固定阶段

### 2.1 三个阶段

`CURRENT`：Taskboard 对每个学科维护三个彼此独立的固定阶段：

| 阶段 ID | 中文名称 | 运行绑定字段 |
| --- | --- | --- |
| `initial` | 初稿 | `binding.stage_id = "initial"` |
| `first_review` | 初审修改 | `binding.stage_id = "first_review"` |
| `final_review` | 终审修改 | `binding.stage_id = "final_review"` |

三个阶段拥有各自的视频来源、剪辑意见目录、音频来源、时长误差、名称后缀和 ZIP 目标；阶段配置、运行清单和结果不得互相串用。Taskboard 只在状态字段从其他选项进入已启用阶段目标选项时登记任务；不补执行阶段关闭期间错过的记录。

### 2.2 音频来源

`CURRENT`：面板使用一个“音频来源”下拉菜单和一个公用详情入口；三种选择映射到现有两个 wire-level mode，不新增第三种 manifest mode：

| 面板选择 | manifest 音频值 | 详情控件 | 时长误差 |
| --- | --- | --- | --- |
| 视频原音 | `{ "mode": "video_original" }` | 显示但置灰 | 显示但置灰 |
| 文档目录 | `replace_original` + `docx_section` | “音频目录标题”文本 | 正数，默认 `3` 秒 |
| Base 字段附件 | `replace_original` + `base_attachment` | “音频附件字段”下拉 | 正数，默认 `3` 秒 |

文档目录标题和附件字段只在当前阶段当前学科的未保存编辑缓存中保留；保存时只持久化当前选择。三个阶段配置独立。音频附件字段只列出当前 Base 当前学科表中类型为附件的字段；没有附件字段时选项必须置灰并说明“无可用字段”。元数据刷新后失效字段必须在保存/启用时拒绝（`FIELD_NOT_FOUND` 或 `FIELD_TYPE_INVALID`），不能静默选择其他字段。

`CURRENT`：Auto-Cut Lite 当前必须执行并在升级后继续保持以下 wire 行为：

- `video_original`：保留每个视频自己的原音，不读取或猜测外部音频。
- `replace_original` + `docx_section`：按文档目录读取外部音频，静音视频原音并按正数 `duration_tolerance_seconds` 对齐。
- `replace_original` + `base_attachment`：按指定附件字段读取唯一音频附件，静音视频原音并按同一时长容差对齐。
- 外部来源缺失、附件不唯一、下载失败、无法识别媒体类型或时长超过容差时，返回阻塞结果，不回退到视频原音或另一个来源。

## 3. 两条执行路径

### 3.1 现有 Codex/driver_report 路径（`CURRENT`）

1. Taskboard/Bridge 创建并冻结受信任的飞书任务和阶段版本。
2. Taskboard 为一次 run 写入唯一的 `source-manifest.json`、`execution_input.json`、结果路径和预期 ZIP 路径。
3. Auto-Cut Lite（由现有 Codex 执行上下文启动）读取清单、运行剪辑和 ZIP 验收。
4. Auto-Cut Lite 只对清单指定的本次 ZIP 执行：

   ```text
   taskctl artifact report --file <验收通过 ZIP 的绝对路径>
   ```

5. Taskboard 通过 run 专属 loopback capability 验证路径、哈希、manifest、receipt、ZIP 结构和绑定后才登记产物。

### 3.2 受授权的 Taskboard 本机 runtime 路径（`CURRENT`；编号兼容为 `REQUIRED`）

只有服务端登记、已阻塞、分阶段的受信任任务，且用户通过专用重试接口提供两个字面量 `true` 的授权项时，Taskboard 才可直接启动本机已登记 runtime；普通任务、描述标记、标签、legacy 任务和未登记任务不能走该路径。Taskboard 会先校验 `deployment-report.json`，然后只启动一次固定命令。runtime 退出后，Taskboard 对绑定的准确 ZIP 计算 SHA-256，并调用同一 run 的 artifact-report 路由；不得扫描目录或选择“最新 ZIP”。

## 4. 安装发现与固定命令

### 4.1 deployment-report.json（`CURRENT`）

Taskboard 在本机应用数据目录下读取：

```text
<LOCALAPPDATA>/Auto-Cut/auto-cut-lite/deployment-report.json
```

至少需要以下结构（值必须是当前机器上的绝对路径；示例值只是占位符）：

```json
{
  "deployment_status": "installed",
  "workspace_root": "<absolute-registered-workspace>",
  "runtime_root": "<absolute-runtime-root>",
  "components": {
    "python": {
      "runtime_path": "<absolute-python-runtime>"
    }
  }
}
```

Taskboard 要求 `deployment_status` 为 `installed`、`workspace_root` 与已登记包的工作区一致、`runtime_root` 和 Python 路径为绝对路径，并能解析出 `<runtime_root>/scripts/jy_wrapper.py`。任一条件不满足都以 `AUTOCUT_RUNTIME_UNAVAILABLE` 阻塞。

### 4.2 review-document-run（`CURRENT`）

固定调用形态如下；路径由 Taskboard 注入，源码不得改为目录扫描或自行拼接候选路径：

```powershell
<python-runtime> <runtime-root>\\scripts\\jy_wrapper.py `
  review-document-run `
  --source-manifest <job-root>\\source-manifest.json `
  --execution-input <job-root>\\execution_input.json `
  --job-root <job-root> `
  --drafts-root <drafts-root> `
  --package-zip <exact-package-zip-path> `
  --result-path <job-root>\\result.json `
  --json
```

进程工作目录是 runtime root，标准输出/错误由 Taskboard 收集；非零退出码转换为稳定的 `autocut_process_failed`。保留旧的 `--execution-input` 命名输入；本流程使用 `--source-manifest`，不得用旧 `--doc-url` 入口猜测整篇文档素材。

## 5. 环境变量和环境隔离

以下是本流程允许出现的全部 `CODEX_AUTOCUT_*` 变量。路径、ID 和 digest 由 Taskboard 服务器生成，不能由飞书单元格、普通任务描述或用户 prompt 覆盖。

| 变量 | 注入内容/用途 | 约束 |
| --- | --- | --- |
| `CODEX_AUTOCUT_SOURCE_MANIFEST_PATH` | 本次 run 的 manifest 绝对路径 | 只读、run 专属 |
| `CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256` | manifest canonical SHA-256 | 小写 64 hex |
| `CODEX_AUTOCUT_EXECUTION_INPUT_PATH` | 命名输入绝对路径 | 只读、run 专属 |
| `CODEX_AUTOCUT_JOB_ROOT` | manifest 所在 job 根目录 | 只允许本次 run |
| `CODEX_AUTOCUT_DRAFTS_ROOT` | 受控草稿根目录 | 只允许写入该根 |
| `CODEX_AUTOCUT_RESULT_PATH` | `result.json` 绝对路径 | 必须精确写入 |
| `CODEX_AUTOCUT_PACKAGE_ZIP_PATH` | 预期 ZIP 绝对路径 | 必须精确写入 |
| `CODEX_AUTOCUT_TASK_ID` | Taskboard task ID | 绑定校验 |
| `CODEX_AUTOCUT_RUN_ID` | 本次 run ID | 绑定校验 |
| `CODEX_AUTOCUT_SUBJECT_KEY` | `baseToken:tableId` | 绑定校验 |
| `CODEX_AUTOCUT_CONFIG_VERSION` | 正整数配置版本 | 绑定校验 |
| `CODEX_AUTOCUT_STAGE_ID` | `initial` / `first_review` / `final_review` | 绑定校验 |
| `CODEX_AUTOCUT_EVENT_ID` | 触发事件 ID | 绑定校验 |
| `CODEX_AUTOCUT_ARTIFACT_REPORT_URL` | 本次 run 的 loopback POST URL | 只能是 HTTP loopback |
| `CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN` | 短期 Bearer capability | 只发给本次 run |

`CURRENT`：Taskboard 创建服务时先从基础环境清除上表全部 `CODEX_AUTOCUT_*` 名称，创建本机 runtime 子进程时再额外清除任何大小写不敏感、以 `CODEX_AUTOCUT_` 开头的继承变量，然后只注入该执行路径需要的上表值。两个路径都会清理 `CODEX_TASKBOARD_*`、`CODEX_FEISHU_BRIDGE_SECRET`、`FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 等 Taskboard/Bridge 凭据。Auto-Cut Lite 不得要求把用户凭据写入 manifest、prompt、任务描述、receipt 或普通日志。`CODEX_AUTOCUT_ARTIFACT_REPORT_URL` 必须是 `http://127.0.0.1/...`、`localhost` 或 `[::1]` 的 loopback URL；报告使用 `Authorization: Bearer <token>` 和 `x-taskboard-client: taskctl`。在 Taskboard 直接启动 runtime 的路径里，报告 URL/token 由 Taskboard 自己使用，不传给 Auto-Cut Lite 子进程；在现有 Codex/driver_report 路径里则注入给当前 run 使用。

## 6. source-manifest.json schema v1

### 6.1 完整示例（`CURRENT`）

下例所有值均为占位符，不得把真实 token、凭据或业务绝对路径复制进共享文档：

```json
{
  "schema_version": 1,
  "binding": {
    "task_id": "FEI-10",
    "run_id": "run_001",
    "subject_key": "base_opaque:tbl_opaque",
    "config_version": 12,
    "stage_id": "initial",
    "event_id": "event_opaque"
  },
  "record": {
    "base_token": "base_opaque",
    "table_id": "tbl_opaque",
    "record_id": "rec_opaque"
  },
  "document": {
    "field_id": "fld_document",
    "url": "https://example.feishu.cn/docx/doc_opaque"
  },
  "sources": {
    "video": {
      "kind": "docx_section",
      "anchor_text": "视频目录"
    },
    "review": {
      "kind": "docx_section",
      "anchor_text": "剪辑意见"
    },
    "audio": {
      "mode": "replace_original",
      "duration_tolerance_seconds": 3,
      "source": {
        "kind": "base_attachment",
        "base_token": "base_opaque",
        "table_id": "tbl_opaque",
        "record_id": "rec_opaque",
        "field_id": "fld_audio"
      }
    }
  }
}
```

视频原音的 `sources.audio` 只允许：

```json
{ "mode": "video_original" }
```

文档目录音频的 `source` 为：

```json
{
  "kind": "docx_section",
  "anchor_text": "二、PPT草稿+翻录"
}
```

### 6.2 字段和规范化规则

`CURRENT`：

- 顶层只允许 `schema_version`、`binding`、`record`、`document`、`sources`；未知字段拒绝。
- `schema_version` 固定为 `1`。
- `binding` 只允许 `task_id`、`run_id`、`subject_key`、`config_version`、`stage_id`、`event_id`。除 `subject_key` 外的 ID 为非空、最长 256 字符的安全标识；`subject_key` 去首尾空格后必须非空、最长 513 字符且包含 `:`；`config_version` 为正安全整数；`stage_id` 必须是三个固定阶段之一。
- `record` 只允许 `base_token`、`table_id`、`record_id`，并与 `binding.subject_key` 和服务器任务身份一致。
- `document` 只允许 `field_id` 和 `url`。URL 必须是无用户名/密码/查询/片段的官方 HTTPS 飞书 `/docx/{token}` 或 `/wiki/{token}` URL；必须恰好解析到一个可读文档链接。
- `sources.video` 支持 `docx_section` 或 `base_attachment`；`sources.review` 只支持 `docx_section`；`sources.audio` 支持 `video_original`，或带 `docx_section`/`base_attachment` 的 `replace_original`。
- `docx_section.anchor_text` 去首尾空格后非空、最长 512 字符；Base 标识是 opaque ID，不是路径。
- `duration_tolerance_seconds` 必须是有限正数；缺省为 `3`；视频原音模式不输出该字段，也不输出 `source`。
- 禁止 shell、command、prompt、credential、password、executable、local/output path 等可执行或凭据字段；禁止把单元格文本当作路径或命令。

### 6.3 canonical JSON 和 SHA-256

`CURRENT`：Taskboard 将规范化 manifest 的对象键按 JavaScript `Object.keys(...).sort()` 顺序递归排序，数组保持顺序，使用无空白 JSON 序列化后计算 SHA-256。文件可以漂亮打印，但 `CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256` 必须等于该 canonical JSON 的小写 64 位 digest。Auto-Cut Lite 必须读取文件、重新规范化并拒绝 digest 不一致、schema 不一致或 binding 不一致；不得改写用户原始 `anchor_text`。

## 7. execution_input.json schema v1

`CURRENT`：Taskboard 当前写入以下最小结构；Auto-Cut Lite 必须按 schema v1 读取并验证必需值，不得从额外字段派生路径、命令或名称：

```json
{
  "schema_version": 1,
  "artifact_name": "课程001_初稿"
}
```

`artifact_name` 是 Taskboard 根据已验证且唯一的命名字段结果加阶段后缀产生的名称。命名清理规则为：替换 Windows 禁止字符 `< > : " / \\ | ? *` 和控制字符，合并空白，去除首尾空格/点，避免连续 `..`，去掉末尾 `.zip`，最长 180 个 Unicode 字符，空值使用 `_`，Windows 保留设备名（如 `CON`、`NUL`、`COM1`）前加 `_`。Auto-Cut Lite 必须使用该名称作为剪映草稿根目录、ZIP 基名和 `result.json` 的 `draft_name`，不得按文档标题或最新文件另取名字。

## 8. 来源读取、用户身份和自动编号

### 8.1 受控来源（`CURRENT`）

Auto-Cut Lite 使用本机已授权的用户身份读取官方飞书 Docx/Wiki 文档和 Base 附件；Taskboard 不代替用户下载素材，也不把访问 token 写进运行文件。视频、意见和音频只读取 manifest 指定的来源，禁止扫描整篇文档寻找“看起来像视频”的附件。

Docx 目录范围包括锚点以下所有层级内容，直到下一个同级或更高层级标题；视频、意见和文档目录音频按各自阶段清单处理。Base 附件必须按字段 ID 读取，附件为空、超过一个、下载失败或媒体类型无法识别都阻塞。

### 8.2 自动编号兼容（`REQUIRED`）

飞书自动编号可能存储在标题样式元数据（如 `seq-marker`），正文只有 `PPT草稿+翻录`；因此实现以下严格算法：

1. 先用用户原始输入和标题正文做完整、区分正文的精确匹配；唯一命中立即使用。
2. 精确失败后，最多从双方开头各移除一个受控编号，再对剩余正文做完整相等比较。
3. 至少支持 `二、`、`2.`、`（二）`、`(2)` 和 `3.1` 等中文/阿拉伯/括号/分级编号。
4. 只允许开头一个编号；不做包含、子串、拼音、大小写猜测、编辑距离或其他模糊匹配。
5. `PPT草稿+翻录` 不得命中 `PPT定稿+翻录`。
6. 去编号后有多个等价标题时返回 `docx_anchor_ambiguous`，不得自行选第一个；没有候选时返回 `docx_anchor_missing`。
7. 同一规则必须用于三个阶段（`initial`、`first_review`、`final_review`）的视频、剪辑意见、文档目录音频，以及章节结束边界判断，不能只对音频实现。
8. manifest 和 Taskboard 配置保留用户原始输入 `二、PPT草稿+翻录`，不得静默删掉编号或改写配置。

### 8.3 音视频处理（`CURRENT`）

视频原音直接保留；外部音频替换时静音视频原音，按文档顺序或唯一 Base 附件配对，使用 `duration_tolerance_seconds` 校验。数量不匹配、媒体下载失败、时长超差、章节跨界或意见目录为空都返回结构化阻塞，不回退或猜测。

## 9. result.json、receipt 和 artifact report

### 9.1 result.json schema v1（`CURRENT`）

成功结果必须严格包含以下字段：

```json
{
  "schema_version": 1,
  "binding": {
    "task_id": "FEI-10",
    "run_id": "run_001",
    "subject_key": "base_opaque:tbl_opaque",
    "config_version": 12,
    "stage_id": "initial",
    "event_id": "event_opaque"
  },
  "manifest_sha256": "<64-lowercase-hex>",
  "status": "pass",
  "package_zip": "<exact-absolute-zip-path>",
  "archive_sha256": "<64-lowercase-hex>",
  "draft_name": "课程001_初稿"
}
```

阻塞结果必须严格包含 `schema_version`、相同的 `binding`、相同的 `manifest_sha256`、`status: "blocked"` 和 `error`；阻塞结果不得带 `package_zip`、`archive_sha256` 或 `draft_name`：

```json
{
  "schema_version": 1,
  "binding": {
    "task_id": "FEI-10",
    "run_id": "run_001",
    "subject_key": "base_opaque:tbl_opaque",
    "config_version": 12,
    "stage_id": "initial",
    "event_id": "event_opaque"
  },
  "manifest_sha256": "<64-lowercase-hex>",
  "status": "blocked",
  "error": {
    "code": "docx_anchor_missing",
    "message": "未找到指定目录标题",
    "details": { "stage_id": "initial" }
  }
}
```

`error.code` 和 `error.message` 必须是非空短文本；不得写入 access token、密码、完整环境变量或堆栈。`result.json` 写入 Taskboard 注入的精确 `CODEX_AUTOCUT_RESULT_PATH`，必须是非空普通文件，大小不得超过 1 MiB。

### 9.2 相邻 package receipt schema v2（`CURRENT`）

成功 ZIP 必须在完全相同路径旁写入 `<package_zip>.receipt.json`。该 receipt 也必须是非空普通文件且不得超过 1 MiB。Taskboard 当前要求下列字段和值：

```json
{
  "schema_version": 2,
  "status": "pass",
  "workflow_mode": "lite",
  "delivery_mode": "lite_zip",
  "archive_path": "<exact-absolute-zip-path>",
  "archive_sha256": "<same-as-result.archive_sha256>",
  "package_root_name": "课程001_初稿",
  "draft_name": "课程001_初稿",
  "zip_crc_pass": true,
  "zip_tree_identity_pass": true,
  "source_manifest_sha256": "<same-as-run-manifest-sha256>",
  "binding": { "task_id": "FEI-10", "run_id": "run_001", "subject_key": "base_opaque:tbl_opaque", "config_version": 12, "stage_id": "initial", "event_id": "event_opaque" },
  "source_pairs": [
    {
      "video_path": "<run-private-video-path>",
      "video_sha256": "<64-lowercase-hex>",
      "audio_mode": "replace_original",
      "replacement_audio_path": "<run-private-audio-path>",
      "replacement_audio_sha256": "<64-lowercase-hex>"
    }
  ],
  "package_zip": "<exact-absolute-zip-path>"
}
```

`CURRENT`：`source_pairs` 必须是按 manifest 素材顺序排列的非空数组，每个视频对应一项。每项至少记录 `video_path`、`video_sha256` 和 `audio_mode`；`audio_mode: "video_original"` 不得伪造替换音频，替换模式则要记录 `replacement_audio_path` 与 `replacement_audio_sha256`。manifest 模式以该有序数组为权威，不得按路径、文件名、大小、修改时间或时长重排。数组顺序、SHA-256、音频引用和剪映草稿中的可编辑片段边界必须一致；外部音频数量不等或任一配对时长差超过容差时阻塞。Taskboard 当前在 receipt 接口边界至少强制它是数组；Auto-Cut Lite 必须用自己的验收测试保证上述语义，并可添加不含凭据的诊断字段。Taskboard 还要求 receipt 的 binding、manifest SHA、archive SHA、草稿名、根目录名、ZIP 路径和两个校验布尔值与本次 run 一致。

### 9.3 taskctl artifact report（`CURRENT`）

在已有 Codex 路径中，Auto-Cut Lite 或其驱动必须对准确 ZIP 运行：

```text
taskctl artifact report --file <absolute-accepted-zip>
```

CLI 只读取该文件、重新计算 SHA-256，并发送：

```http
POST <CODEX_AUTOCUT_ARTIFACT_REPORT_URL>
Authorization: Bearer <CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN>
Content-Type: application/json
X-Taskboard-Client: taskctl
```

```json
{
  "path": "<absolute-accepted-zip>",
  "sha256": "<64-lowercase-hex>",
  "manifestSha256": "<same-as-run-manifest-sha256>"
}
```

`manifestSha256` 在非 phased legacy run 可省略；本合同的 phased run 必须提供。URL 不是 loopback、Bearer 缺失/错误、路径不是绝对 ZIP、哈希不符或 task/run 不匹配均拒绝。CLI 退出码约定：本地用法/文件错误为 `2`，服务不可达为 `3`，响应/接口错误为 `4`，Taskboard 冲突或阻塞为 `5`。

## 10. 精确 ZIP 和草稿校验

`CURRENT`：Taskboard 会独立复算文件 SHA-256 并执行以下校验；Auto-Cut Lite 必须生成能通过这些校验的 ZIP：

- 文件必须是非空 `.zip`，最大 20 GiB；总未压缩内容最大 20 GiB。
- 中央目录最大 32 MiB，最多 20,000 个条目；不支持 ZIP64、多磁盘、加密或除 stored/deflate 外的压缩方法。
- 条目名称 UTF-8、不得为空、绝对路径、盘符路径、`..`/`.`/空片段或目录穿越；反斜杠规范化后仍需安全。
- 不允许大小写不敏感的重复条目；本地头和中央目录的名称、压缩方式、大小/CRC 必须一致。
- 压缩比不得超过实现的 200 倍加 1 MiB 余量；CRC、实际大小和中央目录必须一致。
- ZIP 必须在同一草稿根目录包含 `draft_content.json` 和 `draft_meta_info.json`；两个文件必须是合法 UTF-8 JSON，单个文件最大 64 MiB。
- `package_zip`、`archive_path` 和上报 `path` 必须等于 Taskboard 注入的同一个绝对路径；文件名必须是 `<artifact_name>.zip`，草稿根名必须等于 `artifact_name`。
- Taskboard 不扫描目录、不选择最新 ZIP、不按文件名猜任务归属；丢失或不一致直接阻塞。

## 11. 稳定错误、阻塞和重试

以下错误码在边界上保持稳定；错误消息可本地化，但不能暴露秘密：

| 代码 | 触发条件 | 状态 |
| --- | --- | --- |
| `AUTOCUT_RUNTIME_UNAVAILABLE` | deployment report、runtime、Python 或 wrapper 不匹配 | `CURRENT` |
| `AUTOCUT_RUN_INPUT_INVALID` | run ID、版本、命名输入或输入文件非法 | `CURRENT` |
| `AUTOCUT_SOURCE_INVALID` | 来源 kind/字段不支持 | `CURRENT` |
| `AUTOCUT_STAGE_CONFIG_MISSING` | 绑定阶段不存在 | `CURRENT` |
| `AUTOCUT_AUDIO_INVALID` | 音频 mode、source 或时长无效 | `CURRENT` |
| `INVALID_SOURCE_MANIFEST` | manifest 字段、URL、ID 或安全边界非法 | `CURRENT` |
| `SOURCE_MANIFEST_FIELD_UNSUPPORTED` | manifest 带未知或可执行/凭据字段 | `CURRENT` |
| `SOURCE_MANIFEST_SCHEMA_UNSUPPORTED` | 非 schema v1 | `CURRENT` |
| `docx_anchor_missing` | 严格/编号回退均找不到目录 | `CURRENT` 错误码，`REQUIRED` 新回退场景 |
| `docx_anchor_ambiguous` | 去编号后有多个等价标题 | `CURRENT` 错误码，`REQUIRED` 新回退场景 |
| `FIELD_NOT_FOUND` | 配置的附件字段不在实时 metadata | `CURRENT` |
| `FIELD_TYPE_INVALID` | 配置字段存在但不是附件类型 | `CURRENT` |
| `autocut_result_missing` / `autocut_result_invalid` | result 缺失、超限、JSON 或字段不正确 | `CURRENT` |
| `autocut_package_receipt_missing` / `autocut_package_receipt_invalid` | 相邻 receipt 缺失或绑定/字段不正确 | `CURRENT` |
| `AUTOCUT_RUN_BINDING_MISMATCH` | task/run/stage/event/config/hash/path 不一致 | `CURRENT` |
| `INVALID_ZIP` / `INVALID_ZIP_ENTRY` / `INVALID_DRAFT_ZIP` | ZIP 结构、路径、CRC 或草稿 JSON 不合格 | `CURRENT` |
| `UNSUPPORTED_ZIP` | ZIP64、多磁盘、加密或压缩格式不支持 | `CURRENT` |
| `ARTIFACT_HASH_MISMATCH` | 上报哈希与文件实际内容不同 | `CURRENT` |
| `ARTIFACT_OUTSIDE_SOURCE_ROOT` | ZIP 不在冻结的配置根目录内 | `CURRENT` |
| `autocut_process_failed` | 固定 runtime 命令非零退出 | `CURRENT` |

任何来源、身份、路径、manifest、result、receipt、ZIP 或时长问题都必须 fail-closed：任务进入 `blocked`，保留 run ID 和稳定错误，不生成或登记不完整 ZIP，不自动换来源，不把 Taskboard 状态回写飞书。用户修正来源后显式点击重试；重试创建新 run、新 job root 和新 manifest，旧 run 只保留审计记录。

## 12. 安全和身份边界

`CURRENT`：

- Bridge 和 Taskboard 仅监听 `127.0.0.1`（或等价 loopback），不开放 LAN/公网端口；artifact report 也只接受 loopback URL。
- 飞书读取使用 Auto-Cut Lite 本机已授权用户身份；凭据只留在受批准的本机安全配置，不进入 manifest、环境变量转发、prompt、任务描述、receipt、测试报告或 Git。
- Base 单元格只能提供受控字段值、opaque ID 和包别名；不得提供 workspace path、shell、Codex 参数、prompt、凭据、ZIP 路径或上传目标。
- 所有路径都由 Taskboard 服务器绑定并做绝对路径、realpath、根目录和精确文件名校验。Auto-Cut Lite 只能写入 `CODEX_AUTOCUT_DRAFTS_ROOT`、`CODEX_AUTOCUT_PACKAGE_ZIP_PATH` 和自身 run 临时目录。
- `CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN` 是短期 run capability；不能跨 task/run/stage/config 使用，也不能从评论、飞书单元格或自由文本取得。
- 模拟事件、普通任务、复制描述标记和 `feishu` 标签不能获得 Auto-Cut 执行资格。Taskboard 不启动 Codex Bridge，也不回写飞书记录。

## 13. 完整验收矩阵

源码开发任务必须在中文测试报告中逐行引用下表，写出命令、输入和实际结果。`PASS` 不能用口头说明代替。

| 编号 | 验收场景 | 预期结果 | 状态 |
| --- | --- | --- | --- |
| A01 | `video_original` 三阶段运行 | 保留视频原音，成功产出绑定 ZIP | CURRENT |
| A02 | 文档目录音频替换 | 读取 `docx_section`，静音原音并替换 | CURRENT |
| A03 | Base 附件音频替换 | 读取唯一 `base_attachment` 并替换 | CURRENT |
| A04 | 初稿/初审/终审各自配置 | 三个 `stage_id` 互不串配置 | CURRENT |
| A05 | 默认时长误差 | 缺省值按 3 秒处理 | CURRENT |
| A06 | 自定义正数时长误差 | 在误差内通过，超差阻塞 | CURRENT |
| A07 | 空/负/NaN/Infinity 误差 | 返回 `AUTOCUT_AUDIO_INVALID` 或等价稳定阻塞 | CURRENT |
| A08 | 空音频标题/空字段 ID | fail-closed，不回退视频原音 | CURRENT |
| A09 | 附件字段不存在/类型错误 | `FIELD_NOT_FOUND` / `FIELD_TYPE_INVALID` | CURRENT |
| A10 | 文档标题正文精确匹配 | 唯一精确命中优先 | CURRENT（新算法回归） |
| A11 | `二、PPT草稿+翻录` 对无编号正文 | 编号回退命中同一正文 | REQUIRED |
| A12 | `2.`、`（二）`、`(2)`、`3.1` | 每次只去掉一个开头编号并完整匹配 | REQUIRED |
| A13 | `PPT草稿+翻录` vs `PPT定稿+翻录` | 不匹配，返回 `docx_anchor_missing` | REQUIRED |
| A14 | 去编号后多个同名标题 | 返回 `docx_anchor_ambiguous`，不自行选择 | REQUIRED |
| A15 | 自动编号边界 | 视频、意见、音频和章节结束都不跨入下一标题 | REQUIRED |
| A16 | manifest 原始标题保留 | 输出保留用户原始 `anchor_text`，不静默删编号 | REQUIRED |
| A17 | manifest schema/未知字段/hash | 拒绝非 v1、未知字段或 SHA 不一致 | CURRENT |
| A18 | binding 篡改 | task/run/stage/event/config/record 不一致时阻塞 | CURRENT |
| A19 | result 成功结构 | 精确 ZIP、archive SHA、draft name 和 manifest SHA 一致 | CURRENT |
| A20 | blocked result 结构 | 不带 ZIP 字段，含稳定 error code/message | CURRENT |
| A21 | 相邻 receipt v2 | receipt 路径、binding、hash、CRC/tree 标志一致 | CURRENT |
| A22 | `taskctl artifact report` | loopback + Bearer + exact path/hash；错误退出码稳定 | CURRENT |
| A23 | ZIP 路径穿越/重复/CRC/压缩炸弹 | 被拒绝，不存储不完整产物 | CURRENT |
| A24 | 缺 draft JSON 或非法 JSON | `INVALID_DRAFT_ZIP` | CURRENT |
| A25 | 目录扫描/最新 ZIP诱导 | 不扫描、不猜测、不登记其他 ZIP | CURRENT |
| A26 | 普通任务/伪造标签/模拟事件 | 无 Auto-Cut 执行资格 | CURRENT |
| A27 | 两个并发 run 同一包 | 剪辑按包串行；上传并发仍独立 | CURRENT |
| A28 | 失败后重试 | 新 run/new job root，旧 run 和错误保留 | CURRENT |
| A29 | 外部身份/凭据泄露检查 | manifest、prompt、receipt、日志和报告不含秘密 | CURRENT |
| A30 | 候选包复现与 SHA | 交付包 SHA 可独立复算，源码 commit 可定位 | REQUIRED |

请先从 Auto-Cut Lite 仓库的 README/项目配置读取真实命令再执行；不得把下面的尖括号占位符当作命令运行。中文报告至少要覆盖单元测试、静态检查或 lint、四种 fixture 主路径以及候选包 SHA-256：

```text
<project-test-command>
<project-lint-or-typecheck-command>
<fixture-command-for-docx-numbering>
<fixture-command-for-video-original>
<fixture-command-for-docx-audio>
<fixture-command-for-base-attachment-audio>
<fixture-command-for-result-receipt-zip-validation>
sha256sum <candidate-package>       # Windows 可使用 Get-FileHash -Algorithm SHA256
```

## 14. 发布、交接和部署顺序

1. 在 Auto-Cut Lite 源码仓库新分支实现 `REQUIRED`，运行完整测试并提交。
2. 构建候选包，计算 SHA-256，写中文测试报告和交付说明；不安装到当前生产电脑。
3. 有 GitHub 权限时先推送分支，并在团队流程要求时创建 PR；无权限时交付本地分支和完整 commit，并明确“尚未推送 GitHub”。
4. 将候选包、`.sha256`、测试报告、交付说明放入版本化目录；把目录和链接交回 Taskboard 维护任务。
5. Taskboard 复核源码定位、报告和候选包 hash，先在测试表/示例项目验证三阶段和编号边界。
6. 只有用户明确要求后，才在目标电脑安装或部署；部署后再做真实飞书事件端到端验证。

## 15. 明确不在本次范围（`OUT OF SCOPE`）

- 修改、构建、安装或部署用户当前电脑上已部署的 Auto-Cut Lite 目录。
- 新增第三种 wire-level 音频 mode、升级 manifest schema v1 或改变现有 `result.json`/receipt/ZIP 字段名称。
- 扫描目录、选择最新 ZIP、按文件名/大小/时长“猜测”素材或跨阶段借用素材。
- 多附件自动配对、完全并行剪辑、目录监听 `watch_directory`。
- 从飞书记录回写状态、结果、凭据或日志。
- 通过普通任务描述、标签、评论、单元格或 GitHub token 取得执行授权。

## 16. 变更记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| 1.1 | 2026-09-11 | 补充实际 Taskboard 功能基线、只读核对的 Auto-Cut Lite 兼容基线，并明确源码目录和 GitHub 分支/PR 交付顺序。 |
| 1.0 | 2026-09-10 | 汇总 Taskboard 当前稳定接口、三阶段音频来源、自动编号兼容要求、完整验收矩阵和源码交付包要求。 |
