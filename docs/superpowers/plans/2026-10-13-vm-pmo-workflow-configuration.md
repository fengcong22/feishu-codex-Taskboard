# VM / PMO 流程配置与滚动修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 VM 来源归入学科 PMO，补齐初稿/审核意见与阶段回写草稿，修复配置页遮挡和滚动。

**Architecture:** 复用独立学科/包/模板草稿和 revision。扩展 VM 草稿的可选阶段字段，旧配置读取时补齐默认值；真实启用继续受运行时门禁限制。共享 Shadow 会话和独立下载队列保留在本机设置，手工输入收为补救入口。

**Tech Stack:** Node.js 22.13+、node:sqlite、React/TypeScript、CSS、node:test、Vitest/jsdom。

**Spec:** `docs/superpowers/specs/2026-10-09-vm-pmo-review-video-interface-draft.md` 第 1、3.1、3.2 节；`docs/superpowers/specs/2026-10-12-vm-download-panel-design.md`。

## Global Constraints

- 保留 `codex/vm-pmo-video-editing` 中全部既有未提交修改；不重置、暂存、提交或合并。
- Bridge 和 Taskboard 只绑定 `127.0.0.1`；普通及模拟来源不能获得自动执行资格。
- 新 VM 包当前仍为配置预览；不删除 `PACKAGE_WORKFLOW_NOT_READY` 保护，不发真实审批、消息或 PMO 写入。
- 初稿读取原视频 VMID；审核基于上一轮成片，不能重套首剪范围。
- 单选进入配置选项、多选从不包含变为包含配置选项才触发。执行门禁未接通前不改变生产事件筛选。
- 开始回写只发生于真实启动；完成回写只发生于 MP4 附件上传、绑定并读回确认后。
- 只引用已存在字段/选项，字段 ID 不是路径或命令，凭据不进入配置、日志或 Git。

## Task 1: 学科来源与共享队列归属

**Files:** `taskboard/web/src/components/FeishuVmPmoWorkflowEditor.tsx`、`VmDownloadsPanel.tsx` 及对应组件测试。

**Interfaces:** 继续使用 `fields.vmidFieldId`、`approval.department/reason`，保存参数为 subjectKey、packageAlias、expectedRevision；全局沿用 `/api/local/vm-downloads`。

- [x] 先写行为测试：视频来源选择真实文本字段；保存只改当前学科/包/revision；全局默认不显示 VMID 输入。
- [x] 运行失败测试，确认缺少来源组和补救表单未折叠。
- [x] 将 VMID 与申请信息放入「视频来源」；全局改为「VM 账号与队列」，手工表单折叠。
- [x] 复跑相关组件测试，保留原账号、队列、错误和批量下载操作。

## Task 2: 三阶段意见与回写草稿

**Files:** `taskboard/server/feishu-package-workflow-drafts.mjs`、`taskboard/web/src/types.ts`、`FeishuVmPmoWorkflowEditor.tsx` 及对应 Node/组件测试。

**Interfaces:** 每阶段保留三键，新增可选 `instructionFieldId: string|null` 与 `writeback.processing/completed: {fieldId:string|null,optionId:string|null}`；缺省归一化为空。null 意见字段沿用初稿 `keepSegmentsFieldId` 或审核 `reviewTextFieldId`。进度接受一致的 type3/SingleSelect 或 type4/MultiSelect 元数据；回写仅接受单选元数据。

- [x] 先写测试，用旧三键阶段保存并读取归一化结果；验证新字段按 revision 隔离。
- [x] 先写测试，用多选进度与不同阶段意见、回写设置保存；错误类型、矛盾 type/uiType、未知字段和选项拒绝。
- [x] 实施兼容归一化与严格 metadata 校验，保持启用门禁。
- [x] 增加三阶段 UI，选择字段时清除旧选项，空字段时选项禁用；初稿与审核展示对应素材/意见/交付语义。
- [x] 运行 Node 草稿测试、组件测试与 typecheck，检查没有改动活动配置或真实回写。

验收形状示例：

```js
assert.deepEqual(saved.config.stages.initial.writeback, {
  processing: { fieldId: 'fld_status', optionId: 'opt_processing' },
  completed: { fieldId: 'fld_status', optionId: 'opt_delivered' },
});
assert.equal(saved.config.stages.first_review.instructionFieldId, 'fld_review');
await assert.rejects(enableVmDraft(), error => error.code === 'PACKAGE_WORKFLOW_NOT_READY');
```

## Task 3: 实际内容滚动容器

**Files:** `taskboard/web/src/styles.css`、`taskboard/test/feishu-configuration-layout.test.mjs`。

**Interfaces:** 保留 `.feishu-configuration-stack` 范围；表单 flex column，固定块不缩小，`.feishu-settings-tabpanel` 独立增长/缩小/滚动，矮窗口由表单纵向滚动兜底。

- [x] 在 ZIP/VM、有/无刷新反馈 DOM 中建立回归，并确认旧样式失败。
- [x] 移除依赖孩子数量的 grid 行模板，增加内容最小高度和表单兜底滚动。
- [x] 运行布局回归，确认标签栏和动作栏不 shrink。
- [x] 实际浏览器验证宽屏、窄屏和短高度：标签与正文无重叠、正文到底后最后阶段和保存按钮可见。

## Task 4: 文档、评审与本机交付

**Files:** `README.md`、`docs/vm-source-acquisition.md`、上述两个 spec；验收记录放被忽略的 `.runtime/`。

- [x] 明确本机账号/队列与学科来源职责，以及初稿、审核和回写时机。
- [x] 复核最终改动与备份版本；完成独立代码评审。
- [x] 用独立 SQLite、假学科、空进程环境、自动执行关闭、Bridge sync stub 和随机 loopback 端口运行 fixture。
- [x] 运行相关测试、typecheck 和独立目录构建；真实浏览器截图验收后更新本机静态资源。
- [x] 最终报告区分已实现配置与仍需接通的运行/附件交付，不把草稿保存称为全链路成功。

2026-10-13 本机验收：Node 2106 通过、7 跳过、0 失败；组件 211 通过，typecheck 与构建通过。已完成私有增量冷备份与 38 张旧表、2 张 VM 表核对，保留 5 个 ready 下载结果。登记独立 `vm-pmo-preview` 草稿供学科表单选择，原包完整条目与 enabled 白名单不变；未保存或启用生产学科配置。详细记录及截图位于被忽略的 `.runtime/vm-config-ui-acceptance-20261013.md`。

## 实际执行接入的依赖

已找到 `E:/codex/Auto-cut-slicing-src` 的本地剪辑核心，但它的 `run` 协议与 `vm_pmo_review_video/v1` 不同，尚无独立 VM/PMO adapter 和已验收包身份。其接入文档要求 1080p25 成片、静帧操作和命名字段，与原草案的成片规格/操作有差异。注册受控运行前须冻结双方样例，不能将 preview 声明复制过去后直接启用。

Taskboard 还缺受控任务到 VM job 绑定、审核轮次、专用 MP4 runner 与附件交付队列。飞书官方 SDK 已提供普通与分片 media upload API，因此附件交付不是平台能力缺失。以上按协议/采集编排/交付三部分接入并用测试表验收，不在本轮 UI 草稿修复中冒充已实现。
