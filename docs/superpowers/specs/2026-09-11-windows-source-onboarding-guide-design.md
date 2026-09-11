# Windows 源码安装与个人飞书接入指南设计

日期：2026-09-11

状态：用户已确认

## 1. 背景

团队希望让一名可信同事从公开源码仓库下载并运行飞书 Bridge × Codex Taskboard。该同事使用自己的 Windows 电脑、Codex 账号、飞书企业自建应用和飞书多维表格，不复制当前电脑的登录态、凭据、本机路径、任务历史或 Bridge 运行状态。

GitHub 仓库已重命名，规范地址为 `https://github.com/fengcong22/feishu-codex-Taskboard`，默认分支为 `main`。旧仓库地址虽由 GitHub 重定向，但新文档与示例命令只使用规范地址。

## 2. 目标

在仓库中提供一份面向非维护者的中文操作指南，使同事可以：

1. 在 Windows x64 上安装并验证 Git、Node.js 22.5 或更高版本和官方 Codex；
2. 从规范 GitHub 地址克隆源码并安装根目录与 `taskboard` 子目录的依赖；
3. 使用自己的飞书企业自建应用、凭据、Base、子表和字段完成长连接配置；
4. 从仓库示例生成仅属于该电脑的 Bridge 与项目包配置；
5. 保持自动执行关闭，先完成安全检查，再用自己的测试 Base 验证真实事件；
6. 把仓库中适合共享的 Codex 项目规则与个人 Codex 配置、登录态明确分开；
7. 遇到常见失败时，按照固定顺序完成脱敏排查。

## 3. 非目标

- 不制作或修改一键安装脚本、Windows 安装包或自动更新器；
- 不替同事创建飞书应用、Base、Codex/OpenAI 账号或 GitHub 账号；
- 不复制当前电脑的 `%USERPROFILE%\.codex`、Codex 登录态、API key、飞书凭据或 GitHub token；
- 不提交 `.env.local`、`config/bridge.local.json`、`config/taskboard-feishu-packages.json`、`.runtime/` 或真实业务路径；
- 不默认开启 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION`；
- 不改变 Bridge、Taskboard、事件筛选、任务路由、端口、监听或安全行为。

## 4. 交付形式

新增 `docs/windows-source-install-guide.zh-CN.md`，并在根 `README.md` 的团队交接位置增加入口。指南自身同时服务两种读者：

- 人工操作：同事可逐步复制 PowerShell 命令并核对预期结果；
- Codex 协助：文档末尾提供一段可直接粘贴到同事电脑 Codex 的完整提示词，要求 Codex 先检查环境和仓库规则、逐项执行、在涉及账号登录或凭据时交还用户操作，并输出验收结果。

不新增第二份 `AGENTS.md`。根 `AGENTS.md` 继续是唯一团队运行规范；同事在 Codex 中打开克隆后的仓库时自然获得仓库级约束。Taskboard 的 `manage-taskboard` Skill 作为可选增强单独说明，不把个人全局 Codex 配置作为源码交付物。

## 5. 指南结构

### 5.1 开始前的边界

首先说明“能从 Git 获取”和“必须在目标电脑自行建立”的内容：

| 随源码共享 | 仅在同事电脑创建 |
| --- | --- |
| 源码、根 `AGENTS.md`、README、示例 JSON、Taskboard Skill 源码 | Codex 登录态、飞书 App ID/Secret、本机 JSON 配置、绝对工作区路径、Bridge 状态、Taskboard 数据和日志 |

指南明确：同事虽是可信成员，仍使用自己的飞书应用和 Base，因此无需也不得接收当前电脑的任何秘密或真实本机配置。

### 5.2 Windows 前置软件

按 Git、Node.js、Codex 的顺序安装和验证。源码运行只要求 Node.js 22.5 或更高版本，不把 Rust、Visual Studio Build Tools 或 Windows SDK 列为前置条件；这些工具只与构建 NSIS 安装包有关。

Codex 由同事使用自己的账号登录。安装说明引用可访问的 OpenAI 官方页面，并提供本地只读验证命令；如果启动脚本无法自动定位 `codex.exe`，指南只允许把 `CODEX_EXECUTABLE` 设置为目标电脑上的绝对可执行文件路径，不复制别人的 Codex 目录。

### 5.3 克隆与版本确认

示例使用：

```powershell
git clone https://github.com/fengcong22/feishu-codex-Taskboard.git D:\codex\codex-feishu
Set-Location D:\codex\codex-feishu
git remote -v
git status --short
```

指南解释：团队正式交接应由维护者给出 tag 或完整 commit SHA；若未指定版本，则使用 `main`，但不能把本地尚未推送的提交描述为对方已经取得的内容。更新源码只使用正常 Git 流程，不覆盖本地私有配置。

### 5.4 安装两层依赖与测试

明确安装根仓库和内置 Taskboard 两套依赖：

```powershell
npm.cmd install
npm.cmd install --prefix taskboard
npm.cmd test
```

Windows 文档优先使用 `npm.cmd`，避免 `npm.ps1` 被 PowerShell 执行策略阻止时诱导用户全局放宽安全策略。测试失败时停止，不继续连接真实飞书。

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

指南逐字段解释必须修改的值：

- `bridge.local.json` 的 Base、子表、状态字段、状态选项、标题字段及本机 `stateFile`/`workflowFile` 绝对路径；
- `taskboard-feishu-packages.json` 的包别名、固定 `projectId`、本机绝对 `workspacePath`、固定 prompt 和启用状态；
- `.env.local` 中只放同事自己的 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET`。

`host` 保持 `127.0.0.1`，`taskboardUrl` 保持 `http://127.0.0.1:47823`。飞书单元格只提供受控字段值或包别名，不能提供路径、shell 命令、Codex 参数、prompt 或秘密。

统一启动时不要求同事手工配置 `CODEX_FEISHU_BRIDGE_SECRET`；启动脚本负责生成并同时注入 Bridge 和 Taskboard。自动执行开关保持未设置。

### 5.7 分阶段验收

验收分为三道门：

1. `npm.cmd test` 完整通过；
2. 在不开启真实监听和自动执行的情况下运行 `start-local.ps1` 与 `check-local.ps1`，确认两个 loopback 服务健康；仓库固定模拟脚本只有在配置与其固定 fixture 匹配时才使用，不能把示例占位符误称为可直接模拟；
3. 使用 `start-local.ps1 -EnableFeishu`、`check-local.ps1 -RequireFeishu` 和同事自己的测试 Base 做一次真实状态迁移，确认只创建一张对应任务。

文档明确 `sdk_managed` 只表示官方 SDK 已接管长连接生命周期，不等于事件端到端成功。真实验收必须使用测试 Base，不反复修改生产记录。

### 5.8 日常操作和排错

列出启动、检查、停止、更新源码和日志位置。排错顺序固定为：Node/Codex 可执行文件、两层依赖、本机绝对路径、包别名与启用状态、飞书凭据、应用权限/Base 可见性、长连接订阅、端口占用、健康状态和脱敏日志。

不得建议删除或手工改写 `.runtime` 中的状态/锁文件，也不得把监听地址改成 LAN 或公网地址。

## 6. Codex 安装提示词

文档末尾的提示词要求目标电脑上的 Codex：

1. 先阅读根 `AGENTS.md` 和本指南；
2. 只在用户选定的本地克隆目录工作；
3. 检查前置软件、安装两层依赖并运行测试；
4. 生成仅由 Git 忽略的本机配置，不读取、索取或复制其他电脑的配置；
5. 在需要同事登录 Codex、创建飞书应用、输入 App Secret 或批准权限时停下并给出人工操作说明；
6. 保持自动执行关闭，先检查本地服务，再执行测试 Base 的真实验收；
7. 最后报告版本 SHA、配置文件是否存在、测试结果、两个健康状态、真实事件结果和仍需人工完成的事项；
8. 不提交、不打印或转述任何秘密。

提示词不会授予 Codex 创建外部账号、保存密码、修改飞书权限或开启自动执行的隐含授权。

## 7. 安全与准确性

- 所有服务仍只绑定 `127.0.0.1`；
- 所有秘密只由同事在自己的电脑和自己的飞书环境中创建；
- `.gitignore` 是辅助防线，不替代提交前的 `git status` 与 staged diff 检查；
- 文档中的外部产品安装、配置和权限信息优先引用官方 OpenAI、飞书和 GitHub 资料；官方页面无法访问或无法确认时显式说明，不从搜索摘要推断关键权限；
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
- 自动执行默认关闭，模拟与真实验收清楚分开；
- README 可以直接找到该指南；
- Markdown 链接有效，示例命令不含真实秘密，`git diff --check` 通过；
- 文档修改经过代码评审后再进入团队使用流程。
