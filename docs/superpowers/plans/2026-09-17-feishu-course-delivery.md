# 飞书课程目录、回写与配置界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 实施环境若没有上述技能，按本计划逐项开发、验证和评审；不要把缺少技能当作要求用户重复批准的理由。

**Goal:** 为受控 Auto-Cut 工作流增加固定课程目录、按阶段发布 ZIP、已有飞书字段回写和独立 `00成片` 触发，并整理学科与项目包配置界面。

**Architecture:** Taskboard 持有课程目录绑定、运行产物清单、上传结果和持久化副作用队列；Bridge 接收官方事件、验证活动规则，保有飞书凭据并执行受控记录更新。所有配置与业务快照都按版本保存；运行事件产生队列记录的事务必须与对应本地状态落库处于同一事务。界面从相同服务端校验结果显示配置、运行与回写状态。

**Tech Stack:** Node.js `>=22.13`、ES modules、现有 SQLite database 层、`@larksuiteoapi/node-sdk`、React 19、TypeScript、Node test runner、Vitest / Testing Library、Windows PowerShell。

## Global Constraints

- 配套规格：`docs/superpowers/specs/2026-09-17-feishu-course-delivery-design.md`。本文件是待执行计划，本轮只交付准备材料。
- Bridge 和 Taskboard 只绑定 `127.0.0.1`；不引入公网或 LAN 接口，Bridge 不启动 Codex。
- 真实凭据、机器路径配置和运行状态继续留在现有忽略文件，不写入测试 fixture、文档或 Git；下面路径均为示例。
- 普通任务、伪造描述标签和模拟来源不获得真实上传、回写或 NAS 建目录资格；单元测试使用注入的假依赖与临时目录。
- 自动运行仍要求本机开关、专用来源、automatic 快照、启用的包白名单；手工启动的可信任务同样可使用已配置回写规则。
- 需要课程目录的新版配置，在第一条可信阶段事件或 `00成片` 事件固定逻辑课程绑定；实际目录按需要创建，不预建三个阶段目录。仅状态回写且未启用上传/目录触发的配置不要求目录绑定。
- 初稿、初审修改、终审修改的文件夹分别固定为 `01初稿`、`02初审`、`03终审`。
- 首个成功 ZIP 触发课程路径回写；同一 run 的最终 ZIP 清单全部上传成功才触发该阶段完成回写。
- 映射盘/UNC 的回写路径去掉服务器，保留共享名到课程目录；纯本地盘回写去盘符后的课程目录，不能伪造共享名。必须区分本地磁盘与不可解析/断开的网络映射，后者不能降级成去盘符的本地路径。
- 不创建飞书字段或单选选项；保存稳定字段/选项 ID，通过真实元数据验证，并在官方 SDK 适配器边界转换为实际 API 要求的表示。
- 不覆盖目标同名异内容 ZIP，不自动换名；至少一次投递、有限重试、可见失败，不宣称 exactly-once。
- 新资源锁快照来自 Auto-Cut 包；阶段任务同包并发上限继续为 1。锁范围是同一 Taskboard 调度器，不是跨机器全局锁。
- 涉及筛选、路由或凭据的每批变更同时更新测试与 README；测试表/示例项目联调、代码评审后才能合并。

---

## 批次、依赖与执行约定

| 批次 | 任务 | 可评审交付 | 依赖 |
| --- | --- | --- | --- |
| A | 1–3 | 配置契约、草稿/启用边界、包资源迁移 | 无 |
| B | 4–5 | 课程绑定、安全路径和按阶段上传 | A |
| C | 6–8 | 持久化回写、成片目录触发、结果 API | A、B |
| D | 9–10 | 分区配置、固定名称、可见结果和针对性重试 | A–C |
| E | 11–12 | 迁移演练、测试表/NAS 联调、文档与评审 | A–D |

每项先添加行为测试并看到预期失败，再写实现；测试执行到通过后停止无关扩大验证。下面提议的新文件、函数、数据库方法和路由均明确标为“计划新增”，不能当成仓库已经存在的能力。测试代码片段是代表性断言与接口契约；同一任务中的用例表必须全部覆盖。每批可保持功能未启用，以便独立审查；不得让新界面提前发出服务端尚不理解的配置。

所有命令从 `D:\codex\codex-feishu` 执行。首次实施时先 `git status --short`，保留用户已有改动，再创建 `codex/feishu-course-delivery` 工作分支。本文不要求现在创建分支、运行服务或提交。

## 契约目录（计划新增）

新代码优先放在职责单一的模块，避免继续把路径、SDK 和 worker 逻辑全塞入 `database.mjs` / `app.mjs`。

| 模块 | 职责 |
| --- | --- |
| `taskboard/shared/feishu-delivery-config.mjs` | 新配送字段的纯结构规范化、阶段目录常量、校验问题结构；Bridge 与 Taskboard 共用 |
| `taskboard/server/feishu-course-path.mjs` | 课程名称校验、映射盘解析、课程路径预览、目录安全检查 |
| `taskboard/server/feishu-delivery-store.mjs` | 使用 Taskboard 原有 SQLite 连接/事务实现绑定、run 清单、outbox、目录操作仓储 |
| `taskboard/server/feishu-delivery-worker.mjs` | 回写/目录操作 claim、租约、退避、失效判定、结果持久化 |
| `taskboard/server/feishu-writeback-client.mjs` | Taskboard → Bridge 的认证 loopback 更新调用 |
| `src/feishu-record-writer.mjs` | 元数据 ID 校验、远端当前值检查、SDK record update、错误脱敏 |
| `taskboard/server/feishu-delivery-api.mjs` | 路径预览/测试、结果查询、单项重试的本机 API |
| `taskboard/web/src/components/FeishuStorageSection.tsx` | 上传总路径、课程命名、预览 |
| `taskboard/web/src/components/FeishuWritebackSection.tsx` | 三阶段处理中/上传完成规则及课程路径目标 |
| `taskboard/web/src/components/FeishuExtraTriggerSection.tsx` | `00成片` 规则和操作记录 |
| `taskboard/web/src/components/FeishuDeliveryStatus.tsx` | 分开显示编辑、上传、状态回写、路径回写 |

### 统一的建议配置形状

字段名可在任务 1 的评审中调整一次，但两端、快照、共享导入导出和 UI 必须同步，后续任务不能自行换名。

```js
const delivery = {
  version: 1,
  rootPath: 'W:\\【--剪映草稿--】',
  courseNaming: { mode: 'reuse_artifact_naming', fieldId: null },
  coursePathWriteback: { enabled: true, fieldId: 'fld_course_path' },
  writeback: {
    initial: {
      onProcessing: [{ fieldId: 'fld_state', optionId: 'opt_editing' }],
      onUploaded: [{ fieldId: 'fld_state', optionId: 'opt_initial_ready' }],
    },
    first_review: { onProcessing: [], onUploaded: [] },
    final_review: { onProcessing: [], onUploaded: [] },
  },
  finalDirectoryTrigger: {
    enabled: false, fieldId: null, optionId: null,
  },
};
```

`courseNaming.mode = 'field'` 时必须指定 `fieldId`，且文本/公式结果最终为一个非空文本。ZIP 命名与课程目录命名仍是两项概念。`delivery` 缺失表示旧配置兼容模式，禁止仅靠推算父目录自动转换不同的旧阶段上传路径。

开关关系：`delivery.version = 1` 标识新版策略，只有应用后的活动配置产生行为；现有 `upload` 对象计划新增 `enabled` 表示是否上传 ZIP，默认迁移值不改变旧活动配置。`upload.enabled=false` 时仍可配置处理中状态回写及独立 `00成片`。仅处理中回写时目录配置可缺省；上传或成片触发任一启用时，激活必须有根目录与课程命名。`coursePathWriteback.enabled=true` 或任一 `onUploaded` 非空时要求 `upload.enabled=true`，否则定位为激活错误，不静默忽略已勾选规则。禁用上传不改已冻结的运行/上传任务，不新增第二个整页能力总开关。

### 跨任务完整方法契约（均为计划新增）

`identity` 为 `{ baseToken: string, tableId: string, recordId: string }`，`binding` 包括 `id, identity, rootPath, resolvedUncRoot, courseName, coursePath, displayPath`。仓储 `store` 使用现有 SQLite 连接；以下方法返回已解析对象，不把 SQLite row JSON 字符串泄露给 UI。

| 调用 | 签名与返回 |
| --- | --- |
| 事实查询 | `store.listDeliveryFacts(runId: string) -> Array<{ id, kind, runId, bindingId }>`，kind 为 `course_path | stage_uploaded | processing` |
| 上传汇总 | `store.getRunDeliveryProgress(runId: string) -> { finalized: boolean, total: number, uploaded: number, allUploaded: boolean }` |
| 操作查询 | `store.listDeliveryOperations({ subjectKey?: string, kind?: string, runId?: string }) -> DeliveryOperation[]` |
| 事实记录 | `store.recordDeliveryFact({ dedupeKey, kind, runId, bindingId, snapshot }) -> DeliveryFact`，必须在调用方事务内执行 |
| 集合冻结 | `store.finalizeRunArtifacts(runId: string, artifactIds: string[], finalizedAt: string) -> RunManifest`，非空，冻结后内容不同为冲突 |
| 绑定查询 | `store.findCourseBinding(identity) -> binding | null` |
| 原子事务 | `store.transaction(callback: () => T) -> T`，复用现有连接，外部 I/O 不在事务回调内 |
| Bridge 写入 | `writer.apply(operation: DeliveryOperation) -> Promise<{ operationId: string, status: 'succeeded' | 'conflict', fieldResults: Array<{ fieldId: string, status: 'updated' | 'unchanged' | 'conflict' }> }>` |
| 本机写客户端 | `client.apply(operation: DeliveryOperation)` 仅发送 `operationId/claimToken/version`，与 `writer.apply` 返回类型一致；协议异常抛安全 code |
| 权威写上下文 | `store.getWritebackContext({ operationId, claimToken, version }) -> WritebackContext`，校验租约、来源、运行事实、字段代号和配置栅栏后返回冻结的意图与发送许可；失效抛安全 code |
| 目录依赖 | `directories.ensureFinal(binding) -> Promise<{ directory: string, created: boolean }>` |
| UI 重试 | `retryDeliveryOperation(operationId: string, expectedVersion: number) -> Promise<DeliveryOperation>`，测试传明确版本 |
| UI 旧动作 | `startAutoCut`、`enqueueArtifactUpload` 测试 spy 包装当前组件已有执行/上传回调，断言重试不调用；不新增另一套执行入口 |

`DeliveryOperation` 是任务 6 所列表字段的 JS camelCase 表示；增加 `version: number`、`runGeneration: number | null`、`eventRank: number` 与 `assignments: Array<{ fieldId, optionId?, text?, expectedValue }>`。对象必须具备可信来源与冻结配置版本；课程路径或目录操作另须绑定引用，纯状态回写允许 `bindingId: null`；缺必要来源的数据不得到达 writer。`WritebackContext` 为 `{ operation: DeliveryOperation, sendPermit: { token, configEpoch, expiresAt } }`，仅可通过专用认证内部接口获取。

## Task 1：配置结构、校验模式与共享导入迁移

**Files:**

- 计划新增：`taskboard/shared/feishu-delivery-config.mjs`、`taskboard/test/feishu-delivery-config.test.mjs`。
- 修改：`src/workflow-config.mjs`、`src/workflow-config-store.mjs`、`taskboard/server/feishu-workflow-stages.mjs`、`taskboard/server/feishu-workflow-store.mjs`、`taskboard/web/src/types.ts`、`README.md`。
- 扩展测试：`test/workflow-config.test.mjs`、`test/workflow-config-api.test.mjs`、`taskboard/test/feishu-workflow-store.test.mjs`、`taskboard/test/feishu-workflow-api.test.mjs`。

**Interfaces:** 计划新增 `normalizeDeliveryConfig(value)` 与 `validateDeliveryConfig(value, { mode, fields, stages, activeSubjects, pendingSnapshots }) -> { value, issues }`；`mode` 仅为 `draft | activation`，`issues` 每项为 `{ code, path, section, message }`。草稿允许业务信息缺失，但始终拒绝未知键、错误类型、非法路径片段；激活检查当前元数据、启用阶段和所有回写目标。相同事件重复写同一字段属于冲突配置，不按数组顺序覆盖；触发/回写冲突校验横跨同 Base/表的全部活动学科配置及仍可能发送回写的未结束任务快照/待办。历史意图已全部成功或被撤销后不再占用冲突检查集合。

- [ ] 添加代表性测试及未知键、文本/公式类型、只读文本目标、缺失选项、禁用阶段保留值等用例。

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDeliveryConfig } from '../shared/feishu-delivery-config.mjs';

test('incomplete delivery is saveable as a draft but cannot activate', () => {
  const input = { version: 1, enabled: true, rootPath: null, courseNaming: { mode: 'field', fieldId: null }, finalDirectoryTrigger: { enabled: true, fieldId: null, optionId: null } };
  assert.equal(validateDeliveryConfig(input, { mode: 'draft', fields: [], stages: {} }).issues.length, 0);
  const active = validateDeliveryConfig(input, { mode: 'activation', fields: [], stages: {} });
  assert(active.issues.some(issue => issue.path === 'delivery.rootPath'));
  assert(active.issues.some(issue => issue.path === 'delivery.courseNaming.fieldId'));
});
```

- [ ] 执行 `node --test taskboard/test/feishu-delivery-config.test.mjs`，预期先因新模块不存在失败。
- [ ] 增加规范化/校验实现并接入两端；草稿校验与激活校验走不同入口。核心顺序为 `assertKnownKeys → normalizeTypes → collectStructuralIssues → if draft return → if delivery disabled return → check enabled dependencies → metadata checks → cross-subject trigger checks`。共享导出擦除机器总路径，导入保持待修复草稿，不执行副作用；旧字段保留兼容读取。同批更新 README，清楚区分新草稿契约和尚未启用的运行行为。
- [ ] 执行 `node --test taskboard/test/feishu-delivery-config.test.mjs test/workflow-config.test.mjs test/workflow-config-api.test.mjs taskboard/test/feishu-workflow-store.test.mjs taskboard/test/feishu-workflow-api.test.mjs`，预期全部通过，失败激活保留旧活动配置。
- [ ] 核对范围后暂存以上确切文件，提交 `feat: define course delivery configuration and draft validation`。

## Task 2：已有单选选项与命名字段元数据

**Files:** 修改 `src/feishu-base-metadata.mjs`、`src/feishu-record-reader.mjs`、`taskboard/server/feishu-workflow-stages.mjs`；扩展 `test/feishu-base-metadata.test.mjs`、`test/feishu-record-reader.test.mjs`、`test/phased-bridge.test.mjs`。

**Interfaces:** 扩展现有受控上下文读取结果，增加 `courseName: string`（存在既有绑定时不再要求按当前命名字段重算）；只请求白名单字段。计划新增纯方法 `normalizeCourseNameValue(value, field) -> string`，文本数组仅允许还原为一个文本，公式数组/数值/错误/空值安全阻断，不调用 shell。

- [ ] 新增以下断言，并覆盖字段改名但 ID 不变、选项删除、公式值变空、公式结果读取需现有 fallback scan 的情况。

```js
assert.equal(normalizeCourseNameValue([{ type: 'text', text: '课程001' }], { type: 1 }), '课程001');
assert.throws(() => normalizeCourseNameValue(123, { type: 20 }), { code: 'COURSE_NAME_NOT_TEXT' });
assert.throws(() => normalizeCourseNameValue('../课程001', { type: 1 }), { code: 'COURSE_NAME_INVALID' });
```

- [ ] 执行 `node --test test/feishu-base-metadata.test.mjs test/feishu-record-reader.test.mjs test/phased-bridge.test.mjs`，确认新增断言先失败。
- [ ] 实现字段类型约束与受控读取；配置只选已有单选字段/选项、可写文本字段；不把前端 `uiType` 当作唯一可信类型依据。
- [ ] 提前核对官方 SDK 更新字段的类型定义与文档，记录字段/选项的 wire 形式及是否存在隐式新增选项行为；不访问生产记录。任务 7 负责实现适配和测试表协议验证，不能在前端设计时假定 ID 可直接传入 API。
- [ ] 重跑同一命令，预期原公式命名回归及新约束全部通过；提交 `feat: validate existing Feishu writeback and course naming fields`。

## Task 3：Auto-Cut 包资源与单一 ZIP 来源

**Files:** 修改 `taskboard/server/feishu-package-config.mjs`、`taskboard/server/feishu-package-api.mjs`、`taskboard/server/database.mjs`、`taskboard/server/feishu-execution-coordinator.mjs`、`taskboard/server/feishu-run-inputs.mjs`、`taskboard/server/app.mjs`、`src/package-config.mjs`、`config/autocut-packages.example.json`；扩展 `taskboard/test/feishu-package-config.test.mjs`、`taskboard/test/feishu-package-api.test.mjs`、`taskboard/test/feishu-execution-coordinator.test.mjs`、`taskboard/test/feishu-autocut-run-lifecycle.test.mjs`、`test/package-config.test.mjs`。

**Interfaces:** 包增加 `resourceGroups: string[]`，规范化 trim/去重，空数组为默认；新任务包快照记录资源名。调度 group 继续 `autocut:<alias>`，阶段任务 `fixedMaxConcurrent: true, maxConcurrent: 1`；非阶段任务继续现有读取当前包并发策略。旧任务没有新快照时读取旧 origin 锁，不清空。

- [ ] 编写“不同包同资源不能同时进入执行”“阶段包即便 maxConcurrent=3 仍串行”“改包资源只影响新快照”“旧 subject 锁不会消失”“旧排队/运行任务快照不变”测试。

```js
assert.deepEqual(newTaskPackageSnapshot.resourceGroups, ['剪映主机']);
assert.equal(stageRequest.concurrencyGroup, 'autocut:Auto-cut-A');
assert.equal(stageRequest.maxConcurrent, 1);
assert.equal(stageRequest.fixedMaxConcurrent, true);
assert.deepEqual(oldQueuedTaskOrigin.resourceGroups, ['legacy-resource']);
```

- [ ] 执行 `node --test taskboard/test/feishu-package-config.test.mjs taskboard/test/feishu-package-api.test.mjs taskboard/test/feishu-execution-coordinator.test.mjs taskboard/test/feishu-autocut-run-lifecycle.test.mjs test/package-config.test.mjs`，确认新增行为失败。
- [ ] 实现包字段、API 白名单和快照；新配置从包继承 ZIP 来源，协调 `app.mjs` 的来源相等校验与 `resolveFeishuPackageSourceDirectory`，避免只隐藏输入导致旧后端拒绝运行。历史学科锁非空时按同包并集形成迁移候选，列出来源供确认后再激活，禁止静默丢锁或自动扩大到所有包。检测旧自定义并发组，跨包共用旧组必须保留兼容约束，转换成包独占资源规则并验证后才能解除旧约束。
- [ ] 重跑上述测试；同时更新 README 的资源所有权、同机范围和阶段并发说明；提交 `feat: move execution resources and ZIP source ownership to packages`。

## Task 4：安全课程路径与持久化绑定

**Files:** 计划新增 `taskboard/server/feishu-course-path.mjs`、`taskboard/server/feishu-delivery-store.mjs`、`taskboard/test/feishu-course-path.test.mjs`、`taskboard/test/feishu-course-binding.test.mjs`；修改 `taskboard/server/database.mjs`、`src/task-payload.mjs`、`src/bridge.mjs`、`taskboard/server/app.mjs`。

**Interfaces:**

- `previewCoursePath({ rootPath, courseName }, { resolveMappedDrive, classifyDrive }) -> Promise<{ actualRoot, coursePath, displayPath, pathKind }>`，只读，不 mkdir；本地盘返回去盘符后的显示值。`classifyDrive(rootPath) -> Promise<'local' | 'network' | 'unknown'>` 读取系统磁盘类型；`resolveMappedDrive(rootPath) -> Promise<string | null>` 读取网络映射。network 无映射或 unknown 都阻断，不当成本地盘。真实映射解析只有显式检查时执行；实时示例预览仅使用已读映射信息，不访问 NAS。
- `ensureCourseBinding({ identity, subjectVersion, namingValue, resolvedPaths, trustedEventId }) -> binding`，键为 Base/table/record；绑定字段含实际绝对根、课程名、实际课程路径、展示路径、首次版本与事件。另持久化 `canonicalLocationKey`：网络用解析后规范 UNC，本地用规范卷位置和路径，统一 Windows 大小写/分隔符；唯一约束防止不同盘符/直接 UNC 别名绕过同名检查。服务器别名/DFS 无法解析时限制配置为同一规范共享入口或阻断，不许宣称可以识别所有物理别名。
- `ensureStageDirectory(binding, stageId)` / `ensureFinalDirectory(binding)`，只允许固定子目录，根必须事先存在；首次可信登记建立逻辑绑定但不建目录。

- [ ] 添加路径纯测试，映射盘解析依赖使用假数据；增加保留共享名、纯本地盘、映射盘断开、UNC 根、非法 Windows 名称、尾空格/点、大小写碰撞、超长路径、目录链接逃逸及名称后改不搬迁的用例。

```js
const resolved = await previewCoursePath(
  { rootPath: 'W:\\【--剪映草稿--】', courseName: '课程001' },
  { resolveMappedDrive: async () => '\\\\nas.example\\学科实拍素材临时传输', classifyDrive: async () => 'network' },
);
assert.equal(resolved.displayPath, '学科实拍素材临时传输\\【--剪映草稿--】\\课程001');
assert.equal(resolved.coursePath, 'W:\\【--剪映草稿--】\\课程001');
assert.equal((await previewCoursePath({ rootPath: 'D:\\交付', courseName: '课程001' }, {
  resolveMappedDrive: async () => null,
  classifyDrive: async () => 'local',
})).displayPath, '交付\\课程001');
await assert.rejects(() => previewCoursePath({ rootPath: 'W:\\交付', courseName: '课程001' }, {
  resolveMappedDrive: async () => null,
  classifyDrive: async () => 'network',
}), { code: 'NETWORK_ROOT_UNRESOLVED' });
```

- [ ] 执行 `node --test taskboard/test/feishu-course-path.test.mjs taskboard/test/feishu-course-binding.test.mjs`，预期新模块缺失失败。
- [ ] 建增量表 `feishu_course_bindings`；仅处理中回写且上传/目录触发均关闭时跳过绑定，允许 null 并覆盖登记/真实启动完整用例。需要目录时先查绑定，存在则直接复用，不再读取当前命名字段；不存在才取得白名单命名值/解析根，再同事务处理新任务可信登记/目录操作入队与绑定。事务内重新查绑定以处理并发。根/命名改变只影响未绑定记录。需要绑定却失败时阻断该副作用并保留可见错误，不把异常路径降级成当前工作目录。持久化解析的 UNC 位置，并在每次文件操作前检查盘符仍映射到同一位置；映射到共享子目录时保留该子目录及共享名。Windows 查询映射使用固定程序和结构化参数，绝不拼接单元格值成命令。
- [ ] 加入并发两事件争抢相同 record、不同 record 同名、W:/V:/直接 UNC 同位置碰撞、数据库重启、预览零写入断言；运行上述测试与 `node --test taskboard/test/feishu-database-migration.test.mjs test/phased-bridge.test.mjs`，预期全部通过。
- [ ] 同步根目录要求/惰性创建 README，提交 `feat: persist safe course directory bindings`。

## Task 5：阶段 ZIP 发布、完整路径与最终产物集合

**Files:** 修改 `taskboard/server/upload-worker.mjs`、`taskboard/server/database.mjs`、`taskboard/server/app.mjs`、`taskboard/server/artifact-service.mjs`、`taskboard/server/feishu-delivery-store.mjs`；扩展 `taskboard/test/artifact-upload-queue.test.mjs`、`taskboard/test/artifact-upload-lease.test.mjs`、`taskboard/test/feishu-autocut-run-lifecycle.test.mjs`；计划新增 `taskboard/test/feishu-delivery-manifest.test.mjs`。

**Interfaces:**

- 每 run 冻结 `artifactIds` 与 `manifestFinalizedAt`；只有明确完成产物发现并校验后才能 finalize。零 ZIP 不算交付完成。晚到 ZIP 不静默插入已完成集合，应显式重新核对 run。
- 扩展现有 `markArtifactUploadUploaded` 接受 `{ publication: { destination, sha256, created } }` 并保存 `published_path`；原有 lease token / provenance 检查继续执行。
- 在同一事务产生 `course_path`（绑定首次成功 ZIP）和 `stage_uploaded`（非空最终集合全部成功）事实，后续任务 6 从事实生成 outbox；不能依赖 SSE `onUpdate`。

- [ ] 编写最小两 ZIP 用例：一个成功而另一个未排队，课程路径事实为 1、阶段完成事实为 0；第二个成功后阶段完成为 1。再次提交成功、丢失响应后重试都不重复事实。

```js
assert.equal(store.listDeliveryFacts(run.id).filter(x => x.kind === 'course_path').length, 1);
assert.equal(store.listDeliveryFacts(run.id).filter(x => x.kind === 'stage_uploaded').length, 0);
assert.deepEqual(store.getRunDeliveryProgress(run.id), {
  finalized: true, total: 2, uploaded: 1, allUploaded: false,
});
```

- [ ] 执行 `node --test taskboard/test/feishu-delivery-manifest.test.mjs taskboard/test/artifact-upload-queue.test.mjs taskboard/test/artifact-upload-lease.test.mjs`，确认新增断言失败。
- [ ] 上传目标来自绑定与固定阶段名；仅准备实际上传的目录，禁止递归创建缺失总根。保存实际 publication 结果。同名同 hash 成功，不同 hash 为冲突；临时文件校验后原子不覆盖发布。NAS 不支持现有 hard-link 方法时返回明确的 `TARGET_ATOMIC_PUBLISH_UNSUPPORTED`；不改用可能覆盖的 rename/copy。

新增汇总纯函数 `summarizeRunDelivery(manifest: { finalizedAt: string | null, artifactIds: string[] }, uploads: Array<{ artifactId: string, status: string }>)`，供仓储汇总与投影共用，核心算法如下。上传查询须先按本 run、当前 binding 和目标路径过滤，不能混入旧上传结果。

```js
export function summarizeRunDelivery(manifest, uploads) {
  const expected = new Set(manifest.artifactIds);
  const successful = new Set(uploads.filter(row => row.status === 'uploaded').map(row => row.artifactId));
  const uploaded = [...expected].filter(id => successful.has(id)).length;
  const finalized = manifest.finalizedAt !== null;
  return { finalized, total: expected.size, uploaded, allUploaded: finalized && expected.size > 0 && uploaded === expected.size };
}
```
- [ ] 增加崩溃于“文件已发布、DB 尚未确认”的恢复、源 hash 变化、目标链接、失效 lease、来源撤销、root 断开测试。运行上述测试及 `node --test taskboard/test/feishu-autocut-run-lifecycle.test.mjs`，预期通过。
- [ ] 同步 README 的上传完成定义及 NAS 发布限制，提交 `feat: publish stage ZIPs and persist complete run delivery facts`。

## Task 6：持久化回写 outbox 与真实执行起点

**Files:** 修改 `taskboard/server/database.mjs`、`taskboard/server/feishu-delivery-store.mjs`、`taskboard/server/app.mjs`；计划新增 `taskboard/server/feishu-delivery-worker.mjs`、`taskboard/test/feishu-delivery-outbox.test.mjs`、`taskboard/test/feishu-delivery-worker.test.mjs`。

**Interfaces:**

- 表 `feishu_delivery_operations`：`id, dedupe_key, identity, task_id, run_id, binding_id, kind, sequence, run_generation, event_rank, snapshot_json, status, attempts, next_attempt_at, claim_token, lease_until, error_code, created_at, updated_at`。`status` 为 `pending | processing | retry_wait | succeeded | conflict | superseded | dead_letter`。
- `enqueueDeliveryOperation(input)`、`claimNextDeliveryOperation({ now, leaseMs })`、`renewDeliveryOperationLease(id, token)`、`completeDeliveryOperation(id, token, result)`、`failDeliveryOperation(id, token, error)`、`retryDeliveryOperation(id, expectedVersion)`，仓储必须在现有连接事务中可调用。
- `createFeishuDeliveryWorker({ store, writer, directories, clock, timers }) -> { start, wake, close }`；同记录串行；过期租约恢复；指数退避设上限与最大次数，确定性业务冲突不盲重试。

- [ ] 编写 outbox 测试：DB 状态事务回滚时没有副作用，commit 后重启可恢复；重复事实唯一；处理完后旧 lease 不能更新；重试次数有限；处理中序号低于已完成/新 run 的同字段规则变为 superseded；不同字段互不误丢弃。必须单独覆盖 run A 开始 → run B 开始 → A 才产生上传完成事实，A 即使取得更晚 outbox sequence 仍不得覆盖 B。

```js
const firstClaim = store.claimNextDeliveryOperation({ now: 1000, leaseMs: 500 });
assert.equal(firstClaim.attempts, 1);
assert.equal(store.claimNextDeliveryOperation({ now: 1200, leaseMs: 500 }), null);
const reclaimed = store.claimNextDeliveryOperation({ now: 1600, leaseMs: 500 });
assert.notEqual(reclaimed.claimToken, firstClaim.claimToken);
assert.equal(store.completeDeliveryOperation(reclaimed.id, firstClaim.claimToken, { status: 'succeeded' }), null);
```

- [ ] 执行 `node --test taskboard/test/feishu-delivery-outbox.test.mjs taskboard/test/feishu-delivery-worker.test.mjs`，确认预期失败。
- [ ] 将处理开始事实放在已确认执行及 `run.state=running` 持久化事务；同事务按记录分配 `runGeneration`，并为该运行所有可能写入的字段更新代号；处理中 `eventRank=1`、全上传完成 `eventRank=2`，两者复用 runGeneration，按二元组判新旧，outbox sequence 仅用于出队。课程路径独立版本域。当前 `in_progress` 可能是启动预约，不能直接监听所有状态 PATCH。覆盖 runner 启动失败、排队、普通手动拖动状态、模拟事件，均不发送处理回写。
- [ ] 用冻结的任务业务规则把任务 5 的事实转为 outbox。首 ZIP 事务固定一次性路径回写字段和值；首 ZIP 时未启用路径回写则不因以后启用而补写。每条远端字段赋值具有版本与检查结果：先删除已被新意图取代的赋值，全部被取代才标操作 superseded；其余字段继续。对剩余同组字段预检，任一人工冲突时整组暂停；响应不明逐字段核对，不把部分成功冒充整组成功。课程路径意图独立于阶段轮次，不因状态意图被取代而丢失。

新增 worker 纯函数 `remainingAssignments(operation, latestSequenceByField: Map<string, number>)`。`latestSequenceByField` 由仓储按同一记录、所有已登记 run 查询，仅适用于状态意图。worker 必须先得到过滤后的字段，再让 writer 整组预检；不能先发送旧字段后补做 superseded 判断。

```js
export function remainingAssignments(operation, latestSequenceByField) {
  if (operation.kind === 'course_path') return operation.assignments;
  return operation.assignments.filter(assignment =>
    (latestSequenceByField.get(assignment.fieldId) ?? operation.sequence) <= operation.sequence,
  );
}
```
- [ ] 重跑上述命令及 `node --test taskboard/test/feishu-autocut-run-lifecycle.test.mjs taskboard/test/feishu-execution-trigger.test.mjs taskboard/test/automatic-execution-setting.test.mjs`，预期通过；提交 `feat: persist ordered delivery writeback operations`。

## Task 7：Bridge 受控写接口与官方 SDK 适配

**Files:** 计划新增 `src/feishu-record-writer.mjs`、`taskboard/server/feishu-writeback-client.mjs`、`test/feishu-record-writer.test.mjs`、`taskboard/test/feishu-writeback-client.test.mjs`；修改 `src/feishu-api.mjs`、`src/index.mjs`、`src/server.mjs`、`src/workflow-config-store.mjs`、`taskboard/server/index.mjs`、`taskboard/server/app.mjs`、`taskboard/server/feishu-delivery-store.mjs`、`taskboard/server/feishu-workflow-store.mjs`；扩展 `test/server.test.mjs`、`test/feishu-api.test.mjs`、`taskboard/test/feishu-delivery-outbox.test.mjs`、`taskboard/test/feishu-workflow-api.test.mjs`。

**Interfaces:** 计划新增 `POST /api/feishu/workflow/writeback`，继续使用 `x-feishu-bridge-client` / `x-feishu-bridge-secret` 认证和 loopback 校验。请求只携带 `{ operationId, claimToken, version }`；Bridge 通过同样专用认证的 Taskboard `POST /api/local/feishu/writeback-context` 取得 `store.getWritebackContext` 返回值。上下文从持久化意图和可信任务来源取得 base/table/record/run/stage/assignments，校验租约、运行事实、字段代号、绑定和冻结配置后颁发发送许可，不能采信调用正文传入的目标或路径。活动触发配置提交与许可颁发共享表范围版本栅栏，许可处理期间不提交冲突触发规则；返回 `{ operationId, status, fieldResults }`，不返回 secret 或 SDK 原始异常。

- [ ] 先核对当前官方 SDK 的 record.update 及单选字段写入格式，保存无凭据的协议 fixture；**不要直接假设 option ID 可作为 API wire value**。单选展示名称变动时依稳定 ID 解析最新名称，已删除 option 阻断，不允许 API 隐式创建选项。
- [ ] 编写 writer/client/API 测试：漏密钥、伪 origin、历史配置不存在、未知字段、字段只读、option 不存在、请求对象/返回结构异常、429/5xx/网络超时、人工目标值变化、已为目标值幂等成功。测试请求夹带替换 record/run/binding/stage/文本被拒、过期 claim 或 superseded 字段拿不到发送许可、普通任务/模拟来源无法通过上下文读取。

```js
assert.deepEqual(await writer.apply(operationAlreadyAtTarget), {
  operationId: operationAlreadyAtTarget.operationId,
  status: 'succeeded',
  fieldResults: [{ fieldId: 'fld_state', status: 'unchanged' }],
});
assert.equal(sdkUpdateCalls.length, 0);
await assert.rejects(() => client.apply(invalidResponseOperation), { code: 'WRITEBACK_RESPONSE_INVALID' });
```

- [ ] 执行 `node --test test/feishu-record-writer.test.mjs taskboard/test/feishu-writeback-client.test.mjs test/server.test.mjs test/feishu-api.test.mjs`，确认新测试先失败。
- [ ] 实现预读/期望值策略：先前成功值或事件记录的基准值与当前值不符则标 conflict，整组暂停；读取与写入间无原子 CAS 时，在文档明确其竞态，不能声称绝对防止并发人工覆盖。超时请求先核对结果，同记录新赋值不越过未决发送；不得宣称租约能撤销已到飞书的 HTTP 请求。回写目标等于同 Base/表任一启用阶段触发 option 或 `00成片` 触发 option 时，激活报配置冲突。增加“旧任务快照完成值被新配置设为触发值”测试，激活检查未结束任务/待办，发送前检查当前规则；冲突阻断而不替换旧规则。剪辑进入与成片进入规则占用同字段同选项也应拒绝，不按配置顺序选动作。
- [ ] 更新 API 初始化注释与写权限错误信息，保留 SDK 静默 logger；重跑同一命令，预期通过。同步 README 和 AGENTS 中“当前不回写”条款为已实现的受控边界，提交 `feat: add authenticated Feishu record writeback adapter`。

## Task 8：独立成片目录触发与结果 API

**Files:** 修改 `src/decide-event.mjs`、`src/bridge.mjs`、`src/taskboard-client.mjs`、`src/state-store.mjs`、`taskboard/server/app.mjs`、`taskboard/server/feishu-delivery-worker.mjs`；计划新增 `taskboard/server/feishu-delivery-api.mjs`、`test/final-directory-trigger.test.mjs`、`taskboard/test/feishu-delivery-api.test.mjs`；扩展 `test/state-store-phased.test.mjs`、`test/compensation-worker.test.mjs`。

**Interfaces:** 计划新增 Taskboard 专用认证 `POST /api/local/feishu/directory-operations`，以 event ID + rule ID 幂等登记 `ensure_final_directory`。计划新增本机 `GET /api/local/feishu/delivery-operations?subjectKey=...`、`POST /api/local/feishu/delivery-operations/:id/retry`、`POST /api/local/feishu/delivery/preview`、`POST /api/local/feishu/delivery/test-write`。测试写入需明确用户点击，使用唯一临时测试名，仅清理自己的文件；预览始终只读。

- [ ] 编写进入指定 option 建目录、同值重放不新增、离开不删除、已有目录成功、事件先于任何阶段初始化绑定、Taskboard 不可用有持久化重试、不新建剪辑任务、不启动 Codex、模拟来源零真实文件写入测试。

```js
assert.equal(result.action, 'directory_operation');
assert.equal(taskboardCalls.createTask.length, 0);
assert.equal(directoryOperations[0].kind, 'ensure_final_directory');
assert.equal(store.listDeliveryOperations({ kind: 'course_path' }).length, 0);
assert.equal(codexStarts.length, 0);
```

- [ ] 执行 `node --test test/final-directory-trigger.test.mjs taskboard/test/feishu-delivery-api.test.mjs test/state-store-phased.test.mjs test/compensation-worker.test.mjs`，确认新增行为失败。
- [ ] Bridge 投递记账兼容事件产生多个确定动作，不让一个成片动作吞掉同事件的阶段归档/登记；动作持久化后才确认。目录 worker 仅创建绑定下 `00成片`。API 返回操作、状态、重试资格与错误码；单次重试不重跑剪辑/上传，不补扫历史记录。
- [ ] 重跑同一命令及 `node --test test/phased-bridge.test.mjs test/operations-hardening.test.mjs`，预期通过；同步 README/AGENTS 与示例规则，提交 `feat: handle final directory triggers without editing tasks`。

## Task 9：五区学科配置与固定流程名称

**Files:** 修改 `taskboard/web/src/components/FeishuWorkflowPanel.tsx`、`FeishuStageEditor.tsx`、`FeishuPackageManager.tsx`、`UnifiedWorkflowBoard.tsx`、`UnifiedWorkflowViewControls.tsx`、`taskboard/web/src/App.tsx`、`taskboard/web/src/api.ts`、`taskboard/web/src/types.ts`、`taskboard/web/src/styles.css`；计划新增契约目录中的三个配置 section 文件；修改 `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`、`taskboard/test/unified-workflow-view-controls.test.mjs`、`taskboard/test/feishu-workflow-ui.test.mjs`。

**Interfaces:** 组件按 `基础与执行 / 素材与阶段 / 存储与目录 / 飞书回写 / 额外触发` 分区，输入绑定共享 subject draft；`issues` 使用任务 1 的同一字段路径。新 section 都接收 `{ value, metadata, issues, onChange }`，不各自存储第二份配置。包管理增加 `resourceGroups`，显示阶段任务实际串行限制。

- [ ] 编写组件行为测试：点击任一学科只切换编辑对象；“查看任务”另走导航；草稿切换保留；离开未保存警告；字段改变清空已失效选项；禁用阶段不阻断启用；网络错误不同于空列表；刷新不清空编辑；启用失败保留旧活动版本。使用现有 `subject()` / `fields` fixture 扩展。

```tsx
fireEvent.change(screen.getByLabelText('处理中回写字段'), { target: { value: 'fld_other' } });
expect((screen.getByLabelText('处理中回写选项') as HTMLSelectElement).value).toBe('');
expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(false);
expect((screen.getByRole('button', { name: '应用并启用' }) as HTMLButtonElement).disabled).toBe(true);
expect(screen.queryByLabelText('流程名称')).toBeNull();
```

- [ ] 执行 `npm --prefix taskboard run test:components -- --reporter=dot`，确认新增断言失败。
- [ ] 实现左列表右内容、单主要滚动区域、固定底部操作；活动/已存草稿/未保存编辑三种状态明示；错误计数可跳转。上传总路径只有一个，ZIP 来源展示包继承值，课程命名字段与 ZIP 命名区分。
- [ ] 移除普通学科并发/资源输入、局部名称说明和全局名称编辑入口。读取固定系统 label，停止使用旧显示 override；旧数据库值留存，不隐藏编辑后继续生效。没有其他引用再删除 `UnifiedWorkflowStageSettings.tsx` / `BoardStageSettings.tsx`；内部 stage ID 不变。
- [ ] 原音模式隐藏无关配音设置；未启用阶段折叠摘要保留值。加入真实/展示路径预览差异、预览不创建说明、显式测试写入操作和字段刷新。
- [ ] 执行 `npm --prefix taskboard run typecheck`、`npm --prefix taskboard run test:components`、`node --test taskboard/test/unified-workflow-view-controls.test.mjs taskboard/test/feishu-workflow-ui.test.mjs`；预期通过。用宽屏和窄窗口实际检查无双层高度裁剪、遮挡和横向溢出；提交 `feat: reorganize Feishu configuration and use fixed workflow labels`。

## Task 10：任务交付状态与独立重试

**Files:** 计划新增 `taskboard/web/src/components/FeishuDeliveryStatus.tsx`、`FeishuDeliveryStatus.test.tsx`；修改 `taskboard/web/src/components/AutoCutRunSummary.tsx`、`AutoCutRunSummary.test.tsx`、`taskboard/web/src/unifiedWorkflow.mjs`、`taskboard/web/src/api.ts`、`taskboard/web/src/types.ts`、`taskboard/package.json`；扩展 `taskboard/test/artifact-upload-views.test.mjs`、`taskboard/test/unified-workflow-projection.test.mjs`。

**Interfaces:** 任务 8 的 API 输出 `editingState, manifestFinalized, totalZips, uploadedZips, statusWritebacks, coursePathWriteback`；不得通过“存在任一 uploaded”推算整卡已上传。新组件测试文件显式加入现有 `test:components` 脚本，否则默认脚本不会执行它。

- [ ] 断言两 ZIP 一个成功显示“上传 1/2”，回写待重试不把剪辑改为失败，点击回写重试仅请求该 operation，成片记录在学科额外触发区可见。

```tsx
expect(screen.getByText('上传 1/2')).toBeTruthy();
expect(screen.getByText('课程路径：待重试')).toBeTruthy();
fireEvent.click(screen.getByRole('button', { name: '重试课程路径回写' }));
expect(retryDeliveryOperation).toHaveBeenCalledWith('op_course_path', 1);
expect(startAutoCut).not.toHaveBeenCalled();
expect(enqueueArtifactUpload).not.toHaveBeenCalled();
```

- [ ] 执行更新后的 `npm --prefix taskboard run test:components`，确认新增断言失败；实现状态区、冲突/已被新状态替代/死信原因、单项重试。
- [ ] 执行 `npm --prefix taskboard run typecheck`、`npm --prefix taskboard run test:components`、`node --test taskboard/test/artifact-upload-views.test.mjs taskboard/test/unified-workflow-projection.test.mjs`，预期通过；提交 `feat: show delivery progress and targeted writeback retries`。

## Task 11：旧数据升级与端到端自动化

**Files:** 扩展 `taskboard/test/feishu-database-migration.test.mjs`、`test/phased-bridge.test.mjs`、`test/startup-scripts.test.mjs`、`test/operations-hardening.test.mjs`；计划新增 `taskboard/test/feishu-course-delivery-integration.test.mjs`；必要实现修正限于前述模块。

- [ ] 建立旧数据库/旧包 fixture：旧阶段路径相同、不同、非空资源、旧自定义名称、排队/执行/上传中的任务各一例。迁移事务失败回滚，再次启动幂等；旧任务继续使用旧快照和路径，新配置激活后才对新记录生效；已存在绑定不重新绑定。
- [ ] 使用临时文件夹、loopback 两服务与 SDK 假实现跑完整序列：可信事件 → 绑定无目录 → 真正开始 → processing 回写 → 两 ZIP 逐个发布 → 首 ZIP 路径回写 → 全 ZIP 阶段回写 → 改名后第二阶段仍原目录。加 `00成片` 抢先与后到两种顺序。

```js
assert.deepEqual((await readdir(courseDirectory)).sort(), ['00成片', '01初稿', '02初审']);
assert.equal(receivedCoursePathWrites.length, 1);
assert.equal(receivedStageCompletionWrites.length, 2);
assert.equal(secondRun.bindingId, firstRun.bindingId);
await assert.rejects(() => access(unusedFinalReviewDirectory), { code: 'ENOENT' });
```

- [ ] 验证断网重试、SDK 429、进程崩溃、人工改字段、旧 processing 晚到、映射改变/不可解析、源文件变化、同名冲突、模拟来源；断言无未授权真实外部操作。
- [ ] 执行 `node --test taskboard/test/feishu-course-delivery-integration.test.mjs taskboard/test/feishu-database-migration.test.mjs test/phased-bridge.test.mjs test/startup-scripts.test.mjs test/operations-hardening.test.mjs`，预期通过。
- [ ] 执行仓库标准 `npm test`，预期 Node 测试、TypeScript、web build 和所有登记的组件测试均通过；仅在出现新变更/失败时重跑受影响检查。提交 `test: cover delivery migration and end-to-end recovery`。

## Task 12：测试表/NAS 发布能力联调与合并评审

**Files:** 修改 `README.md`、`taskboard/README.md`、`taskboard/README.zh-CN.md`、`AGENTS.md`、`config/bridge.example.json`、`config/autocut-packages.example.json`；计划新增 `docs/testing/feishu-course-delivery-smoke.md`（测试步骤与脱敏结果，不建立第二份运行规范）。

- [ ] 文档明确：配置所有权、目录冻结/惰性创建、首 ZIP vs 全 ZIP、两种路径展示、原子发布限制、模拟不写远端、独立重试、租约与至少一次边界、停用不删除已建目录。同步现有示例，不放真实凭据与真实 NAS 主机名。
- [ ] 在用户指定的测试表和示例项目填入测试规则，确认目标账号的读取/更新记录权限。真实外部写验证需要指定测试记录和测试目录，若尚未提供则先交付可执行命令/测试清单并说明缺少对象，不改生产记录测试。
- [ ] 执行 `.\scripts\check-local.ps1`；按现有流程停止/重启服务后 `.\scripts\check-local.ps1 -RequireFeishu`。只有监听状态 `sdk_managed` 再使用测试表单个事件做端到端；健康状态不代替实际事件验证。
- [ ] 使用唯一测试课程目录，在当前运行服务的同一 Windows 身份验证映射/UNC 可访问与原子不覆盖 ZIP 发布。测试 mkdir 成功不足以证明 ZIP 能发布；不支持 hard-link 时记录已失败的发布能力门槛，不降低不覆盖保证；如需替代策略，单独设计验证后再交付 NAS 上传可用结论。
- [ ] 按顺序验收初稿、初审、终审、`00成片` 抢先、重试、人工冲突；记录完整文件路径仅于本机测试记录，截图/报告脱敏。清理只限本次已核对的唯一测试目录，保留此前用户创建的 `01初审` 和 `01初审测试`。
- [ ] 调用代码评审，重点检查 credential 边界、伪来源、事务/outbox、旧任务快照、路径链接竞态、最终 ZIP 集合和自触发回路；修复所有阻断问题并重跑受影响测试。
- [ ] 执行 `git diff --check` 与 `git status --short`，确认只有预期文件，未暂存 `.env.local` / `config/bridge.local.json` / 本机 registry / `.runtime` / 数据库。分批 `git add` 文档和示例，提交 `docs: document controlled course delivery and verification`。满足评审与真实测试门槛后再按项目流程合并。

## 实施前核对结论

规格验收场景与任务对应：A01/A05/A14–A16 → 任务 2、4；A02–A04/A17 → 任务 5；A08–A13 → 任务 6、7；A06/A07 → 任务 8；A18/A19 → 任务 1、9；A20/A21 → 任务 3、9、11；A22 → 任务 8、10。任务 11、12 对这些场景做组合回归与真实测试环境验收。

- 已核对当前 `npm test` 会运行 Node 测试、Taskboard typecheck、web build 和显式列表组件测试；新增组件测试必须登记。
- 当前上传 worker 已做 hash 与 hard-link 原子不覆盖，但尚未保存完整 publication 路径；现有上传失败需要手动重试，不能描述为已有退避/死信能力。
- 当前阶段调度强制包并发 1，而非完全服从可编辑 maxConcurrent；界面必须解释实际效果。
- 当前 `in_progress` 可能早于实际 runner 成功启动；处理回写必须由已确认运行事务产生。
- 当前共享配置与 Taskboard/Bridge 各有严格 schema/允许字段；不能只改前端字段。
- 本轮无真实 SDK 写协议测试、NAS ZIP 原子发布测试或私有配置迁移审计结果；这些是任务 7、11、12 的实际验收项，不能提前标为完成。
