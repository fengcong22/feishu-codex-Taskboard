# 飞书 Bridge × Codex Taskboard

> 将飞书多维表格的状态变化，安全地转换为可追踪的 Taskboard 任务。

这是一个仅在本机运行的自动化桥接服务：当飞书多维表格中的记录进入 `待剪辑`，本地 Bridge 会通过飞书官方 SDK 接收事件、校验和整理数据，并在 Taskboard 创建一张手动待办任务；记录离开 `待剪辑` 时，会只归档同一记录仍在“等待认领”（`todo`）的匹配任务。投递采用“至少一次处理 + 创建前元数据查找”，记录会持久化，临时故障可以有限重试并在重启后恢复；Bridge 不宣称绝对 exactly-once，因为当前 Taskboard 没有原生幂等键。Bridge 不会自动启动或停止 Codex，执行中的任务由使用者和所接入的 Taskboard 决定。

## 数据流

```mermaid
flowchart LR
    A["飞书多维表格\n记录变化"] --> B["飞书官方 SDK\n长连接事件订阅"]
    B --> C["本地 Bridge\n筛选 · 标准化 · 去重"]
    C --> D["本地 Taskboard\n创建手动任务"]
    D --> E["使用者\n手动启动 Codex"]
```

所有服务只监听 `127.0.0.1`；飞书单元格不能传入本地路径、命令或提示词。

## 当前已支持

| 能力 | 说明 |
| --- | --- |
| 飞书事件接收 | 使用飞书官方 Node SDK 的长连接接收多维表格记录变化。 |
| 安全路由 | 按 Base、表、字段、状态值和项目包别名筛选事件。 |
| 幂等去重 | 已持久化成功的同一 `event_id` 重放会返回 `duplicate`，正常重放不会再次创建；整体投递语义仍是至少一次。 |
| 任务标题回退 | 优先读取“视频名称”，其次“集合文档”，失败时回退到飞书记录 ID。 |
| Taskboard 集成 | 创建待办；记录离开 `待剪辑` 时只归档匹配的 `todo` 任务，不改动处理中或已完成任务；Bridge 不启动 Codex。 |
| 可靠投递 | 投递状态持久化重试，临时 Taskboard 故障按有限退避处理，Bridge 重启后恢复未完成租约。 |
| 死信可见性 | 超过重试上限的事件进入 `dead_letter`，可从健康接口的队列计数定位。 |
| 状态文件保护 | 损坏的状态文件、无效租约或不完整快照会安全停留在可诊断状态；读写（包括健康队列统计）使用同一稳定路径校验和操作系统本机互斥锁，写入使用原子替换，崩溃后可安全恢复。状态文件必须是稳定的普通文件，不接受符号链接或硬链接别名。 |
| SDK-managed 监听 | 显式启用官方 SDK 自动重连；健康状态使用 `sdk_managed`，不伪造物理连接确认。 |
| 健康检查 | 一条命令检查 Node、配置、Taskboard、Bridge、监听器状态和 pending/retry/dead-letter 队列计数。 |

## 界面展示

![Taskboard 看板界面（本地测试数据）](./docs/assets/taskboard-kanban-demo.jpg)

上图为使用本地测试数据的真实 Taskboard 看板，展示了待办卡片及“等待认领”“处理中”“等你确认”等看板状态。Taskboard 的手动启动与网页展示属于外部 Taskboard 能力；本仓库的 Bridge 仅负责按规则创建待办任务。真实业务任务的可见范围仍应由团队权限和 GitHub 仓库权限控制。

## 本地配置详情

首次运行时，`start-local.ps1` 会从 `config/bridge.example.json` 生成被 Git 忽略的 `config/bridge.local.json`。示例文件包含占位符，不能直接用于真实飞书或模拟建任务；请先在本机填写测试 Base、表、字段 ID 和项目包配置。

- `tables` 只登记允许接收事件的 Base、表、触发字段、状态值和标题字段。
- `packages` 只登记受控的项目包别名，以及固定的 `projectId`、绝对 `workspacePath` 和提示词；飞书单元格只能选择别名，不能传路径、命令或提示词。
- 本地 Taskboard 是外部依赖，且需要它自己的依赖和可用的 Codex 可执行文件。启动脚本默认在 `D:\codex\dashi-taskboard` 查找它；若安装在别处，请在启动前设置 `$env:CODEX_TASKBOARD_ROOT` 为该目录的绝对路径。

不要提交 `config/bridge.local.json`、`.env.local` 或 `.runtime/`。默认示例工作区为 `examples/harmless-auto-cut`；确认测试流程稳定后，再将项目包的 `workspacePath` 和 `prompt` 调整为团队批准的真实值。

## 5 分钟快速体验（完成本地配置后）

### 1. 安装依赖并启动本地服务

```powershell
Set-Location D:\codex\codex-feishu
npm install
.\scripts\start-local.ps1
```

浏览器会打开 Taskboard：<http://127.0.0.1:47823>。

### 2. 检查运行状态

```powershell
.\scripts\check-local.ps1
```

### 3. 模拟一条进入“待剪辑”的记录

```powershell
.\scripts\simulate-ready.ps1
```

仅当 `config/bridge.local.json` 中的测试表和字段与 `simulate-ready.ps1` 的固定样例事件相匹配时，Taskboard 才会出现一张任务。已有成功状态后再次运行同一命令应返回 `duplicate: true`，正常情况下不会出现第二张任务；该脚本没有事件参数，请使用团队提供的匹配测试配置。其他表需要维护者提供并评审匹配的模拟请求，不要将示例占位符当作有效配置。

任务卡片标题按表配置读取当前记录：优先使用 `titleField`/`titleFieldId` 指定的 `视频名称`，为空时使用 `fallbackTitleField`/`fallbackTitleFieldId` 指定的 `集合文档`，两者都为空时回退到飞书记录 ID。标题读取失败不会阻止建任务，记录 ID 仍始终保留在任务描述中。

### 任务生命周期边界

- 其他值 → `待剪辑`：创建一张新的“等待认领”任务。
- `待剪辑` → 其他值：按任务描述中的 Base、表、记录和触发字段身份匹配，只归档仍为 `todo` 且未归档的任务。
- 已进入 `in_progress`（处理中）、`in_review`（等你确认）、`done` 或其他非 `todo` 状态：保持不动，由 Taskboard/Codex 管理。
- 再次进入 `待剪辑`：允许创建新任务；归档任务仍可在 Taskboard 的归档区域查看和恢复。

当前没有启用“飞书字段状态 → Taskboard 各列”的通用映射。已知并发边界是：如果离开事件延迟到快速“离开 → 再次进入”之后，旧事件按记录匹配全部 `todo` 任务，可能归档新一轮任务；需要严格按轮次隔离时，再增加记录版本或事件顺序约束。

建议用测试表按以下顺序验收：进入 `待剪辑` 确认出现等待认领任务；不接单改回其他状态确认任务消失且能在归档区查到；再次进入确认产生新任务；另一路先启动 Codex 再改飞书状态，确认执行中的任务不被归档。

## 团队交接与健康检查

完整的固定流程和变更规则见根目录 [`AGENTS.md`](./AGENTS.md)。在交给团队或排查问题时，先运行只读检查：

```powershell
.\scripts\check-local.ps1
```

它会检查 Node.js 版本、本地配置、Taskboard 和 Bridge 健康接口，并显示 `sdk_managed` 监听器状态及 pending、processing、retryWait、deadLetter 数量；不会停止进程、创建任务或打印凭据。需要确认真实飞书长连接时，再运行：

```powershell
.\scripts\check-local.ps1 -RequireFeishu
```

交接验收标准是：`npm test` 全部通过；模拟事件第一次只创建一个任务；已有成功状态的重放返回 `duplicate` 且不创建第二个任务；真实测试表记录改为 `待剪辑` 后能创建一个对应任务。整体链路是至少一次处理；若进程在 Taskboard POST 成功后、状态提交前崩溃，需依据任务元数据人工核对，不能宣称绝对 exactly-once。`-RequireFeishu` 只证明 SDK 已接管监听（`sdk_managed`），当前 SDK 没有公开的物理 socket 确认或连接回调，必须再用指定测试表事件做端到端验证。

### Taskboard 故障恢复演练

在指定测试配置下执行一次安全演练：

1. 暂停 Taskboard，调用现有 `simulate-ready.ps1` 发送一条匹配事件，确认接口返回 `202` 且队列出现 `retryWait`。
2. 恢复 Taskboard，等待退避窗口，确认队列计数归零，并通过事件元数据确认只保留一张任务。
3. 重放已有成功状态的同一事件，确认返回 `duplicate: true`，不会创建第二张任务。

只使用测试表和本地示例，不要通过删除状态文件来“修复”重复任务。

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

健康状态可从 <http://127.0.0.1:47824/health> 查看。监听器注册的事件为 `drive.file.bitable_record_changed_v1`，由官方 SDK 管理断线自动重连；收到事件后只按生命周期规则创建或归档手动待办，不会自动启动 Codex，也不会回写飞书记录。`sdk_managed` 表示 SDK 已接管生命周期，不代表应用拿到了公开的物理 socket 状态。

## 停止服务

```powershell
.\scripts\stop-local.ps1
```

这个脚本只停止它自己记录且命令行匹配的本地 Taskboard 与 Bridge 进程。

## 当前边界

- Bridge 已支持：模拟事件、真实事件标准化、官方 SDK 长连接入口、按表配置、字段 ID 匹配、任务标题字段回退、表级默认项目包、进入 `待剪辑` 时创建任务、离开 `待剪辑` 时归档未认领任务，以及幂等去重。
- Taskboard 的手动启动与网页展示属于外部 Taskboard 能力，不由 Bridge 实现或验证。
- Bridge 不会自动启动或停止 Codex；所有任务均需由使用者在所接入的 Taskboard 中手动处理。
- 不会回写飞书记录。
- 当前 SDK 没有公开的物理 socket 确认或连接生命周期回调；健康接口不会伪造 `connected` 状态。
- 暂无人工 `dead_letter` 重试 endpoint；需要人工处理时先依据队列计数和脱敏日志定位，并按评审流程操作。
- 不提供多实例高可用（HA）；补偿 worker 在单个 Bridge 进程内串行运行。
- 投递语义是至少一次；同机状态锁只封闭并发窗口。当前 Taskboard 没有原生幂等键，若 POST 已成功但 Bridge 在状态提交前崩溃，仍存在极端重复创建风险，需通过事件元数据核对。
- `stateFile` 必须保持稳定的普通文件路径；不支持状态文件本身的符号链接、硬链接或多链接别名，也不要在运行中替换状态文件路径。锁只覆盖本机 Windows/Linux 进程。
- Taskboard 返回无法识别的成功响应时会按临时故障重试；Bridge 的异常 HTTP 响应只返回安全错误码，不回显原始消息。
- 不处理真实视频，也不提供自动配音、自动剪辑或视频导出能力。
