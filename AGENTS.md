# 飞书 Bridge 团队运行规范

## 固定数据流

生产流程固定为：飞书多维表格发生变化 → 飞书官方 SDK 长连接接收事件 → Bridge 按表和字段规则筛选、标准化、去重 → Taskboard 创建手动任务。

Bridge 和 Taskboard 只绑定本机 loopback（`127.0.0.1`），不得改成 LAN 或公网监听。当前流程不会自动启动 Codex、回写飞书记录或处理真实视频。

## 标准命令

在仓库根目录 `D:\codex\codex-feishu` 执行：

```powershell
npm install
npm test
.\scripts\start-local.ps1
.\scripts\check-local.ps1
.\scripts\simulate-ready.ps1
.\scripts\check-local.ps1 -RequireFeishu
.\scripts\stop-local.ps1
```

`-RequireFeishu` 只在需要验证真实长连接时使用；模拟流程可以在监听器 disabled 时运行。

## 配置和安全边界

- 真实配置只放在被 Git 忽略的 `config/bridge.local.json`；示例结构维护在 `config/bridge.example.json`。
- `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 只放在 `.env.local` 或团队批准的密钥管理工具中，不写入飞书单元格、日志、任务描述或 Git。
- 飞书单元格只能提供受控字段值和项目包别名；不能提供工作区路径、shell 命令、Codex 参数或 prompt。
- Bridge 只解析配置白名单中的项目包别名，并使用配置中的绝对工作区路径和固定 prompt。

## 事件不变量

- 只有从其他值变化到 `待剪辑` 才创建任务。
- 同一事件按 `event_id` 幂等处理；重放事件不得创建第二个任务。
- Taskboard 暂时不可用时必须持久化 `retry_wait`/`pending` 状态，按有限退避安全重试；Bridge 重启时恢复过期租约，超过上限的事件保留为 `dead_letter`，不得静默丢弃。
- 未知或缺失项目包别名必须阻断执行，不得把单元格内容当作路径或命令。

## 故障排查

1. 先运行 `.\scripts\check-local.ps1`，再根据输出查看 `.runtime\logs\bridge.stdout.log` 和 `taskboard.stdout.log`。
2. 真实事件需要运行 `.\scripts\check-local.ps1 -RequireFeishu`，监听器必须显示 `sdk_managed`。这只证明官方 SDK 已接管长连接；SDK 没有公开物理 socket 或连接回调，必须用指定测试表事件完成端到端验证。
3. 修改配置后先停止并重新启动服务，再用模拟事件验证；不要直接删除状态文件来“修复”重复任务。
4. 网络/DNS 重试持续发生时，记录时间和日志后再重启服务；不要在飞书表格中反复改动生产记录做测试。

健康接口 `/health` 返回脱敏的监听器对象（`state`、`lastEventAt`、`lastError`）和队列计数（`pending`、`processing`、`retryWait`、`deadLetter`）。模拟事件在已持久化的 `retry_wait` 或 `dead_letter` 结果下返回 HTTP 202，表示 Bridge 已安全接收并记录，不能据此要求飞书重复投递。

## 变更规则

`AGENTS.md` 是本仓库唯一的运行规范文件。任何会改变事件筛选、任务路由、凭据处理、端口或启动方式的修改，都必须：

- 同时更新自动化测试和 README；
- 先在测试表/示例项目中验证；
- 经过代码评审后再合并。

不要创建第二份 `agents.md`，也不要把本地凭据或运行状态提交到仓库。
