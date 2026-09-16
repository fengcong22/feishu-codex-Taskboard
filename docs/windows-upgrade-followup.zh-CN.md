# Windows 升级问题修复与验收

适用起点：2026-09-16 升级报告中的 `512d4fa8435d0aeb9d65f52664b8440f84f94d4f`。报告证明源码已升级、数据保留、服务恢复；完整测试和真实剪辑验收未完成。本说明仅处理后续源码修复，不要求重新安装 Auto-cut-lite，也不要求恢复旧备份覆盖升级后产生的记录。

## 两项源码修复

1. AI 模型/技能目录查询：技能结果成功或失败后，等待临时子进程 `close` 才返回；先请求 `SIGTERM`，1 秒内未关闭则请求 `SIGKILL`。模型探测超时直接请求 `SIGKILL`。一个并行探测失败时，也等待另一个探测释放资源。修复 Windows 临时工作目录被仍在退出的进程占用的问题，不放宽断言、不跳过测试。报告中另一个独立复测已通过的超时不能仅凭此次修复宣称已消除，仍以目标电脑完整测试为准。
2. phased Auto-Cut ZIP 来源：包的 ZIP 来源字段可选，但旧执行准备将其当作必填。现在包快照未配置 `zipSourceDirectory` / `artifactSourcePath` 时，读取该任务 **冻结学科版本** 的 `upload.artifactSourcePath`，且只允许 `driver_report`。ZIP 生成和回执登记采用同一个解析规则。包显式配置的错误路径仍阻断，登记仍检查精确 run 路径、冻结来源目录、manifest、结果回执、receipt 和 SHA-256。

这项兼容修复不会修改 registry、学科配置、数据库中的旧快照或旧 run。升级本身不重试任务。如果旧任务的包快照和冻结学科版本都没有有效 ZIP 来源，升级后仍应阻断。只改当前 registry 不会更新历史任务的快照；应在测试学科通过正常配置流程保存、启用新版本，并产生新的测试事件。不得直接修改数据库快照或删除 Bridge 状态。

## 另一台电脑原地更新

目标仓库为 `E:\CODEX\全流程自动剪辑\feishu-codex-Taskboard`，使用原 Windows 账号、已验证的 Node/npm/Codex、原配置和 registry 环境。先读取仓库根 `AGENTS.md`。

1. 等待活动剪辑和上传结束，记录当前任务/run、上传队列、Bridge 队列、监听状态和“允许本机自动剪辑”的值。停止原服务，然后做一次新的仓库外冷备份，至少包含 `.env.local`、整个 `config`、`.runtime\taskboard`（包括 SQLite 主文件及可能存在的 WAL/SHM）、`.runtime\bridge`、其他实际环境覆盖路径。保留已有 stash、补丁、bundle 和 9 月 16 日冷备份；本次备份要覆盖报告之后的新记录。核对备份清单和哈希后再更新源码。

```powershell
Set-Location -LiteralPath 'E:\CODEX\全流程自动剪辑\feishu-codex-Taskboard'
.\scripts\check-local.ps1 -RequireFeishu
.\scripts\stop-local.ps1 -TaskboardRoot (Join-Path (Get-Location).Path 'taskboard')
```

2. 使用已评审且包含本修复的源码。若修复已合入 `main`，可在干净工作区执行 `git fetch origin`、`git pull --ff-only origin main`，并核对实际提交包含修复。**仅拉取仍停在 `512d4fa` 的 main 不会获得修复。** 若收到本次交付的 `windows-upgrade-fixes.patch`，可在该基线通过以下方式创建本地修复分支。先将补丁放入目标账号 Downloads，核对 SHA-256 与随补丁交付的记录一致；下面的命令不会读取或覆盖私有配置。

```powershell
Set-Location -LiteralPath 'E:\CODEX\全流程自动剪辑\feishu-codex-Taskboard'
$upgradePatch = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\windows-upgrade-fixes.patch'
if (!(Test-Path -LiteralPath $upgradePatch -PathType Leaf)) { throw '缺少升级补丁' }
Get-FileHash -LiteralPath $upgradePatch -Algorithm SHA256
if ((git status --porcelain)) { throw '工作区有改动，请先单独保存并核对' }
if ($LASTEXITCODE -ne 0) { throw '无法检查工作区' }
if ((git rev-parse HEAD).Trim() -ne '512d4fa8435d0aeb9d65f52664b8440f84f94d4f') { throw '当前提交不是补丁验收基线，请先评审适配' }
git switch -c codex/windows-upgrade-fixes
if ($LASTEXITCODE -ne 0) { throw '无法创建修复分支' }
git am --3way $upgradePatch
if ($LASTEXITCODE -ne 0) { throw '补丁未完整应用，请检查冲突；git am --abort 可取消本次应用' }
git log -1 --oneline
```

若未来从本地修复分支回到远端 main，先确认远端已包含等价修复再切换，避免退回旧行为。不要机械重放升级前 stash，也不要执行 `reset --hard`、清空运行目录或用本机配置覆盖目标电脑配置。

3. 安装两层锁定依赖并运行完整测试。保留全部日志和最终退出码；有失败时停止此次版本验收，记录失败名称/堆栈后处理，不通过降低测试要求掩盖问题。

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Bridge npm ci 失败' }
npm ci --prefix taskboard
if ($LASTEXITCODE -ne 0) { throw 'Taskboard npm ci 失败' }
npm test
if ($LASTEXITCODE -ne 0) { throw '完整测试未通过' }
```

`npm test` 包括 Node 测试、类型检查、Web 构建和组件测试。需要先定向诊断时可运行 `node --test taskboard/test/ai-catalog-lifecycle.test.mjs taskboard/test/ai-chat-server.test.mjs taskboard/test/feishu-run-inputs.test.mjs taskboard/test/feishu-autocut-run-lifecycle.test.mjs`；定向结果不能代替完整测试。

4. 按原启动环境恢复服务。显式指定本仓库 Taskboard 源码；原电脑接收真实事件，因此保留 `-EnableFeishu`。继续使用原 registry 路径与原本已验证的 Codex 路径。自动执行以已持久化的本机设置为准，保留原值；不要为了测试再次强制设置环境开关。

```powershell
.\scripts\start-local.ps1 -EnableFeishu -TaskboardRoot (Join-Path (Get-Location).Path 'taskboard')
.\scripts\check-local.ps1 -RequireFeishu
```

确认 Taskboard/Bridge 仍只监听 `127.0.0.1:47823/47824`，`sdk_managed`、队列状态、任务/run 记录、本机设置与冷备份前记录一致。重启恢复已有合法预约属于原有行为；升级不应额外安排历史任务。若需要退回旧源码，保留当前数据库和新记录，先停止服务并评估数据兼容性，不直接回灌旧备份。

## 剪辑验收必须单独完成

- 先在隔离示例配置完成模拟投递和幂等回归。仓库 `simulate-ready.ps1` 使用固定 fixture，仅当本机配置与该 fixture 匹配时执行；模拟来源不得自动执行。
- 在指定测试学科使用真实测试记录和真实媒体，确认已冻结的 ZIP 来源为预期目录，执行一次受控剪辑，检查本次 run 的结果、ZIP、receipt、verified 制品和完成状态。不反复改生产记录，不重试历史完成任务，不重放旧事件来测试升级。
- 报告中的 Auto-cut-lite `1.6.9` 完整性和环境探针通过，不等于 ASR/Lark 真实输入通过。readiness 的 `pending_validation` 应由真实测试结果推进，不手工改成通过。若 ZIP 输入修复后出现新的阻断，保留新 run 的安全错误码，继续定位那个实际失败阶段。
- 旧的第 9 次 blocked run 应作为历史证据保留。只有明确需要重试且该任务冻结输入有效时，才由操作者显式重试；本次源码更新本身不执行该操作。

本机源码测试使用临时数据库、loopback 端口、假 Codex 和受控 Auto-Cut fixture；它证明兼容逻辑及安全边界，不能替代目标电脑对真实飞书、媒体、ASR、剪映和上传目录的验收。
