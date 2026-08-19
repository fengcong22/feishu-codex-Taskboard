# Feishu Bridge README Showcase Design

## Goal

把 README 从仅供运维交接的说明升级为“项目展示 + 技术交接”首页，让团队和 GitHub 访客快速理解真实能力、数据流和运行方式。

## Design

- 顶部使用中文项目标题、英文副标题和简短定位。
- 用 Mermaid 展示飞书多维表格、官方 SDK、Bridge、Taskboard 和 Codex 的数据流。
- 使用真实 Taskboard 看板截图作为界面展示，图片保存为 `docs/assets/taskboard-kanban-demo.jpg`，并明确标注为本地测试数据。
- 增加真实能力表格，明确事件接收、筛选标准化、幂等去重、任务创建和健康检查；不把 Taskboard 的手动启动或网页进度写成 Bridge 能力。
- 增加完成本地配置后的 5 分钟快速体验，链接现有启动、检查和模拟脚本，并说明示例配置和模拟事件需要匹配。
- 保留配置、安全、团队交接和当前边界；明确自动启动、回写、真实视频剪辑、SDK 自动重连/退避、定时补偿和高可用尚未提供。
- 不新增或嵌入未经确认版权的宣传图片，不宣称截图中的自动配音、导出等未实现能力。

## Acceptance

- README 包含标题、能力表、Mermaid 数据流、界面展示、完成本地配置后的快速体验、AGENTS.md 链接和限制说明。
- `npm test` 全部通过。
- 变更只涉及 README 及其测试/文档，不修改运行逻辑或本地配置。
