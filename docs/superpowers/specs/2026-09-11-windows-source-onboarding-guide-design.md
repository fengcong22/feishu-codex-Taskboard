# Windows 源码部署与个人飞书接入指南设计

日期：2026-09-11

状态：用户已确认

## 1. 背景

团队希望把一份部署指令交给可信同事电脑上的 Codex，由目标电脑的 Codex 从公开源码仓库下载并运行飞书 Bridge × Codex Taskboard。该电脑使用其所有者自己的 Codex 账号、飞书企业自建应用和飞书多维表格，不复制当前电脑的登录态、凭据、本机路径、任务历史或 Bridge 运行状态。

GitHub 仓库已重命名，规范地址为 `https://github.com/fengcong22/feishu-codex-Taskboard`，默认分支为 `main`。旧仓库地址虽由 GitHub 重定向，但新文档与示例命令只使用规范地址。

## 2. 目标

在仓库中提供一份面向目标电脑 Codex 的中文执行 Runbook，使 Codex 可以：

1. 在 Windows x64 上验证 Git、Node.js 22.13 或更高版本，并按启动脚本的实际候选路径确认当前电脑已经可用的 `codex.exe` 可被 Taskboard 发现；Git 或 Node.js 缺失时暂停并交还用户处理；
2. 从规范 GitHub 地址克隆源码并安装根目录与 `taskboard` 子目录的依赖；
3. 使用自己的飞书企业自建应用、凭据、Base、子表和字段完成长连接配置；
4. 从仓库示例生成仅属于该电脑的 Bridge 与项目包配置；
5. 保持自动执行关闭，先完成安全检查，再用自己的测试 Base 验证真实事件；
6. 把仓库中适合共享的 Codex 项目规则与个人 Codex 配置、登录态明确分开；
7. 遇到常见失败时，按照固定顺序完成脱敏排查。

## 3. 非目标

- 不制作或修改一键安装脚本、Windows 安装包或自动更新器；
- 不安装、更新或登录 Codex，也不替同事创建飞书应用、Base 或 GitHub 账号；
- 不复制当前电脑的 `%USERPROFILE%\.codex`、Codex 登录态、API key、飞书凭据或 GitHub token；
- 不提交 `.env.local`、`config/bridge.local.json`、`config/taskboard-feishu-packages.json`、`.runtime/` 或真实业务路径；
- 不默认开启 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION`；
- 不改变 Bridge、Taskboard、事件筛选、任务路由、端口、监听或安全行为。

## 4. 交付形式

新增 `docs/windows-source-install-guide.zh-CN.md`，并在根 `README.md` 的团队交接位置增加入口。该文件本身就是可交给目标电脑 Codex 的完整部署指令：要求 Codex 先检查环境，克隆后读取仓库规则并逐项执行；现有 Codex 不可用时停止并报告，不安装、更新、登录或修复 Codex；涉及外部权限、秘密或真实业务数据时，每次只请求当前最少的人工动作，最后输出脱敏验收结果。它不承担给同事逐条复制命令的手工教程职责。

不新增第二份 `AGENTS.md`。根 `AGENTS.md` 继续是唯一团队运行规范；同事在 Codex 中打开克隆后的仓库时自然获得仓库级约束。本 Runbook 不安装 Skill，也不把个人全局 Codex 配置作为源码交付物。

## 5. 指南结构

### 5.1 开始前的边界

首先说明“能从 Git 获取”和“必须在目标电脑自行建立”的内容：

| 随源码共享 | 仅在同事电脑创建 |
| --- | --- |
| 源码、根 `AGENTS.md`、README、示例 JSON | Codex 登录态、飞书 App ID/Secret、本机 JSON 配置、绝对工作区路径、Bridge 状态、Taskboard 数据和日志 |

指南明确：同事虽是可信成员，仍使用自己的飞书应用和 Base，因此无需也不得接收当前电脑的任何秘密或真实本机配置。

### 5.2 Windows 前置软件

本 Runbook 把目标电脑上的 Codex 已经可用作为硬前提，不提供 Codex 安装、更新、登录或账号修复步骤。Codex 只检查现有 `codex.exe` 是否可被 Taskboard 发现；继承的 `CODEX_EXECUTABLE` 一律 fail-closed，若默认位置不可发现，只允许用户明确确认现有绝对路径后通过本轮局部变量提供，否则停止并报告。阶段 A 同时把 Git、Node.js、npm 和 Codex 解析为完全限定的现有本地固定磁盘文件，拒绝映射网络盘和路径链中的重解析点，并在部署执行上下文中保留这些路径；Node 与 npm 必须来自同一安装目录，直接 npm 调用由已确认的 `node.exe` 显式执行同目录 `node_modules\npm\bin\npm-cli.js`，根脚本内的 bare `npm` 通过受控 PATH 解析到同一 `npm.cmd`。后续直接调用与仓库启动脚本不得重新选择其他可执行文件。

Git 和 Node.js 仍需安装并验证。源码运行要求 Node.js 22.13 或更高版本，以同时满足 Vite 8 和无需实验开关的 `node:sqlite`；不把 Rust、Visual Studio Build Tools 或 Windows SDK 列为前置条件，这些工具只与构建 NSIS 安装包有关。

### 5.3 克隆与版本确认

示例使用：

```powershell
$workDirectory = '<用户已确认的绝对工作目录>'
$confirmedGitExecutable = '<阶段 A 已验证的 git.exe 完全限定路径>'
$emptyGitConfig = '<本轮新建的零字节 Git 配置文件完全限定路径>'
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
& $confirmedGitExecutable -c credential.interactive=never -c protocol.allow=never -c protocol.https.allow=always clone --config core.hooksPath=NUL --template='<本轮新建的空模板目录>' --no-local https://github.com/fengcong22/feishu-codex-Taskboard.git $workDirectory
Set-Location -LiteralPath $workDirectory
$originUrl = ([string](& $confirmedGitExecutable remote get-url origin 2>$null)).Trim()
# 只核对规范仓库身份，不打印可能包含 userinfo/token 的原始 URL。
& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all
```

指南解释：首次部署只接受用户确认的、尚不存在且路径链无重解析点的本地固定磁盘目录，并从规范地址全新 clone。clone 及每个 fetch 块都在环境门禁后禁用 system Git 配置，把 global Git 配置指向本轮新建的零字节普通文件，并只允许 HTTPS transport 与非交互式公共仓库访问；不得用命令级 `include.path=NUL` 伪装隔离。团队正式交接应由维护者给出 tag 或完整 commit SHA；若未指定版本，只允许执行与规范 `origin` 本次返回的 `main` 完全一致的干净本地 `main`。tag 和 `main` 都通过禁用本地 refmap 的精确 fetch 写入 `FETCH_HEAD` 后解析，不信任已有本地 tag 或可能陈旧的远端跟踪引用；完整 SHA 必须是本次获取的规范 `main` 历史中的 commit，不在该历史中的发布版本必须改用规范远端 tag。在任何 npm 或仓库脚本前先获取并核对远端；不能把本地尚未推送的提交描述为对方已经取得的内容。新版本也部署到另一个全新目录，不在旧工作树中原地 fetch、切换或合并；本机配置是否迁移另行评审，绝不复制旧 `.git` 或 `.runtime`。

### 5.4 安装两层依赖与测试

明确安装根仓库和内置 Taskboard 两套依赖：

```powershell
& $confirmedNodeExecutable $confirmedNpmCli ci
& $confirmedNodeExecutable $confirmedNpmCli ci --prefix taskboard
& $confirmedNodeExecutable $confirmedNpmCli test
```

`npm ci` 必须严格使用两份批准 lockfile，不设置 `replace-registry-host=always`，也不重写已有 `resolved` URL；两层安装和测试后再次确认整个 Git 工作树干净。已确认的 npm CLI 始终由已确认的 Node 显式运行；根脚本内部 bare `npm` 通过 PATH 固定到同一安装目录的 `npm.cmd`，避免 `npm.ps1` 被 PowerShell 执行策略阻止时诱导用户全局放宽安全策略。测试失败、lockfile 不一致或工作树变化时停止，不继续连接真实飞书。

### 5.5 创建同事自己的飞书应用

指南只依据代码实际调用和飞书官方文档列出最小配置：

- 创建企业自建应用并由该企业管理员批准所需权限；
- 使用长连接作为事件订阅方式，不要求公网回调地址；
- 订阅仓库实际处理的多维表格记录变更事件 `drive.file.bitable_record_changed_v1`；
- 为应用授予代码实际使用的 Base 元数据、字段、记录和可选 Wiki 节点只读权限；
- 确保应用身份能访问同事自己的测试 Base；
- 发布或启用满足企业策略的应用版本后再做真实验证。

最终指南必须从代码调用与飞书官方文档核对准确的权限名称；无法由官方资料确认的权限不猜测，改为提示在开发者后台依据事件/API 的“所需权限”申请，并由管理员复核。

### 5.6 本机配置

从两个受版本控制的示例文件复制：

```powershell
Copy-Item .\config\bridge.example.json .\config\bridge.local.json
Copy-Item .\config\autocut-packages.example.json .\config\taskboard-feishu-packages.json
```

指南把 Bridge 原生支持的 legacy `tables` 单一可开始值流程作为首次无害验收路径：Codex 把新生成的 `bridge.local.json` 绑定到当前电脑的绝对状态路径，并保留一个只由用户在本机填写的专用测试表条目；`workflowFile` 必须写成标准入口实际使用的 `<工作目录>\.runtime\bridge\workflow.json`，不能承诺自定义位置生效。首次验收不通过 Taskboard UI 导入 Base，不把新导入产生的 phased 草稿尝试改成“全部阶段禁用”；当前 UI 要求 phased subject 至少启用一个阶段。legacy 条目必须使用已启用的 `defaultPackageAlias`，不能依赖通常不会随状态变更事件出现的包字段。首次验收通过后，如需 Taskboard 管理的 phased 工作流，再由用户在本机 UI 导入自己的 Base，配置至少一个启用阶段及完整 ZIP 来源和 driver report fixture，并单独验收。Base 链接或 token 不进入 Codex 对话。

指南逐字段解释必须修改或确认的值：

- `bridge.local.json` 的本机 `stateFile`/`workflowFile` 绝对路径，以及仅在旧版流程中使用的 Base、子表、状态字段、状态选项和标题字段；
- `taskboard-feishu-packages.json` 的包别名、固定 `projectId`、现有本地固定磁盘目录 `workspacePath`、固定 prompt 和启用状态；UNC、映射网络盘、设备路径、相对路径及包含重解析点的目录均阻断；
- `.env.local` 中只放同事自己的 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET`。

`host` 保持 `127.0.0.1`，`taskboardUrl` 保持 `http://127.0.0.1:47823`。飞书单元格只提供受控字段值或包别名，不能提供路径、shell 命令、Codex 参数、prompt 或秘密。

统一启动时不要求同事手工配置 `CODEX_FEISHU_BRIDGE_SECRET`；启动脚本负责生成并同时注入 Bridge 和 Taskboard。自动执行开关保持未设置。

每个新的 PowerShell 进程都必须在首次调用 Git、Node、npm、Codex 或仓库脚本前，对会替换 dotenv、Bridge 配置、Taskboard 源码、包 registry、运行文件、Bridge 地址或 Git/npm 行为的环境变量 fail-closed；变量即使为空或只有空白也视为已经设置。除 `GIT_*`、`NODE_OPTIONS`、`NODE_PATH` 和 `NPM_CONFIG_*` 外，门禁还必须覆盖 `NODE_TLS_REJECT_UNAUTHORIZED`、`NODE_EXTRA_CA_CERTS`、`HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`SSL_CERT_FILE`、`CURL_CA_BUNDLE`。进程级 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 和继承的 `CODEX_EXECUTABLE` 也必须阻断；`.env.local` 每次只允许两项凭据。只报告变量名，不读取或输出值。用户明确确认的 Codex 路径只能通过本轮局部变量提供并解析为阶段 A 验证的完全限定本地固定磁盘文件；`CODEX_HOME` 只允许使用阶段 A 验证过的目标用户默认目录，或经用户明确确认的既有本地固定磁盘目录。每个会启动 Taskboard/Codex 的块都无条件注入这两个已验证值；启动前还要让 PATH 中的 Git、Node.js 和 npm 解析结果与阶段 A 保存的路径完全一致，Node 与 npm 必须是同目录 pair，函数或别名遮蔽时停止。所有直接 npm 调用都由已确认的 Node 显式执行已确认的 `npm-cli.js`；阶段 B 在已验证克隆的 `.runtime\bootstrap` 中创建稳定的零字节 Git/npm 配置，使用两层 `npm ci`，不读取用户级或全局 `.npmrc`，不设置 `replace-registry-host=always`，不改写批准 lockfile，并在测试后要求全仓工作树仍然干净。已有 lockfile 的 `resolved` URL 保留批准版本中的 host；统一供应链来源属于维护者另行审查的变更。

### 5.7 验收路径

验收分为三道门：

1. 两层 `npm ci`、完整测试及安装后全仓工作树 clean 检查通过；
2. 在不开启真实监听和自动执行的情况下运行 `start-local.ps1` 与 `check-local.ps1`，确认两个 loopback 服务健康；仓库固定模拟脚本只有在配置与其固定 fixture 匹配时才使用，并通过调用前后 Taskboard 任务 ID 集合证明本轮确实新增且重放未新增，不能把示例占位符或复用的旧任务误称为新建；
3. 用户在本机 `bridge.local.json` 配置一个专用测试 Base 的 legacy `tables` 条目，固定 `mode = manual`、`defaultPackageAlias = Auto-cut-copyA`、`packageField = null`、`packageFieldId = null`，然后使用 `start-local.ps1 -EnableFeishu`、`check-local.ps1 -RequireFeishu` 做一次真实状态迁移，确认只创建一张对应任务。首次验收不通过 UI 导入 phased subject；分阶段流程必须另备至少一个启用阶段、ZIP 来源和 driver report 的完整 fixture。先用固定结果码核对新任务的服务端来源和冻结包快照确实绑定 `examples/harmless-auto-cut` 与受版本控制的无害 prompt，再由用户手动启动一次。执行证据必须先读取 `GET /api/tasks/{taskId}` 和 `GET /api/local/ai/threads`，确认任务是无 `threadId` 的 `todo` 并保存点击前 thread ID 集合；点击后只接受任务绑定的一个新 thread，并用 `GET /api/local/ai/threads/{threadId}` 捕获唯一 run ID。后续轮询固定该 run ID，验证 `run.threadId == task.threadId == snapshot.thread.id`，只接受 `status = completed`、非空 `finishedAt` 和 `exitCode = 0`；`failed`、`interrupted`、未知状态、多 run 或超时均失败，不能用 `runs.at(-1)` 或先前执行的结果替代。本轮动态证据通过后才检查受版本控制的无害示例目录仍干净。

文档明确 `sdk_managed` 只表示官方 SDK 已接管长连接生命周期，不等于事件端到端成功。真实验收必须使用测试 Base，不反复修改生产记录。

### 5.8 日常操作和排错

列出启动、检查、停止、新版本全新目录部署和日志位置。排错顺序固定为：Node/Codex 可执行文件、两层依赖、本机绝对路径、包别名与启用状态、飞书凭据、应用权限/Base 可见性、长连接订阅、端口占用、健康状态和脱敏日志。

不得建议删除或手工改写 `.runtime` 中的状态/锁文件，也不得把监听地址改成 LAN 或公网地址。

## 6. 给 Codex 的部署指令

整份 Runbook 直接要求目标电脑上的 Codex：

1. 按外部拿到的本文确认目录并克隆，随后在任何仓库修改或启动前阅读根 `AGENTS.md`、README 和仓库内本指南；
2. 只在用户选定的本地克隆目录工作；
3. 检查前置软件、安装两层依赖并运行测试；
4. 生成仅由 Git 忽略的本机配置，不读取、索取或复制其他电脑的配置；
5. 在需要同事创建飞书应用、输入 App Secret 或批准权限时停下并给出人工操作说明；
6. 保持自动执行关闭，先检查本地服务，再执行测试 Base 的真实验收；
7. 最后报告版本 SHA、配置文件是否存在、测试结果、两个健康状态、真实事件结果和仍需人工完成的事项；
8. 不提交、不打印或转述任何秘密。

Runbook 不会授予 Codex 创建外部账号、保存密码、修改飞书权限或开启自动执行的隐含授权。

## 7. 安全与准确性

- 所有服务仍只绑定 `127.0.0.1`；
- 所有秘密只由同事在自己的电脑和自己的飞书环境中创建；
- `.gitignore` 是辅助防线，不替代提交前的 `git status` 与 staged diff 检查；
- 文档中的外部产品安装、配置和权限信息优先引用飞书、Git 和 Node.js 的官方资料；官方页面无法访问或无法确认时显式说明，不从搜索摘要推断关键权限；
- 不在文档示例中放入真实 token、Base token、表/字段 ID、业务路径或 Bridge Secret；
- 文档不承诺端到端 exactly-once，保留仓库的至少一次投递语义；
- 模拟事件永远标记为非生产来源且不能获得自动执行资格。

## 8. 验收标准

文档完成需同时满足：

- 新仓库地址在所有新增命令和链接中一致；
- 新用户可以明确区分源码共享内容与本机私有内容；
- 命令覆盖两层依赖、完整测试、启动、健康检查和安全停止；
- 飞书步骤使用同事自己的应用和 Base，并列出经过核对的最小权限/事件设置；
- 不要求复制个人 Codex 配置或登录态；
- clone/fetch 不读取 system/global Git 配置，且所有外部工具调用固定到阶段 A 验证的本地文件；
- 启用包的 `workspacePath` 是本地固定磁盘上的现有目录，且路径链不含重解析点；
- 每个启动块注入同一阶段 A 已验证的 `CODEX_EXECUTABLE` 和 `CODEX_HOME`，并且不会读取或复制 `CODEX_HOME` 内容；
- 首次部署与新版本都使用尚不存在、路径链无重解析点的本地固定磁盘目录全新 clone，不复用或原地更新旧工作树；
- 首次执行验收明确是非分阶段、手动的无害流程，并以本轮固定 task/thread/run ID 的成功终态而非旧文件或最后一个 run 作为证据；
- 自动执行默认关闭，模拟与真实验收清楚分开；
- README 可以直接找到该指南；
- Markdown 链接有效，示例命令不含真实秘密，`git diff --check` 通过；
- 文档修改经过代码评审后再进入团队使用流程。
