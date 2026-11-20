# auto-cut-autoedit 接入（`document_edit_zip` 模板）

auto-cut-autoedit 按剪辑清单真实剪辑课程视频（成片会变短），交付成片、PR 工程和执行反馈表。
它沿用 Lite 的“文档 → 阶段 → 精确 ZIP”整条外壳，只有下面几处按模板分开。
Lite 的完整协议见 [auto-cut-lite-interface-requirements.md](auto-cut-lite-interface-requirements.md)，
本文只写不同的地方；没有写到的（素材清单、execution_input、环境变量、结果文件、上报、NAS 上传、状态回写、
重试）与 Lite 完全相同。

## 1. 包声明

`PACKAGE-MANIFEST.json`：

```json
{
  "interface": {
    "workflowTemplate": { "id": "document_edit_zip", "version": 1 },
    "artifactKind": "edit_zip",
    "zipOutput": { "relativeDirectory": "output" }
  }
}
```

- 不带 `contract`、`driverId`；`artifactKind` 可省略，写了就必须是 `edit_zip`。
- 已保存为 Lite 模板的包不能变成本模板（`PACKAGE_WORKFLOW_MISMATCH`），反之亦然。
- 学科配置（阶段、触发、来源、交付）与 Lite 共用同一份草稿结构。

## 2. 运行

只走本机 runtime 路径（自动触发或带授权的重试）。不开放 Codex 路径：手动“开始 AI”返回
`PACKAGE_LOCAL_RUN_REQUIRED`，任务保持原状态。

| | Lite（`document_draft_zip`） | autoedit（`document_edit_zip`） |
|---|---|---|
| 部署报告 | `%LOCALAPPDATA%\Auto-Cut\auto-cut-lite\deployment-report.json` | `%LOCALAPPDATA%\Auto-Cut\auto-cut-autoedit\deployment-report.json` |
| 命令 | `<python> <runtime>\scripts\jy_wrapper.py review-document-run …` | `<python> -m auto_cut_autoedit taskboard-run …`（工作目录为 runtime 根目录，需有 `auto_cut_autoedit\__main__.py`） |
| readiness 变量 | `AUTOCUT_LITE_READINESS_PATH` | `AUTOEDIT_READINESS_PATH` |

`…` 部分参数完全相同：`--source-manifest --execution-input --job-root --drafts-root --package-zip --result-path --json`。
找不到自己的部署报告时报 `AUTOCUT_RUNTIME_UNAVAILABLE`，不会退回去运行 Lite。

进度阶段在 Lite 的基础上多认两个：`edit`（剪辑并出片）、`feishu_write`（写入审核文档）。

## 3. 回执和 ZIP

- 相邻回执 `<ZIP>.receipt.json` schema v2，`workflow_mode: "autoedit"`，`delivery_mode: "edit_zip"`；
  其余绑定和校验字段与 Lite 相同。按任务冻结的包快照判断模板，Lite 回执不能通过本模板，反之亦然。
- ZIP 内容（`INVALID_EDIT_ZIP`）：只有一个根目录，名称等于 `artifact_name`，其中必须有
  `<根目录>/<根目录>.mp4`、`<根目录>/工程/*.xml`、`<根目录>/执行反馈表.csv`、`<根目录>/剪辑清单.json`；
  ZIP 根目录下不能有散落的文件。其余 ZIP 结构检查（无 ZIP64、路径安全、CRC、大小上限）与 Lite 相同。

## 4. 多选触发字段（对所有 ZIP 模板生效）

阶段触发字段可以是单选，也可以是多选（`statusField.type: "multi_select"`）：

- 新勾上某阶段的触发选项 → 进入该阶段（登记新运行）；取消勾选 → 离开（`archive_waiting`）。
- 勾选其他非触发选项不触发；一次同时勾上两个阶段的触发选项报 `AMBIGUOUS_STATUS_EDGE`，不登记。
- 单选字段的规则不变。
