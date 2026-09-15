# Auto-Cut 面板状态同步修复

**目标：** 本机执行时显示真实阶段与最终结果；完成、失败、中断后结束处理中提示。用户已确认阶段与结果展示方案。

**设计：** 复用 AiChat 的线程事件订阅与持久化历史，在本机 runner 的创建、准备、阶段变化、登记及结束时发布通知。只接收白名单阶段与状态，不保存原始 stderr、凭据或路径。旧的无事件线程从已有 run 状态生成终态展示，不修改历史数据。

**边界：** 不改变执行资格、loopback、自动执行开关、包白名单、专用凭据、任务/run 绑定、ZIP 哈希与回执校验。不重跑已完成的 FEI-29/FEI-30。

- [x] 后端回归：隔离任务打开线程订阅，推进受控 runner，验证阶段历史与成功/准备失败/运行失败/登记失败/中断通知；迟到事件不可恢复运行状态。
- [x] 实现：`ai-chat.mjs` 提供本进程的本机运行通知和安全进度登记；`app.mjs` 补齐生命周期调用；`autocut-local-runner.mjs` 解析真实阶段并保持预检超时保护。
- [x] UI 回归与实现：`AiChat.tsx` 显示 Auto-Cut 阶段及终态，兼容无事件历史；本机运行不展示 Codex 输入控件。保持普通对话行为。
- [x] 更新 README；执行 `node --test taskboard/test/autocut-local-runner.test.mjs taskboard/test/feishu-autocut-run-lifecycle.test.mjs taskboard/test/ai-chat-runner.test.mjs` 和根目录 `npm test`。
- [x] 独立代码评审并修复反馈，交付可评审源码；部署时先检查空闲与备份，按标准脚本重启并验证旧完成任务展示。

验证：根目录 npm test 通过（Node：1597 passed / 3 skipped；组件：68 passed；typecheck/build 通过）。独立评审提出的历史 completed + blocked 回执展示问题已通过只读快照投影修复，回归测试先失败后通过。首次全量测试遇到已有随机端口 bad port 问题，完整重跑通过。

