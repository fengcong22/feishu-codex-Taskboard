# 飞书 → Codex Taskboard MVP

这是一个仅在本机运行的 MVP。它会把飞书多维表格中“进入待剪辑”的记录变成 Taskboard 任务，并由用户手动启动 Codex。

## 第一次启动

在 PowerShell 中执行：

```powershell
Set-Location D:\codex\codex-feishu
.\scripts\start-local.ps1
```

脚本会打开 Taskboard：<http://127.0.0.1:47823>。

首次启动会生成 `config/bridge.local.json`。不要把真实项目目录填进飞书单元格，目录只能在这个本地配置文件中设置。

当前本地配置已经登记测试 Base `自动剪辑-测试` 的 `高中历史` 表。由于表里暂时没有 `自动剪辑项目包` 字段，该表固定使用本机白名单中的 `Auto-cut-copyA`；以后新增字段后可改成逐记录路由。

任务卡片标题按表配置读取当前记录：优先使用 `titleField`/`titleFieldId` 指定的 `视频名称`，为空时使用 `fallbackTitleField`/`fallbackTitleFieldId` 指定的 `集合文档`，两者都为空时回退到飞书记录 ID。标题读取失败不会阻止建任务，记录 ID 仍始终保留在任务描述中。

Taskboard 启动时会从 `CODEX_FEISHU_PACKAGES_PATH` 读取同一个配置文件，把 `packages` 中的项目包别名映射到固定的 `projectId`、工作区目录和提示词。任务描述只保存别名和记录上下文；即使有人修改任务描述，也不能替换实际执行的提示词或工作区。

默认示例工作区是 `examples/harmless-auto-cut`。确认流程稳定后，再把每个项目包的 `workspacePath` 和 `prompt` 改成真实项目值；这些配置只保存在本机，不写入飞书表格。

## 团队交接与健康检查

完整的固定流程和变更规则见根目录 [`AGENTS.md`](./AGENTS.md)。在交给团队或排查问题时，先运行只读检查：

```powershell
.\scripts\check-local.ps1
```

它会检查 Node.js 版本、本地配置、Taskboard 和 Bridge 健康接口，并显示飞书监听器状态；不会停止进程、创建任务或打印凭据。需要确认真实飞书长连接时，再运行：

```powershell
.\scripts\check-local.ps1 -RequireFeishu
```

交接验收标准是：`npm test` 全部通过；模拟事件第一次只创建一个任务；重放同一事件返回 duplicate 且不创建第二个任务；真实测试表记录改为 `待剪辑` 后能创建一个对应任务。

## 模拟一条“待剪辑”变更

```powershell
.\scripts\simulate-ready.ps1
```

页面会出现一条待办任务。打开任务后点击“启动 Codex”，可在网页的 AI 对话面板中看到过程和结果。

## 启用真实飞书长连接

Bridge 使用飞书官方 Node SDK `@larksuiteoapi/node-sdk@1.36.0`。第一次启用前安装依赖：

```powershell
Set-Location D:\codex\codex-feishu
npm install
```

`.env.local` 中需要有 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。该文件不会提交到 Git，启动日志也不会打印凭据。

随后启用长连接启动：

```powershell
.\scripts\start-local.ps1 -EnableFeishu
```

健康状态可从 <http://127.0.0.1:47824/health> 查看。监听器注册的事件为 `drive.file.bitable_record_changed_v1`；收到事件后只创建手动待办，不会自动启动 Codex，也不会回写飞书记录。

## 停止服务

```powershell
.\scripts\stop-local.ps1
```

这个脚本只停止它自己记录且命令行匹配的本地 Taskboard 与 Bridge 进程。

## 当前边界

- 已支持：模拟事件、真实事件标准化、官方 SDK 长连接入口、按表配置、字段 ID 匹配、任务标题字段回退、表级默认项目包、进入 `待剪辑` 时建任务、幂等去重、手动启动、网页进度。
- 暂未启用：自动启动、回写多维表格、真实视频剪辑流程。
