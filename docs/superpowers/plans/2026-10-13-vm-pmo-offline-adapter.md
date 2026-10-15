# VM / PMO 离线协议与包适配

日期：2026-10-13。范围：只验收本机合成媒体，不启用生产 VM 流程。

## 目标

以一个无凭据的初稿样例贯通 Taskboard 受信 runner 与 `auto-cut-slicing` 独立 `plan/render` 入口。输入只支持单源、单成片、明确时间范围，输出为 1920x1080、25 fps、保留原音的 MP4。未知或需要语音/画面证据的意见必须阻断，不能只截取已识别部分后报成功。

## 实施顺序

- [x] 核对双方现有入口、门禁和 720p/1080p 及静帧语义差异。
- [x] 冻结 v1 的 input、context、plan、plan-result、result 字段和无凭据样例。
- [x] 在剪辑包增加独立协议入口，复用统一 planner/render，保持原 `run` 兼容。
- [x] 在 Taskboard 增加离线 runner 和独立回执/媒体校验；不接入 Bridge、活动配置或自动执行。
- [x] 用合成媒体跨工作区联调成功和拒绝路径，执行双方测试并复核代码。
- [x] 根据实际接口更新 README 和接入文档，记录生产接入尚缺任务/审批绑定、审核轮次、附件读回与回写。

## 验收记录

- 剪辑包完整回归：`python -m pytest -q --basetemp .local/test-vm-pmo-final --tb=short`，320 项通过、退出码 0；定向 VM 测试 20 项通过，Ruff 通过。
- Taskboard 离线 runner/validator：34 项中 33 项通过、0 失败，1 项因 Windows 文件符号链接权限跳过；目录 junction 越界用例通过。
- Taskboard 工作流门禁及配置草稿回归：51 项通过、0 失败。
- `scripts/check-vm-pmo-offline.mjs` 调用真实剪辑包的 12 项合成媒体检查通过、退出码 0。报告位于被忽略的 `.runtime/vm-pmo-offline/run-6mz5Eo/verification.json`，`production_enabled` 为 false。
- 复审发现的外部清单引入未绑定素材、过短音轨、子进程改写输入/context 重绑任务三个问题已修复并通过回归；最终独立复审无剩余阻断问题。
- 双方文档与实现已对齐，语法及 diff 检查通过。生产入口与包能力声明未在本阶段开放。

下一阶段是将独立审批下载队列绑定受控 task/run，持久化等待、拒绝、超时和恢复状态；之后补齐带证据编辑、审核 parent、附件上传读回及剪辑中/完成回写。

## 边界

`PACKAGE_WORKFLOW_NOT_READY` 保持有效。离线样例不能申请 VM、下载生产视频、创建受控任务、上传附件或写 PMO。模拟事件不能取得真实执行资格。生产接通另需按根 `AGENTS.md` 更新测试及 README，在测试表/示例项目验证并经评审后合并。
