# Feishu Bridge 可靠性与补偿设计

## 目标

在不改变现有业务规则和安全边界的前提下，让“飞书事件 → Bridge → Taskboard”链路能够从临时故障中自动恢复，降低事件丢失和重复建任务的风险。

本设计只覆盖：

- Taskboard 投递失败后的持久化补偿；
- Bridge 重启后的未完成事件恢复；
- Feishu 长连接断线后的自动重连；
- 健康检查中的队列和连接状态。

本设计不包含：

- 自动启动 Codex；
- 飞书记录回写；
- 真实视频处理；
- LAN 或公网监听；
- SQLite 或其他外部数据库迁移。

## 不变的业务与安全规则

以下行为保持不变：

1. 只有配置表中触发字段从其他值变为 `待剪辑` 才进入投递流程。
2. 未知表、无关字段和非触发状态变化仍记为 ignored。
3. 缺失或未知项目包别名仍按现有规则生成 blocked 任务，不得把单元格内容当作路径、命令或提示词。
4. Bridge 和 Taskboard 只绑定 `127.0.0.1`。
5. 同一 `eventId` 重放不得创建第二个 Taskboard 任务。
6. Taskboard 成功创建后，Bridge 只记录任务结果，不改变飞书记录。

## 总体架构

```text
Feishu WebSocket
      │
      │ 断线自动重连
      ▼
事件标准化与业务判定
      │
      ▼
持久化投递记录（JSON 状态文件）
      │
      ├── 主处理 worker：处理新事件
      ├── 补偿 worker：处理到期重试
      └── 启动恢复：接管未完成事件
      │
      ▼
本地 Taskboard
```

第一版继续使用现有 JSON 状态文件和文件锁，避免引入新的数据库依赖。存储接口需要扩展为原子领取和状态更新；后续事件量明显增长时，再单独评估 SQLite 迁移。

## 投递状态模型

每条事件保存一条持久化记录。业务判断结果和投递生命周期分开保存：

### 投递生命周期

```text
pending → processing → succeeded
             │   └──→ retry_wait → pending
             └──────→ dead_letter
```

- `pending`：等待首次处理或等待人工重新投递；
- `processing`：某个 worker 已经领取，带有租约；
- `retry_wait`：临时失败，等待 `nextAttemptAt`；
- `succeeded`：已找到或创建对应 Taskboard 任务；
- `dead_letter`：临时失败超过自动重试上限，等待人工处理。

业务决策单独记录为 `ignored`、`blocked` 或 `ready`。例如，缺少项目包且成功创建了 blocked 任务时，记录为 `decision=blocked`、`deliveryState=succeeded`。

### 持久化字段

至少包含：

- `schemaVersion`；
- `eventId`；
- 标准化事件快照（Base、表、记录、字段及前后值）；
- `deliveryState`；
- `decision`（完成判定后写入）；
- `attempts`、`nextAttemptAt`；
- `lease`（worker 标识和 `leaseUntil`）；
- 最近一次错误的安全摘要（错误码、短消息、时间）；
- 成功结果（Taskboard task ID/identifier）；
- `createdAt`、`updatedAt`。

不保存飞书应用密钥，也不把任意路径、命令或用户提供的 prompt 写入补偿控制字段。

## 处理流程

### 新事件

1. WebSocket 回调将 payload 标准化为现有小事件结构。
2. Bridge 通过事件 ID 执行原子领取：已是终态的事件直接返回原结果；正在有效租约内处理的事件不重复领取。
3. 领取成功后进入 `processing`，再执行现有的业务判定、标题读取和 Taskboard 查找/创建。
4. 成功找到或创建任务后写入 `succeeded`；无关事件也写入终态，避免重复处理。

### 临时失败

以下错误可自动重试：Taskboard 不可达、请求超时、HTTP 429、HTTP 5xx，以及可明确识别的临时 Feishu 查询失败。

失败时：

1. 增加 `attempts`；
2. 保存脱敏错误摘要；
3. 按指数退避计算 `nextAttemptAt`，加入少量随机抖动并限制最大间隔；
4. 未超过上限则写入 `retry_wait`，超过上限则写入 `dead_letter`。

确定性错误（未知表、非触发变化、缺失/未知项目包等）不进入自动重试。若 blocked 任务本身创建失败，只有该次投递错误按临时失败规则重试。

### 启动恢复与补偿

Bridge 启动时扫描状态文件：

- `pending` 立即进入处理队列；
- `retry_wait` 在到达 `nextAttemptAt` 后进入队列；
- `processing` 若租约已过期，则恢复为 `pending`；
- 有效租约中的 `processing` 不被另一个 worker 接管。

补偿 worker 定期处理到期记录。第一版默认单 worker 串行执行，避免给 Taskboard 造成突发压力；重试间隔和最大次数通过受控本地配置设置，并提供安全默认值。

### 幂等与请求不确定性

每次创建 Taskboard 任务前，继续使用服务端生成的事件元数据查找已有任务。即使请求已到达 Taskboard 但响应丢失，重试也会先发现已有任务再复用。

目标是“至少一次处理 + 幂等建任务”，不宣称绝对 exactly-once。后续若 Taskboard 提供原生幂等键或按事件 ID 查询接口，可再增强这一层。

## Feishu 长连接重连

在现有 SDK listener 外增加 supervisor：

- 首次启动失败或连接断开后自动重试；
- 使用指数退避和抖动，设置最大重连间隔；
- 停止服务时取消待执行的重连计时器，不再建立新连接；
- 每次连接使用明确的 generation，旧连接回调不能覆盖新连接状态；
- 重连期间已进入 Bridge 的事件继续由投递队列处理，重连成功后重复事件仍由 `eventId` 去重。

健康状态至少记录：

- `state`：`disabled`、`starting`、`connected`、`reconnecting`、`error`、`stopped`；
- `lastConnectedAt`；
- `lastEventAt`；
- `lastError` 的错误码和时间；
- 当前事件队列深度。

断线重连只解决事件接收连续性，不替代投递补偿队列；两者独立运行。

## 健康检查与人工操作

`GET /health` 保持匿名可读，并增加脱敏运行状态：

```json
{
  "ok": true,
  "feishuListener": {
    "state": "connected",
    "lastConnectedAt": "...",
    "lastEventAt": "...",
    "lastError": null
  },
  "queue": {
    "pending": 2,
    "processing": 1,
    "retryWait": 3,
    "deadLetter": 0
  }
}
```

第一版至少提供只读的 pending/dead-letter 统计和日志定位信息。人工重试接口或命令必须：

- 只接受明确的 `eventId`；
- 将 `dead_letter`/`retry_wait` 安全地重新置为 `pending`；
- 保留原失败历史；
- 不允许从请求体注入路径、命令、prompt 或项目配置。

模拟事件接口继续只用于本地测试；如后续开放人工重试 HTTP 接口，应另加本地授权或显式开发开关。

## 错误分类与日志

日志采用结构化、脱敏字段，至少包括事件 ID 的稳定摘要、表/记录摘要、决策、投递状态、尝试次数、错误码、Taskboard 任务标识和耗时。

禁止记录：

- `FEISHU_APP_SECRET`；
- 完整请求凭据；
- 任意用户提供的 shell 命令或 prompt；
- 不必要的绝对工作区路径。

## 测试与验收

新增或更新自动化测试覆盖：

1. 临时 Taskboard 错误会写入 `retry_wait` 并按计划再次处理；
2. 超过最大次数后进入 `dead_letter`；
3. 确定性 blocked/ignored 结果不会反复重试；
4. Bridge 重启或 processing 租约过期后可以恢复；
5. 两个并发 worker 不能同时领取同一事件；
6. 已存在的 Taskboard 任务在重试时被复用；
7. WebSocket 启动失败、断线和停止分别触发正确的重连/取消行为；
8. `/health` 返回队列和 listener 的脱敏状态；
9. 现有模拟流程、字段筛选、别名白名单和 loopback 约束保持通过。

验收标准：暂停 Taskboard 后发送一条匹配事件，恢复 Taskboard，事件最终只产生一张任务；重启 Bridge 后未完成事件继续处理；模拟或真实长连接断开后能够自动恢复；重放同一事件不会产生重复任务。

## 分阶段实施

### 阶段一：投递状态与补偿

- 扩展状态存储 schema 和原子 claim/lease；
- Bridge 引入有限重试、补偿 worker 和启动恢复；
- 增加状态统计和测试。

### 阶段二：长连接 supervisor

- 增加断线检测、退避重连、停止取消和 generation 防护；
- 扩展 `/health` 与检查脚本；
- 增加断线/重连测试。

### 阶段三：人工诊断与规模化优化

- 增加安全的人工重试入口；
- 评估 Taskboard 原生幂等查询；
- 根据事件量评估 JSON 到 SQLite 的迁移。

