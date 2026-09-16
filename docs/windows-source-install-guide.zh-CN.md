# 给 Codex 的 Windows 源码部署 Runbook（个人飞书接入）

本文不是给同事逐条手工执行的安装教程，而是交给目标电脑上 Codex 的部署指令。

> 目标电脑上的 Codex：把本文视为部署运行合同，从第 1 节开始依次执行。在用户指定的 Windows 工作目录中完成可以自动完成的检查、依赖安装、配置校验、服务启动和验收；如果现有 Codex 本身不可用，立即停止并报告，不安装、更新、登录或修复 Codex。遇到外部权限、秘密或真实业务数据时必须暂停，把当前所需的最少人工步骤告诉用户并等待确认。不要只复述本文，也不要跳过测试后直接宣布部署成功。

目标是让每位使用者从规范源码仓库部署一套只属于自己的 Bridge × Codex Taskboard：使用当前电脑上已经可用的 Codex、自己的飞书企业自建应用、自己的 Base、自己的本机工作区和自己的运行状态。不得复制维护者电脑的 Codex 登录态、凭据、路径、任务历史或 `.runtime`。

规范仓库地址：<https://github.com/fengcong22/feishu-codex-Taskboard>

## 1. 执行合同

本文可能在仓库克隆前作为外部指令交给 Codex。仓库尚不存在时，Codex 只执行阶段 A 的工具检查、工作目录确认和克隆步骤；不得假定仓库文件已经存在。首次部署只接受用户确认的、尚不存在且路径链不含重解析点的本地固定磁盘目标路径并执行全新 clone；不得把已有目录、旧 clone 或复制来的 `.git` 当作首次部署输入。

克隆成功后，Codex 先用阶段 A 中不执行仓库代码的 Git 命令核对规范 origin、干净工作树和批准版本；核对通过后，并且在安装依赖、生成配置、修改文件或启动服务之前，Codex 必须读取并遵守仓库中的：

```text
<工作目录>\AGENTS.md
<工作目录>\README.md
<工作目录>\docs\windows-source-install-guide.zh-CN.md
```

克隆前只允许在用户确认的目标父目录完成创建目录和 `git clone`；克隆后只能在用户指定的本地克隆目录工作。若用户没有给出目录，先询问目录；若目录不存在，先向用户确认是否在指定父目录克隆规范仓库。不要猜测工作区、Base、表、字段、项目包 alias、prompt 或任何路径。

### Codex 可以自动执行

- 检查 Git、Node.js、`npm.cmd`、Codex 可执行文件、当前 commit 和工作树；
- 从规范 GitHub 地址克隆源码（仅在用户确认目标目录后）；
- 安装根目录和 `taskboard` 子目录依赖；
- 通过已确认的 `node.exe` 和配对的 `npm-cli.js` 运行完整 `npm test`；
- 只在文件缺失时从示例生成被 Git 忽略的本机配置；
- 校验 JSON 结构、绝对路径、包 alias、loopback 地址和端口；
- 使用正式脚本启动、检查和停止本机服务；
- 查看脱敏健康接口和日志，并输出脱敏验收报告。

### Codex 必须暂停并交还用户

暂停时只说明需要用户做什么，不要求用户把秘密贴到 Codex 对话中：

- 创建、发布、启用或修改飞书企业自建应用；
- 在飞书开发者后台申请或批准权限、订阅事件；
- 给 Base 添加应用协作者或确认资源 ACL；
- 输入 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、Base token 或其他秘密；
- 修改真实 Base 记录；
- 开启 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION`；
- 使用未经过团队批准的 workspace、prompt、shell 命令或包配置。

用户应在本机编辑器中输入秘密。Codex 可以执行只返回“存在/缺失”或“非空/为空”的本地校验，但绝不把秘密值读取到对话中，也不得打印、回显、复制或提交秘密值。

## 2. 阶段 A：读取规则并检查环境

先在 PowerShell 中检查源码部署所需工具。不要安装、更新或登录 Codex。下面的 `$deploymentBlockedPattern` 是每个新 PowerShell 进程都必须重新执行的前置门禁；本文后续任何包含 Git、Node、npm、Codex 或仓库 `.ps1` 的代码块都重复该门禁，不得因为先前进程通过过就省略。除下方专门处理的 `CODEX_HOME` 外，变量只要存在就阻断，包括空字符串或纯空白；继承的 `CODEX_EXECUTABLE` 也单独 fail-closed，只有用户明确确认后写入本轮 `$codexExecutableOverride` 的路径才可使用。门禁覆盖 `GIT_*`、`NODE_OPTIONS`、`NODE_PATH`、`NODE_TLS_REJECT_UNAUTHORIZED`、`NODE_EXTRA_CA_CERTS`、全部 `NPM_CONFIG_*`，以及 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`SSL_CERT_FILE`、`CURL_CA_BUNDLE`，防止外部配置在可信性核对或秘密校验前注入代码、替换模块、削弱 TLS、改变脚本或网络目标：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive directory."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$codexCommands = @(Get-Command codex.exe -CommandType Application -All -ErrorAction SilentlyContinue)
$codexExecutableOverride = ''
$codexCandidates = @()
foreach ($codexCommand in $codexCommands) {
  $codexCandidates += $codexCommand.Source
}
$codexArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
if ($codexArchitecture -eq 'x86' -and -not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
  $codexArchitecture = $env:PROCESSOR_ARCHITEW6432
}
$codexVendorRelativePath = switch ($codexArchitecture.ToLowerInvariant()) {
  'amd64' { '@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe' }
  'arm64' { '@openai\codex-win32-arm64\vendor\aarch64-pc-windows-msvc\bin\codex.exe' }
  default { $null }
}
$applicationDataPath = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::ApplicationData)
if ($codexVendorRelativePath -and -not [string]::IsNullOrWhiteSpace($applicationDataPath) -and $applicationDataPath -match '^[A-Za-z]:[\\/]') {
  $npmCodexRoot = Join-Path $applicationDataPath 'npm\node_modules\@openai\codex\node_modules'
  $codexCandidates += (Join-Path $npmCodexRoot $codexVendorRelativePath)
}
$localApplicationDataPath = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
if (-not [string]::IsNullOrWhiteSpace($localApplicationDataPath) -and $localApplicationDataPath -match '^[A-Za-z]:[\\/]') {
  $desktopCliRoot = Join-Path $localApplicationDataPath 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $desktopCliRoot -PathType Container) {
    $codexCandidates += @(
      Get-ChildItem -LiteralPath $desktopCliRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue } |
        Where-Object { -not $_.PSIsContainer } |
        Sort-Object -Property @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, FullName |
        ForEach-Object { $_.FullName }
    )
  }
}
$inheritedCodexExecutable = [Environment]::GetEnvironmentVariable('CODEX_EXECUTABLE', 'Process')
if ($null -ne $inheritedCodexExecutable) {
  throw 'Inherited CODEX_EXECUTABLE is not allowed; ask the user to clear it and confirm the existing executable path explicitly.'
}
$confirmedCodexExecutable = if (-not [string]::IsNullOrWhiteSpace($codexExecutableOverride)) {
  $resolvedCodexExecutable = Resolve-ExistingLocalFile $codexExecutableOverride 'The confirmed Codex executable'
  $resolvedCodexExecutable
} else {
  foreach ($candidate in $codexCandidates) {
    try {
      $resolvedCandidate = Resolve-ExistingLocalFile $candidate 'The Codex candidate'
      $resolvedCandidate
      break
    } catch {}
  }
}
$inheritedCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
$defaultCodexHome = Join-Path ([Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)) '.codex'
if ([string]::IsNullOrWhiteSpace($inheritedCodexHome)) {
  $codexHomeCandidate = $defaultCodexHome
} else {
  $codexHomeCandidate = $inheritedCodexHome
  $defaultCodexHomeResolved = [System.IO.Path]::GetFullPath($defaultCodexHome)
  $inheritedCodexHomeResolved = [System.IO.Path]::GetFullPath($inheritedCodexHome)
  if (-not [string]::Equals($defaultCodexHomeResolved, $inheritedCodexHomeResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    $confirmation = Read-Host 'A custom CODEX_HOME is inherited. Type CONFIRM to use this existing directory for this deployment'
    if ($confirmation -cne 'CONFIRM') {
      throw 'Custom CODEX_HOME was not explicitly confirmed; ask the user and rerun phase A.'
    }
  }
}
$confirmedCodexHome = Resolve-ExistingLocalDirectory $codexHomeCandidate 'The confirmed CODEX_HOME'
Set-Item -Path Env:CODEX_HOME -Value $confirmedCodexHome
if (-not $gitCommand) { throw 'Git for Windows is required.' }
if (-not $nodeCommand) { throw 'Node.js 22.13 or newer is required.' }
if (-not $npmCommand) { throw 'npm.cmd is required.' }
$confirmedGitExecutable = Resolve-ExistingLocalFile $gitCommand.Source 'The confirmed Git executable'
$confirmedNodeExecutable = Resolve-ExistingLocalFile $nodeCommand.Source 'The confirmed Node.js executable'
$confirmedNpmExecutable = Resolve-ExistingLocalFile $npmCommand.Source 'The confirmed npm executable'
if (-not $confirmedCodexExecutable) { throw 'The existing codex.exe is not discoverable.' }
Set-Item -Path Env:CODEX_EXECUTABLE -Value $confirmedCodexExecutable
$confirmedNodeDirectory = Split-Path -Parent $confirmedNodeExecutable
$confirmedNpmDirectory = Split-Path -Parent $confirmedNpmExecutable
if (-not [string]::Equals($confirmedNodeDirectory, $confirmedNpmDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The confirmed node.exe and npm.cmd are not an installed pair in the same directory.'
}
$confirmedNpmCli = Resolve-ExistingLocalFile (Join-Path $confirmedNpmDirectory 'node_modules\npm\bin\npm-cli.js') 'The confirmed npm CLI entry'
& $confirmedGitExecutable --version
if ($LASTEXITCODE -ne 0) { throw 'Git could not report its version.' }
$nodeVersionText = ([string](& $confirmedNodeExecutable --version)).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionText)) {
  throw 'Node.js could not report its version.'
}
$nodeVersionText
if ([version]$nodeVersionText.TrimStart('v') -lt [version]'22.13.0') {
  throw "Node.js 22.13 or newer is required; found $nodeVersionText."
}
$npmVersionText = ([string](& $confirmedNodeExecutable $confirmedNpmCli --version)).Trim()
if ($LASTEXITCODE -ne 0 -or $npmVersionText -notmatch '^\d+\.\d+\.\d+(?:[-+].+)?$') {
  throw 'The confirmed Node.js/npm pair could not report a valid npm version.'
}
Write-Host "npm: $npmVersionText (executed by the confirmed node.exe)"
& $confirmedCodexExecutable --version
if ($LASTEXITCODE -ne 0) { throw 'The existing codex.exe could not report its version.' }
$effectiveExecutionPolicy = Get-ExecutionPolicy
if ($effectiveExecutionPolicy -in @('Restricted', 'AllSigned') -or
    $effectiveExecutionPolicy -notin @('RemoteSigned', 'Unrestricted', 'Bypass')) {
  throw "The effective PowerShell execution policy blocks this repository's unsigned scripts: $effectiveExecutionPolicy"
}
Write-Host "PowerShell execution policy: $effectiveExecutionPolicy"
```

本 Runbook 把目标电脑上的 Codex 已经可用作为硬前提。这里检查 `codex.exe` 是因为 Taskboard 后续需要调用本机 Codex CLI；能打开 Codex Desktop 不等于 CLI 已在 PATH 中。克隆前只做初步定位：PATH、与当前 Windows 进程架构匹配的默认 npm vendor 文件，以及 `%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\codex.exe`；不枚举或运行 Desktop 图形程序。此处尚不能加载仓库脚本，也不宣称与正式发现逻辑完全相同。克隆并验证版本后，阶段 B 必须调用正式 `check-local.ps1 -DependenciesOnly`，其与启动脚本共用 `scripts/codex-discovery.ps1`，按显式路径、PATH、Desktop、npm 实际全局目录、默认 npm vendor 的顺序发现，并为每个候选做 3 秒内成功返回 `codex-cli` 版本号的检查。

进程中只要继承了 `CODEX_EXECUTABLE` 就先停止，不信任其值；若当前 Codex 可以使用，但初步候选都不可发现，Codex 必须只让用户确认现有 CLI 可执行文件的绝对路径。取得确认后，Codex 仅在本次临时 PowerShell 命令副本中把 `$codexExecutableOverride` 赋为该路径并重新执行，用户不编辑 Runbook。用户无法确认现有路径或该文件不能正常报告版本时，停止部署并报告“现有 Codex 不可调用”；本 Runbook 不进入安装、更新、登录或账号修复流程。最终报告只写“已发现”或“未发现”，不打印该路径。

`CODEX_HOME` 是目标用户自己的 Codex 登录目录，不能像其他覆盖变量一样一律拒绝：未设置时固定采用目标用户默认的 `%USERPROFILE%\.codex`；若进程已设置自定义值，Codex 必须先让用户明确确认，再要求它是已存在的绝对路径、固定本地磁盘目录且路径链没有重解析点。阶段 A 保存精确规范化后的 `$confirmedCodexHome`，后续每个会启动 Taskboard/Codex 的 PowerShell 块都显式注入同一个值；不要读取、打印、复制或提交该目录内容。自定义路径未确认、目录不存在、位于 UNC/映射盘或含重解析点时停止。

Codex 必须在自己的部署执行上下文中保留本阶段得到的 `$confirmedGitExecutable`、`$confirmedNodeExecutable`、`$confirmedNpmExecutable`、`$confirmedNpmCli`、`$npmVersionText`、`$confirmedCodexExecutable` 和 `$confirmedCodexHome`；后续代码块中的对应占位符都替换为这些已验证值，不能重新搜索 PATH、`APPDATA`、`CODEX_HOME` 或用户配置来替换这些已确认值。阶段 B 的独立桌面环境预检是单独的兼容性验收，只检查正式自动发现能否成功，不改变这些部署值。Node 与 npm 必须是同一安装目录中的固定 pair；直接 npm 调用一律由已确认的 `node.exe` 显式执行同目录 `node_modules\npm\bin\npm-cli.js`，仓库根脚本内部的 bare `npm` 则通过受控 PATH 解析到同一 `npm.cmd`。路径只用于本机命令调用，不写入仓库、用户级或机器级环境，也不向对话输出。每个启动块都显式把同一个 `$confirmedCodexExecutable` 注入当前进程的 `CODEX_EXECUTABLE`，并把同一个 `$confirmedCodexHome` 注入 `CODEX_HOME`，保证 Taskboard 使用阶段 A 验证过的 Codex 文件和登录目录；这些临时注入不能替代独立桌面环境预检。

源码运行要求 Windows x64、Git for Windows 和 Node.js `22.13` 或更高版本。Vite 8 要求 Node.js `22.12` 或更高版本，而本仓库直接使用的 `node:sqlite` 从 `22.13` 起才无需额外实验开关，因此统一以 `22.13` 为安全下限。Rust、Visual Studio Build Tools 和 Windows SDK 不是源码运行的前置条件；它们只在构建 Windows NSIS 安装包时需要。Git 或 Node.js 缺失、Node.js 版本过低时，暂停并让用户从 [Git for Windows](https://git-scm.com/download/win) 或 [Node.js](https://nodejs.org/en/download) 官方入口完成安装或升级，然后重新运行本阶段检查。仓库的 `.ps1` 文件没有代码签名；若有效执行策略为 `Restricted`、`AllSigned`、`Undefined`，或企业策略实际阻止脚本，暂停并让用户按组织批准的方式处理，不运行全局 `Set-ExecutionPolicy ... Bypass`、不修改企业策略。

工具检查通过后，在用户给出的工作目录中执行。若尚未克隆，用户确认目录后执行：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (-not $pathItem.PSIsContainer) {
        throw "$Label path must contain only directories."
      }
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$workDirectory = '<用户已确认的绝对工作目录>'
if ([string]::IsNullOrWhiteSpace($workDirectory) -or $workDirectory -notmatch '^[A-Za-z]:[\\/]') {
  throw 'The confirmed work directory must be a fully qualified fixed-local-drive path.'
}
try {
  $workDirectory = [System.IO.Path]::GetFullPath($workDirectory)
} catch {
  throw 'The confirmed work directory is invalid.'
}
$workDriveRoot = [System.IO.Path]::GetPathRoot($workDirectory)
try {
  $workDrive = [System.IO.DriveInfo]::new($workDriveRoot)
} catch {
  throw 'The clone target drive could not be inspected.'
}
if (-not $workDrive.IsReady -or $workDrive.DriveType -ne [System.IO.DriveType]::Fixed) {
  throw 'The clone target must be on a ready fixed local drive; mapped network and removable drives are not allowed.'
}
if (Test-Path -LiteralPath $workDirectory) {
  throw 'The clone target already exists; inspect it instead of overwriting it.'
}
$workParent = Split-Path -Parent $workDirectory
$pathCursor = $workParent
while (-not [string]::IsNullOrWhiteSpace($pathCursor)) {
  if (Test-Path -LiteralPath $pathCursor) {
    $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
    if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'The clone target path may not pass through a symbolic link, junction, or other reparse point.'
    }
  }
  if ([string]::Equals($pathCursor, [System.IO.Path]::GetPathRoot($pathCursor), [System.StringComparison]::OrdinalIgnoreCase)) {
    break
  }
  $nextCursor = Split-Path -Parent $pathCursor
  if ([string]::IsNullOrWhiteSpace($nextCursor) -or
      [string]::Equals($nextCursor, $pathCursor, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The clone target path could not be verified to its drive root.'
  }
  $pathCursor = $nextCursor
}
New-Item -ItemType Directory -Force -Path $workParent | Out-Null
$workParent = Resolve-ExistingLocalDirectory $workParent 'The clone target parent'
if (Test-Path -LiteralPath $workDirectory) {
  throw 'The clone target appeared while its parent was being prepared; stop instead of overwriting it.'
}
$emptyGitHome = Join-Path $workParent ('.codex-git-home-' + [Guid]::NewGuid().ToString('N'))
$emptyGitTemplate = Join-Path $emptyGitHome 'template'
New-Item -ItemType Directory -Path $emptyGitTemplate | Out-Null
$emptyGitHome = Resolve-ExistingLocalDirectory $emptyGitHome 'The isolated Git home'
$emptyGitTemplate = Resolve-ExistingLocalDirectory $emptyGitTemplate 'The isolated Git template'
$emptyGitConfig = Join-Path $emptyGitHome 'global.gitconfig'
New-Item -ItemType File -Path $emptyGitConfig | Out-Null
$emptyGitConfig = Resolve-ExistingLocalFile $emptyGitConfig 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$workParent = Resolve-ExistingLocalDirectory $workParent 'The clone target parent'
if (Test-Path -LiteralPath $workDirectory) {
  throw 'The clone target appeared before git clone; stop instead of overwriting it.'
}
& $confirmedGitExecutable `
  -c credential.interactive=never `
  -c protocol.allow=never `
  -c protocol.https.allow=always `
  clone --config core.hooksPath=NUL --template=$emptyGitTemplate --no-local `
  https://github.com/fengcong22/feishu-codex-Taskboard.git $workDirectory
if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
$repositoryRoot = Resolve-ExistingLocalDirectory $workDirectory 'The fresh clone root'
$expectedGitDirectory = Resolve-ExistingLocalDirectory (Join-Path $repositoryRoot '.git') 'The fresh clone metadata directory'
```

该克隆只接受就绪的本地固定磁盘，并拒绝路径链中的符号链接、junction 和其他重解析点；映射网络盘、UNC、设备路径和可移动盘均不符合条件。克隆使用一个新建的零字节全局 Git 配置文件和空模板目录，隔离系统/全局 Git 配置、模板、hooks 和非 HTTPS transport；不读取用户凭据，也不允许交互式认证。规范仓库是公开仓库，出现认证提示、协议拒绝或 clone 失败时立即停止，不放宽隔离边界。目录检查会在创建父目录、临时 Git 路径和 clone 后重新执行，以缩短路径被替换的窗口；这类 PowerShell 检查不是原子 no-follow 句柄保证，若要抵御同机并发恶意写入，必须另行采用 Win32 级别的无跟随句柄设计。

Codex 在自己的部署执行上下文中保留 `$emptyGitConfig` 的完全限定路径。后续信任核对和阶段 B 的最后一次工作树核对只把它作为 `GIT_CONFIG_GLOBAL` 使用；阶段 B 随后会在该克隆被 Git 忽略的固定 `.runtime\bootstrap` 目录中创建日常使用的零字节 Git/npm 配置。这些路径不写入 Git 或对话。只有阶段 B 已成功创建并启用固定隔离配置后，外部 Git 临时目录才不再是本克隆的运行依赖；Runbook 不替用户删除它。

如果用户选择了其他全新本地目录，所有后续命令都使用该目录并通过 `-LiteralPath` 进入，不要把示例路径写进本机配置。目标目录已存在时，本 Runbook 必须停止并让用户另选尚不存在的路径，不检查、清理、覆盖或复用其中内容。clone 完成后先在一个新的、没有上述临时变量的 PowerShell 进程中，只核对仓库身份、本机 Git 元数据与版本，不读取或执行尚未验证的仓库说明、依赖或脚本：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (-not $pathItem.PSIsContainer) {
        throw "$Label path must contain only directories."
      }
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$repositoryRoot = Resolve-ExistingLocalDirectory '<工作目录>' 'The fresh clone root'
$expectedGitDirectory = Resolve-ExistingLocalDirectory (Join-Path $repositoryRoot '.git') 'The fresh clone metadata directory'
Set-Location -LiteralPath $repositoryRoot -ErrorAction Stop
$emptyGitConfig = Resolve-ExistingLocalFile '<克隆阶段创建的零字节 Git 配置文件完全限定路径>' 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$originUrl = ([string](& $confirmedGitExecutable remote get-url origin 2>$null)).Trim()
$canonicalOriginPattern = '^https://github\.com/fengcong22/feishu-codex-Taskboard(?:\.git)?/?$'
if ($LASTEXITCODE -ne 0 -or $originUrl -notmatch $canonicalOriginPattern) {
  throw 'origin does not match the canonical GitHub repository; do not print the stored URL.'
}
Write-Host 'origin: canonical repository confirmed'
$topLevelText = ([string](& $confirmedGitExecutable rev-parse --show-toplevel 2>$null)).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Git worktree root.' }
$topLevel = Resolve-ExistingLocalDirectory $topLevelText 'The Git worktree root'
if (-not [string]::Equals($repositoryRoot, $topLevel, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The selected directory is not the root of this fresh clone.'
}
$gitDirectoryText = ([string](& $confirmedGitExecutable rev-parse --git-dir 2>$null)).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Git metadata directory.' }
if ($gitDirectoryText -match '^[A-Za-z]:[\\/]') {
  $gitDirectoryCandidate = $gitDirectoryText
} else {
  $gitDirectoryCandidate = Join-Path $repositoryRoot $gitDirectoryText
}
$gitDirectory = Resolve-ExistingLocalDirectory $gitDirectoryCandidate 'The resolved Git metadata directory'
if (-not [string]::Equals($gitDirectory, $expectedGitDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The fresh clone does not use its standard local .git directory.'
}
$specialIndexEntries = @(& $confirmedGitExecutable ls-files -v | Where-Object { $_ -cmatch '^(?:[a-z]|S) ' })
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git index flags.' }
if ($specialIndexEntries.Count -gt 0) { throw 'Git index contains assume-unchanged or skip-worktree entries.' }
$replacementRefs = @(& $confirmedGitExecutable replace -l)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git replacement refs.' }
if ($replacementRefs.Count -gt 0) { throw 'Git replacement refs are not allowed.' }
foreach ($metadataPath in @((Join-Path $gitDirectory 'info\grafts'), (Join-Path $gitDirectory 'objects\info\alternates'))) {
  if (Test-Path -LiteralPath $metadataPath) { throw 'Git grafts or alternate object stores are not allowed.' }
}
$worktreeStatus = @(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not read the Git worktree status.' }
if ($worktreeStatus.Count -ne 0) {
  throw 'The Git worktree has local changes; preserve them and stop before running repository code.'
}
$branch = ([string](& $confirmedGitExecutable branch --show-current)).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git branch.' }
$commit = ([string](& $confirmedGitExecutable rev-parse HEAD)).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Could not read the complete Git commit SHA.'
}
Write-Host "branch: $(if ($branch) { $branch } else { 'detached' })"
Write-Host "commit: $commit"
Write-Host 'worktree: clean'
```

若发送方给出了批准的 tag 名称或完整 commit SHA，Codex 按两种方式验证：tag 只从已经核对过的规范 HTTPS URL 精确获取并从本次 fetch 的 `FETCH_HEAD` 解析；完整 SHA 必须是本次从该 URL 获取的 `main` 历史中的 commit。所有网络 fetch 都用命令级隔离配置，不读取系统/全局 Git 配置，不采用 `origin` 的 fetch URL、push URL 或 `url.*.insteadOf` 改写。非 SHA 输入不能解析成本地 tag 或同名本地分支；不在 `main` 历史中的发布版本必须由发送方提供规范远端 tag。获取、解析、历史核对或切换失败就停止：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (-not $pathItem.PSIsContainer) {
        throw "$Label path must contain only directories."
      }
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$repositoryRoot = Resolve-ExistingLocalDirectory '<工作目录>' 'The approved repository root'
$expectedGitDirectory = Resolve-ExistingLocalDirectory (Join-Path $repositoryRoot '.git') 'The approved repository metadata directory'
Set-Location -LiteralPath $repositoryRoot -ErrorAction Stop
$emptyGitConfig = Resolve-ExistingLocalFile '<克隆阶段创建的零字节 Git 配置文件完全限定路径>' 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$canonicalRepositoryUrl = 'https://github.com/fengcong22/feishu-codex-Taskboard.git'
$isolatedGitArguments = @(
  '-c', 'credential.interactive=never',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always'
)
$approvedRef = '<发送方批准的 tag 或完整 commit SHA>'
if ($approvedRef -match '^[0-9a-fA-F]{40}$') {
  $approvedSha = $approvedRef.ToLowerInvariant()
  & $confirmedGitExecutable @isolatedGitArguments fetch --no-tags --refmap= $canonicalRepositoryUrl refs/heads/main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch main from canonical origin.' }
  $fetchedMain = ([string](& $confirmedGitExecutable rev-parse --verify 'FETCH_HEAD^{commit}' 2>$null)).Trim()
  if ($LASTEXITCODE -ne 0 -or $fetchedMain -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'Could not resolve the freshly fetched canonical main commit.'
  }
  $approvedObjectType = ([string](& $confirmedGitExecutable cat-file -t $approvedRef 2>$null)).Trim()
  if ($LASTEXITCODE -ne 0 -or $approvedObjectType -ne 'commit') {
    throw 'The approved complete SHA is not an available commit object.'
  }
  $verifyExpression = $approvedRef + '^{commit}'
  $approvedCommit = ([string](& $confirmedGitExecutable rev-parse --verify $verifyExpression 2>$null)).Trim()
  if ($LASTEXITCODE -ne 0 -or $approvedCommit.ToLowerInvariant() -ne $approvedSha) {
    throw 'The approved complete SHA did not resolve to that exact commit.'
  }
  & $confirmedGitExecutable merge-base --is-ancestor $approvedCommit $fetchedMain
  if ($LASTEXITCODE -ne 0) {
    throw 'The approved complete SHA is not in the freshly fetched canonical main history; require a canonical remote tag instead.'
  }
} else {
  if ($approvedRef.StartsWith('-') -or $approvedRef.StartsWith('refs/')) {
    throw 'The approved tag name is not in the allowed form.'
  }
  $approvedTagRef = 'refs/tags/' + $approvedRef
  & $confirmedGitExecutable check-ref-format $approvedTagRef
  if ($LASTEXITCODE -ne 0) {
    throw 'The approved tag name is not a valid Git tag ref.'
  }
  & $confirmedGitExecutable @isolatedGitArguments fetch --no-tags --refmap= $canonicalRepositoryUrl $approvedTagRef
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the approved tag from canonical origin.' }
  $approvedCommit = ([string](& $confirmedGitExecutable rev-parse --verify 'FETCH_HEAD^{commit}' 2>$null)).Trim()
  if ($LASTEXITCODE -ne 0 -or $approvedCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'The freshly fetched approved tag could not be resolved to a commit.'
  }
}
& $confirmedGitExecutable -c core.hooksPath=NUL switch --detach --no-overwrite-ignore $approvedCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not switch to the approved commit.' }
$currentCommit = ([string](& $confirmedGitExecutable rev-parse HEAD)).Trim()
if ($LASTEXITCODE -ne 0 -or $currentCommit -ne $approvedCommit) {
  throw 'The checked-out commit does not match the approved ref.'
}
if (@(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all).Count -ne 0 -or $LASTEXITCODE -ne 0) {
  throw 'The approved checkout is not clean.'
}
```

若发送方没有给出批准 ref，只允许使用与规范 HTTPS URL 本次返回的 `main` 完全一致的干净本地 `main`；旧版本、本地超前提交和其他分支都先停止，不得执行其中的 npm 脚本：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (-not $pathItem.PSIsContainer) {
        throw "$Label path must contain only directories."
      }
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$emptyGitConfig = Resolve-ExistingLocalFile '<克隆阶段创建的零字节 Git 配置文件完全限定路径>' 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$repositoryRoot = Resolve-ExistingLocalDirectory '<工作目录>' 'The verified main repository root'
$expectedGitDirectory = Resolve-ExistingLocalDirectory (Join-Path $repositoryRoot '.git') 'The verified main repository metadata directory'
Set-Location -LiteralPath $repositoryRoot -ErrorAction Stop
$canonicalRepositoryUrl = 'https://github.com/fengcong22/feishu-codex-Taskboard.git'
$isolatedGitArguments = @(
  '-c', 'credential.interactive=never',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always'
)
$branch = ([string](& $confirmedGitExecutable branch --show-current)).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
  throw 'No approved ref was provided, so the checkout must be main.'
}
$commit = ([string](& $confirmedGitExecutable rev-parse HEAD)).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Could not read the complete local commit SHA.'
}
& $confirmedGitExecutable @isolatedGitArguments fetch --no-tags --refmap= $canonicalRepositoryUrl refs/heads/main
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch main from canonical origin.' }
$fetchedMain = ([string](& $confirmedGitExecutable rev-parse --verify 'FETCH_HEAD^{commit}' 2>$null)).Trim()
if ($LASTEXITCODE -ne 0 -or $fetchedMain -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Could not resolve the freshly fetched canonical main commit.'
}
if ($commit -ne $fetchedMain) {
  throw 'Local main is not exactly the freshly fetched canonical main; stop for an explicit update decision.'
}
```

上述批准 ref 或规范远端最新 `main` 二选一的版本门禁通过后，Codex 才读取本次已验证检出中的规则与说明：

```powershell
$ErrorActionPreference = 'Stop'
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (-not $pathItem.PSIsContainer) {
        throw "$Label path must contain only directories."
      }
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$repositoryRoot = Resolve-ExistingLocalDirectory '<工作目录>' 'The verified repository root'
$expectedGitDirectory = Resolve-ExistingLocalDirectory (Join-Path $repositoryRoot '.git') 'The verified repository metadata directory'
Set-Location -LiteralPath $repositoryRoot -ErrorAction Stop
Get-Content -Raw -Encoding UTF8 .\AGENTS.md
Get-Content -Raw -Encoding UTF8 .\README.md
Get-Content -Raw -Encoding UTF8 .\docs\windows-source-install-guide.zh-CN.md
```

若仓库内 Runbook 与外部收到的版本不同，以已验证 commit 中的仓库版本为准，但不得因此越过本文开头的隐私、loopback、自动执行关闭和“现有 Codex 不可用即停止”边界。最终报告记录实际完整 SHA。不得把目标电脑取得的版本描述为与发送方未推送的本地提交一致。

## 3. 阶段 B：安装依赖并通过测试门

Codex 执行：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (-not $pathItem.PSIsContainer) {
        throw "$Label path must contain only directories."
      }
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$confirmedNpmExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 npm.cmd 完全限定路径>' 'The confirmed npm executable'
$confirmedNodeDirectory = Split-Path -Parent $confirmedNodeExecutable
$confirmedNpmDirectory = Split-Path -Parent $confirmedNpmExecutable
if (-not [string]::Equals($confirmedNodeDirectory, $confirmedNpmDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The confirmed node.exe and npm.cmd are no longer the same installed pair.'
}
$confirmedNpmCli = Resolve-ExistingLocalFile (Join-Path $confirmedNpmDirectory 'node_modules\npm\bin\npm-cli.js') 'The confirmed npm CLI entry'
$expectedNpmVersion = '<阶段 A 已验证的 npm 版本>'
$currentNpmVersion = ([string](& $confirmedNodeExecutable $confirmedNpmCli --version)).Trim()
if ($LASTEXITCODE -ne 0 -or $currentNpmVersion -ne $expectedNpmVersion) {
  throw 'The confirmed Node.js/npm pair no longer matches phase A.'
}
$emptyGitConfig = Resolve-ExistingLocalFile '<克隆阶段创建的零字节 Git 配置文件完全限定路径>' 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$env:PATH = $confirmedNodeDirectory + ';' + $env:PATH
foreach ($tool in @(
  @{ Name = 'git.exe'; Expected = $confirmedGitExecutable; Label = 'Git' },
  @{ Name = 'node.exe'; Expected = $confirmedNodeExecutable; Label = 'Node.js' },
  @{ Name = 'npm.cmd'; Expected = $confirmedNpmExecutable; Label = 'npm' }
)) {
  $resolvedCommand = Get-Command $tool.Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolvedCommand -or $resolvedCommand.CommandType -ne 'Application') {
    throw "$($tool.Label) is shadowed or unavailable in this PowerShell process."
  }
  $resolvedCommandPath = Resolve-ExistingLocalFile $resolvedCommand.Source "The resolved $($tool.Label) executable"
  if (-not [string]::Equals($resolvedCommandPath, $tool.Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$($tool.Label) no longer resolves to the executable verified in phase A."
  }
}
$repositoryRoot = Resolve-ExistingLocalDirectory '<工作目录>' 'The verified repository root'
$expectedGitDirectory = Resolve-ExistingLocalDirectory (Join-Path $repositoryRoot '.git') 'The verified repository metadata directory'
Set-Location -LiteralPath $repositoryRoot -ErrorAction Stop
$expectedCommit = '<阶段 A 已验证的完整 commit SHA>'
if ($expectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'The verified commit SHA is missing.' }
$currentCommit = ([string](& $confirmedGitExecutable rev-parse --verify HEAD 2>$null)).Trim()
if ($LASTEXITCODE -ne 0 -or $currentCommit -ne $expectedCommit.ToLowerInvariant()) {
  throw 'The checkout no longer matches the verified commit.'
}
$specialIndexEntries = @(& $confirmedGitExecutable ls-files -v | Where-Object { $_ -cmatch '^(?:[a-z]|S) ' })
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git index flags.' }
if ($specialIndexEntries.Count -gt 0) { throw 'Git index contains assume-unchanged or skip-worktree entries.' }
$replacementRefs = @(& $confirmedGitExecutable replace -l)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git replacement refs.' }
if ($replacementRefs.Count -gt 0) { throw 'Git replacement refs are not allowed.' }
$gitDirectoryText = ([string](& $confirmedGitExecutable rev-parse --git-dir 2>$null)).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Git metadata directory.' }
if ($gitDirectoryText -match '^[A-Za-z]:[\\/]') {
  $gitDirectoryCandidate = $gitDirectoryText
} else {
  $gitDirectoryCandidate = Join-Path $repositoryRoot $gitDirectoryText
}
$gitDirectory = Resolve-ExistingLocalDirectory $gitDirectoryCandidate 'The resolved Git metadata directory'
if (-not [string]::Equals($gitDirectory, $expectedGitDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The verified checkout no longer uses its standard local .git directory.'
}
foreach ($metadataPath in @((Join-Path $gitDirectory 'info\grafts'), (Join-Path $gitDirectory 'objects\info\alternates'))) {
  if (Test-Path -LiteralPath $metadataPath) { throw 'Git grafts or alternate object stores are not allowed.' }
}
$worktreeStatus = @(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not read the Git worktree status.' }
if ($worktreeStatus.Count -gt 0) { throw 'The verified checkout has local changes; preserve them and stop.' }
$desktopPreflightScript = @'
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw 'DESKTOP_PREFLIGHT_UNSAFE_ENVIRONMENT'
}
foreach ($scope in @('User', 'Machine')) {
  if ($null -ne [Environment]::GetEnvironmentVariable('CODEX_EXECUTABLE', $scope)) {
    throw 'DESKTOP_PREFLIGHT_PERSISTED_CODEX_OVERRIDE'
  }
}
$persistentMachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$persistentUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = [Environment]::ExpandEnvironmentVariables((@($persistentMachinePath, $persistentUserPath) -join ';'))
Remove-Item -LiteralPath Env:CODEX_EXECUTABLE -ErrorAction SilentlyContinue
try {
  .\scripts\check-local.ps1 -DependenciesOnly
  Write-Host 'DESKTOP_DEPENDENCIES_OK'
} catch {
  Write-Host 'DESKTOP_DEPENDENCIES_FAILED'
  exit 1
}
'@
$desktopPreflightInfo = [System.Diagnostics.ProcessStartInfo]::new()
$desktopPreflightInfo.FileName = Join-Path $PSHOME 'powershell.exe'
$desktopPreflightInfo.WorkingDirectory = $repositoryRoot
$desktopPreflightInfo.UseShellExecute = $false
$desktopPreflightInfo.CreateNoWindow = $true
$desktopPreflightInfo.RedirectStandardOutput = $true
$desktopPreflightInfo.RedirectStandardError = $true
$desktopPreflightInfo.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($desktopPreflightScript))
# These two variables were added by this block only after the complete inherited-variable gate.
# Drop them only from the child; it independently applies the same gate before running any tools.
$desktopPreflightInfo.EnvironmentVariables.Remove('GIT_CONFIG_NOSYSTEM')
$desktopPreflightInfo.EnvironmentVariables.Remove('GIT_CONFIG_GLOBAL')
$desktopPreflightProcess = [System.Diagnostics.Process]::Start($desktopPreflightInfo)
$desktopPreflightOutput = $desktopPreflightProcess.StandardOutput.ReadToEndAsync()
$desktopPreflightError = $desktopPreflightProcess.StandardError.ReadToEndAsync()
try {
  if (-not $desktopPreflightProcess.WaitForExit(60000)) {
    $desktopPreflightProcess.Kill()
    throw 'Independent desktop dependency preflight timed out.'
  }
  if ($desktopPreflightProcess.ExitCode -ne 0) {
    throw 'DESKTOP_DEPENDENCIES_FAILED: independent desktop dependency preflight failed; do not report deployment success.'
  }
  Write-Host 'DESKTOP_DEPENDENCIES_OK'
} finally {
  $desktopPreflightProcess.Dispose()
}
$runtimeDirectory = Join-Path $repositoryRoot '.runtime'
$isolationDirectory = Join-Path $runtimeDirectory 'bootstrap'
foreach ($directory in @($runtimeDirectory, $isolationDirectory)) {
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
  }
  $directoryItem = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
  if (-not $directoryItem.PSIsContainer -or
      ($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The runtime isolation path must contain only ordinary local directories.'
  }
}
$serviceGitConfig = Join-Path $isolationDirectory 'empty.gitconfig'
$emptyNpmUserConfig = Join-Path $isolationDirectory 'user.npmrc'
$emptyNpmGlobalConfig = Join-Path $isolationDirectory 'global.npmrc'
foreach ($configPath in @($serviceGitConfig, $emptyNpmUserConfig, $emptyNpmGlobalConfig)) {
  if (-not (Test-Path -LiteralPath $configPath)) {
    New-Item -ItemType File -Path $configPath -ErrorAction Stop | Out-Null
  }
  $verifiedConfigPath = Resolve-ExistingLocalFile $configPath 'A runtime isolation config'
  if ((Get-Item -LiteralPath $verifiedConfigPath -Force).Length -ne 0) {
    throw 'A runtime isolation config is no longer empty.'
  }
}
$env:GIT_CONFIG_GLOBAL = $serviceGitConfig
$env:NPM_CONFIG_USERCONFIG = $emptyNpmUserConfig
$env:NPM_CONFIG_GLOBALCONFIG = $emptyNpmGlobalConfig
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
$effectiveRegistry = ([string](& $confirmedNodeExecutable $confirmedNpmCli config get registry)).Trim()
if ($LASTEXITCODE -ne 0 -or $effectiveRegistry -ne 'https://registry.npmjs.org/') {
  throw 'The isolated npm registry does not match the approved default.'
}
& $confirmedNodeExecutable $confirmedNpmCli ci
if ($LASTEXITCODE -ne 0) { throw 'Root dependency installation from the approved lockfile failed.' }
& $confirmedNodeExecutable $confirmedNpmCli ci --prefix taskboard
if ($LASTEXITCODE -ne 0) { throw 'Taskboard dependency installation failed.' }
& $confirmedNodeExecutable $confirmedNpmCli test
if ($LASTEXITCODE -ne 0) { throw 'Repository tests failed.' }
$postInstallStatus = @(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Could not verify the worktree after dependency installation and tests.' }
if ($postInstallStatus.Count -gt 0) {
  throw 'Dependency installation or tests changed the approved worktree; preserve the changes and stop.'
}
```

上述独立桌面环境预检在创建配置和安装依赖之前运行：新建一个 `-NoProfile` PowerShell 进程，以持久的用户/系统 PATH 覆盖部署进程临时追加的 PATH，并确保没有临时或持久的 `CODEX_EXECUTABLE`。它重做完整环境门禁，只从子进程移除本代码块自己在门禁后设置的两项 Git 隔离变量；不会修改父进程、用户级或机器级环境。`check-local.ps1 -DependenciesOnly` 只验证 Node.js 和 Codex CLI，不读取项目本机 JSON、不创建或修改项目配置和运行状态、不启动服务，也不要求服务在线。仅此依赖定位预检允许以 `npm root --global` 只读解析本机 npm 配置中的实际全局安装目录；后续依赖安装和服务启动仍必须遵循原有隔离配置。输出仅包含固定结果码，不含可执行文件路径。单个 Codex 候选最多等待 3 秒，整个独立检查最多等待 60 秒；失效版本会继续尝试其余批准候选，Desktop 版本候选按文件修改时间从新到旧排列。失败必须先保留为“未完成”，不能靠重新注入部署会话的 `$confirmedCodexExecutable` 绕过，也不能安装或修复 Codex。这个检查避免“部署会话可以启动，之后桌面双击找不到 CLI”的假成功；它不证明用户登录状态、服务健康或任务已经能执行。若后续安装工具改变了持久 PATH，须重新做同一独立检查；资源管理器可能保留旧环境，必要时重新登录 Windows 后再验收双击入口。

两层依赖都必须通过 `npm ci` 从批准版本的 lockfile 安装。上述进程级 npm 设置只指向本克隆 `.runtime\bootstrap` 中新建并重新核对为零字节的两份配置，并把 npm 的默认 registry 配置为官方地址；因此不会读取目标电脑的用户级或全局 `.npmrc`，也不会把设置持久化到用户级或机器级环境。不得设置 `replace-registry-host=always` 或重写 lockfile；`package-lock.json` 和 `taskboard/package-lock.json` 中已经记录的 `resolved` URL 必须按批准版本保留，`npm ci` 在 manifest 与 lockfile 不一致时直接失败。两层安装和完整测试后必须再次确认整个仓库工作树干净。若团队要求统一供应链来源，维护者必须另行重新生成、审查并提交 lockfile。固定目录中的空 Git/npm 配置是该部署的本机运行文件，后续启动仍会核对并使用，不能复制给别人，也不要单独删除或修改。仓库内不存在 `.npmrc`，若批准版本以后新增该文件，它属于已验证 commit 的一部分，必须在部署前重新评审。直接 npm 调用由已确认的 Node 显式执行已确认的 `npm-cli.js`；根 `test` 脚本内的 bare `npm` 通过受控 PATH 解析到同一安装目录中的 `npm.cmd`。测试失败、lockfile 不一致或工作树变化时停止，不连接真实飞书、不修改生产 Base，并在报告中保留失败命令和安全错误摘要。

## 4. 阶段 C：准备本机配置并请求人工输入

如果文件不存在，Codex 可以只复制示例，不覆盖已有本机文件：

```powershell
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
if (-not (Test-Path .\config\bridge.local.json)) {
  Copy-Item .\config\bridge.example.json .\config\bridge.local.json
}
if (-not (Test-Path .\config\taskboard-feishu-packages.json)) {
  Copy-Item .\config\autocut-packages.example.json .\config\taskboard-feishu-packages.json
}
```

示例含占位符，不能直接连接真实 Base 或创建业务任务。首次无害验收必须使用当前 Bridge 原生支持的 legacy `tables` 单一可开始值路径，不能先从 Taskboard UI 导入 phased 草稿后再尝试禁用全部阶段；当前 UI 会要求 phased subject 至少启用一个阶段。Codex 只在本轮新生成的 `bridge.local.json` 中把 `stateFile` 改成当前克隆目录下的 `.runtime\bridge\state.json` 绝对路径，把 `workflowFile` 固定写成同一克隆目录下的 `.runtime\bridge\workflow.json` 绝对路径，并保留一个由用户在本机填写和确认的测试 `tables` 条目。当前标准入口实际固定使用 `<工作目录>\.runtime\bridge\workflow.json`，不会采用 `bridge.local.json` 中的自定义 `workflowFile` 位置，因此该键只允许填写上述一致路径。Codex 应使用结构化 JSON 工具修改，修改后重新解析校验。若文件在本轮开始前已经存在，不覆盖、不清空其中任何配置。

由用户在本机编辑器填写首次无害验收所需的 legacy `tables` 配置；不要猜值，也不要把值写入飞书单元格。首次验收完成后，如需转为 Taskboard 管理的 phased 工作流，必须另行通过 UI 导入并准备至少一个已启用阶段所需的完整 ZIP 来源和 driver report fixture，不与本次 legacy 验收混用：

### `config/bridge.local.json`

- 自己的 `baseToken`、`tableId`、表名；
- 触发字段名称和稳定 ID（`triggerField`、`triggerFieldId`）；
- 触发状态值及可选 option ID（进入该值才登记任务）；
- 标题字段及回退字段；
- 必须配置一个已启用的 `defaultPackageAlias`；只有经过专门 fixture 证明同一状态事件确实携带项目包字段时，才能额外使用受控的 `packageField`/`packageFieldId`，不能只依赖它们；
- 当前电脑的绝对 `stateFile`，以及固定为 `<工作目录>\.runtime\bridge\workflow.json` 的 `workflowFile`。

必须保持：

```json
{
  "host": "127.0.0.1",
  "port": 47824,
  "taskboardUrl": "http://127.0.0.1:47823"
}
```

状态文件必须是稳定的普通文件路径，不使用符号链接、硬链接或运行中替换路径。飞书单元格只能提供白名单允许的状态值和项目包 alias，不能提供路径、shell 命令、Codex 参数、prompt 或秘密。

### `config/taskboard-feishu-packages.json`

新生成 registry 中的无害示例包可以由 Codex 把 `workspacePath` 自动改成当前仓库的 `examples\harmless-auto-cut` 绝对路径，但不得替用户添加真实工作区或改写 prompt。用户必须为每个真实包确认：

- 与飞书字段完全一致的受控 `alias`；
- 本机唯一且固定的 `projectId`；
- 当前电脑上现有的完全限定本地固定磁盘目录 `workspacePath`，且路径链不能包含符号链接、junction 或其他重解析点；
- 团队批准的固定 `prompt`；
- 当前电脑 Codex 实际提供的 `model` 和该模型支持的 `reasoningEffort`；
- 正整数 `maxConcurrent`；
- `state` 是否为 `"enabled"`。

只有 `enabled` 包进入 Bridge 白名单。通过 Taskboard 启用包时必须从本机模型目录选择有效的模型和推理强度，不能照抄另一台电脑的模型值。首次验收优先使用仓库提供的 `examples/harmless-auto-cut` 做无害演练，真实工作区和 prompt 必须由团队另行批准。

### `.env.local`

Codex 不索取或回显秘密。只告诉用户在目标电脑本地创建或编辑该文件，并填写自己的值：

```dotenv
FEISHU_APP_ID=由本人填写
FEISHU_APP_SECRET=由本人填写
```

统一使用 `scripts/start-local.ps1` 时，不要求手工填写 `CODEX_FEISHU_BRIDGE_SECRET`；脚本会为本次启动生成随机值，同时注入 Taskboard 和 Bridge。首次部署不得设置 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION`。

配置完成后，Codex 只能做不泄露内容的校验：文件存在、JSON 可解析、必需键存在、执行工作区位于本地固定磁盘且路径链无重解析点、包 alias 已启用、地址仍为 loopback。不要把配置文件全文放进回复或日志。`workflowFile` 是 Taskboard 管理的运行配置，不得手工创建、复制或编辑。

## 5. 阶段 D：人工完成自己的飞书接入

以下条目是 Codex 的内部检查点，不是要原样转发给用户的操作教程。Codex 到达本阶段后按顺序确认状态，每次只说明当前阻塞项所需的最少人工动作，等待用户确认完成后再进入下一项；全部确认前不得继续真实连接。

1. 在自己的飞书企业中创建企业自建应用，取得自己的 App ID 和 App Secret，并由管理员按企业策略批准。
2. 在应用事件订阅中选择官方 SDK 长连接，订阅仓库实际处理的事件：`drive.file.bitable_record_changed_v1`。长连接不要求为 Bridge 暴露公网回调地址。
3. 确认这些调用使用企业自建应用身份：官方 SDK 通过本机的 App ID/Secret 获取租户访问凭证，不使用电脑所有者的飞书 user OAuth 登录。按“应用身份”的事件详情页和相关 API“所需权限”申请最小 Base 只读能力，覆盖 Base 元数据、子表、字段/选项、记录读取和记录搜索。遇到 `missing_scopes` 或 `console_url` 时按后台当前页面补齐，不能猜权限名称，也不要为了方便申请宽泛写入权限。
4. 如果使用 `/wiki/` 链接导入 Base，再按后台要求申请 Wiki 节点只读权限；直接使用 `/base/` 链接不需要 Wiki 节点权限。
5. 在自己的测试 Base 中给该应用配置资源访问权限，准备专用测试子表、状态字段、标题字段和受控项目包 alias。API 权限不等于 Base 资源 ACL。
6. 发布或启用符合企业策略的应用版本。仓库不会自动调用一次性 Base 文件事件订阅 API；如果租户要求该步骤，由 Base owner、manager 或管理员按飞书官方流程人工完成。
7. 由用户在本机编辑 `.env.local` 和首次验收所需的 legacy `tables` 本机 JSON 配置；Base token、表/字段 ID 和状态值只在本机编辑器中填写。绝不把 App Secret、Base token 或 Bridge Secret 粘贴给 Codex。

参考官方飞书资料：[多维表格记录变更事件](https://open.feishu.cn/document/docs/bitable-v1/events/bitable_record_changed.md)、[事件订阅长连接配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md)、[应用权限申请说明](https://open.feishu.cn/document/server-docs/application-scope/introduction.md)、[多维表格概述与鉴权](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview.md)、[知识库节点概述与鉴权](https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-overview)。

## 6. 阶段 E：本地安全验收

Codex 先只读检查会改变首次部署目标的高级覆盖项、当前进程是否已经启用飞书读取/监听或自动执行，以及 `.env.local` 是否只包含允许的两项飞书应用凭据。检查只返回变量名或布尔结果，不输出路径、`.env.local` 的匹配行或任何值：

下面的代码块必须填入阶段 A 已验证的 Git、Node.js、npm 和 Codex 四个完全限定路径。它先让启动脚本及其子进程从 PATH 解析到同一 Git、Node.js 和 npm 文件，无条件注入同一个 Codex 文件，并重新核对、启用本克隆 `.runtime\bootstrap` 中的隔离 Git/npm 配置；任一路径或隔离文件缺失、变化、非空或被 PowerShell 函数/别名遮蔽都停止。不要重新发现路径，也不要把路径持久化到用户级/机器级环境或版本控制文件。

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
function Resolve-ExistingLocalDirectory([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $driveRoot = [System.IO.Path]::GetPathRoot($candidatePath)
    $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
  } catch {
    throw "$Label could not be normalized or its drive could not be inspected."
  }
  if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
    throw "$Label must be on a ready fixed local drive."
  }
  $pathCursor = $driveRoot
  foreach ($segment in ($candidatePath.Substring($driveRoot.Length) -split '[\\/]' | Where-Object { $_ })) {
    $pathCursor = Join-Path $pathCursor $segment
    try {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
    } catch {
      throw "$Label is not an existing local directory."
    }
    if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path may not contain a symbolic link, junction, or other reparse point."
    }
  }
  $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw "$Label is not an existing local directory."
  }
  [string]$resolved.ProviderPath
}
$repositoryRoot = Resolve-ExistingLocalDirectory '<工作目录>' 'The repository directory'
Set-Location -LiteralPath $repositoryRoot -ErrorAction Stop
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$confirmedNpmExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 npm.cmd 完全限定路径>' 'The confirmed npm executable'
$confirmedCodexExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 codex.exe 完全限定路径>' 'The confirmed Codex executable'
$confirmedNodeDirectory = Split-Path -Parent $confirmedNodeExecutable
$confirmedNpmDirectory = Split-Path -Parent $confirmedNpmExecutable
if (-not [string]::Equals($confirmedNodeDirectory, $confirmedNpmDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The confirmed node.exe and npm.cmd are no longer the same installed pair.'
}
$confirmedNpmCli = Resolve-ExistingLocalFile (Join-Path $confirmedNpmDirectory 'node_modules\npm\bin\npm-cli.js') 'The confirmed npm CLI entry'
$expectedNpmVersion = '<阶段 A 已验证的 npm 版本>'
$currentNpmVersion = ([string](& $confirmedNodeExecutable $confirmedNpmCli --version)).Trim()
if ($LASTEXITCODE -ne 0 -or $currentNpmVersion -ne $expectedNpmVersion) {
  throw 'The confirmed Node.js/npm pair no longer matches phase A.'
}
function Resolve-ConfirmedCodexHome([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw 'The confirmed CODEX_HOME must be a fully qualified fixed-local-drive directory.'
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw 'The confirmed CODEX_HOME could not be resolved.'
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw 'The confirmed CODEX_HOME is not an existing local directory.'
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw 'The confirmed CODEX_HOME must be on a ready fixed local drive.'
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The confirmed CODEX_HOME path may not contain a symbolic link, junction, or other reparse point.'
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedCodexHome = Resolve-ConfirmedCodexHome '<阶段 A 已验证的 CODEX_HOME 完全限定目录路径>'
$repositoryRoot = (Resolve-Path -LiteralPath . -ErrorAction Stop).ProviderPath
$isolationDirectory = Join-Path $repositoryRoot '.runtime\bootstrap'
$emptyGitConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'empty.gitconfig') 'The runtime Git config'
$emptyNpmUserConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'user.npmrc') 'The isolated npm user config'
$emptyNpmGlobalConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'global.npmrc') 'The isolated npm global config'
foreach ($configPath in @($emptyGitConfig, $emptyNpmUserConfig, $emptyNpmGlobalConfig)) {
  if ((Get-Item -LiteralPath $configPath -Force).Length -ne 0) {
    throw 'A runtime isolation config is no longer empty.'
  }
}
$env:PATH = ((Split-Path -Parent $confirmedGitExecutable), (Split-Path -Parent $confirmedNodeExecutable), (Split-Path -Parent $confirmedNpmExecutable), $env:PATH) -join ';'
foreach ($tool in @(
  @{ Name = 'git.exe'; Expected = $confirmedGitExecutable; Label = 'Git' },
  @{ Name = 'node.exe'; Expected = $confirmedNodeExecutable; Label = 'Node.js' },
  @{ Name = 'npm.cmd'; Expected = $confirmedNpmExecutable; Label = 'npm' }
)) {
  $resolvedCommand = Get-Command $tool.Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolvedCommand -or $resolvedCommand.CommandType -ne 'Application') {
    throw "$($tool.Label) is shadowed or unavailable in this PowerShell process."
  }
  $resolvedCommandPath = Resolve-ExistingLocalFile $resolvedCommand.Source "The resolved $($tool.Label) executable"
  if (-not [string]::Equals($resolvedCommandPath, $tool.Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$($tool.Label) no longer resolves to the executable verified in phase A."
  }
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$env:NPM_CONFIG_USERCONFIG = $emptyNpmUserConfig
$env:NPM_CONFIG_GLOBALCONFIG = $emptyNpmGlobalConfig
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
$effectiveRegistry = ([string](& $confirmedNodeExecutable $confirmedNpmCli config get registry)).Trim()
if ($LASTEXITCODE -ne 0 -or $effectiveRegistry -ne 'https://registry.npmjs.org/') {
  throw 'The isolated npm registry does not match the approved default.'
}
Set-Item -Path Env:CODEX_EXECUTABLE -Value $confirmedCodexExecutable
Set-Item -Path Env:CODEX_HOME -Value $confirmedCodexHome
if (-not (Test-Path -LiteralPath .\.env.local -PathType Leaf)) {
  throw '.env.local is missing.'
}
if (Select-String -Path .\.env.local -Pattern '^\s*(?:export\s+)?(?!(?:FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=)[A-Za-z_][A-Za-z0-9_]*\s*=' -Quiet) {
  throw '.env.local contains a setting other than FEISHU_APP_ID or FEISHU_APP_SECRET.'
}
& $confirmedNodeExecutable --env-file=.env.local -e 'const required=["FEISHU_APP_ID","FEISHU_APP_SECRET"];const missing=required.filter((name)=>!String(process.env[name]??"").trim());if(missing.length){console.error(`Missing or empty Feishu credentials: ${missing.join(", ")}`);process.exit(1)}console.log("Feishu credentials: present")'
if ($LASTEXITCODE -ne 0) {
  throw '.env.local is missing a required non-empty Feishu credential.'
}

$bridgeConfigPath = Resolve-ExistingLocalFile (Join-Path $repositoryRoot 'config\bridge.local.json') 'The Bridge config'
$packageRegistryPath = Resolve-ExistingLocalFile (Join-Path $repositoryRoot 'config\taskboard-feishu-packages.json') 'The package registry'
$rawRegistry = Get-Content -LiteralPath $packageRegistryPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$rawPackages = if ($null -ne $rawRegistry.packages) { $rawRegistry.packages } else { $rawRegistry }
foreach ($packageProperty in $rawPackages.PSObject.Properties) {
  $packageEntry = $packageProperty.Value
  $packageState = if ($null -eq $packageEntry.state) { 'enabled' } else { [string]$packageEntry.state }
  if ($packageState -eq 'enabled') {
    Resolve-ExistingLocalDirectory ([string]$packageEntry.workspacePath) 'An enabled package workspace' | Out-Null
  }
}
$configValidationCode = @'
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./src/config.mjs";
import { loadPackageRegistry } from "./src/package-config.mjs";

const [root, configPath, packagePath] = process.argv.slice(1);
const fail = (code) => { console.log(code); process.exit(1); };
let config;
let packages;
let rawRegistry;
let rawConfig;
try {
  [config, packages, rawRegistry, rawConfig] = await Promise.all([
    loadConfig(configPath),
    loadPackageRegistry(packagePath),
    readFile(packagePath, "utf8").then(JSON.parse),
    readFile(configPath, "utf8").then(JSON.parse),
  ]);
} catch {
  fail("CONFIG_OR_PACKAGE_SCHEMA_INVALID");
}
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
if (config.host !== "127.0.0.1" || config.port !== 47824
    || config.taskboardUrl !== "http://127.0.0.1:47823") {
  fail("LOOPBACK_BINDING_INVALID");
}
if (!samePath(config.stateFile, path.join(root, ".runtime", "bridge", "state.json"))) {
  fail("STATE_PATH_INVALID");
}
if (!samePath(config.workflowFile, path.join(root, ".runtime", "bridge", "workflow.json"))) {
  fail("WORKFLOW_PATH_INVALID");
}
const enabledPackages = Object.entries(packages);
if (enabledPackages.length === 0) fail("NO_ENABLED_PACKAGE");
const rawPackages = rawRegistry.packages ?? rawRegistry;
const rawByAlias = new Map(Object.entries(rawPackages).map(([key, value]) => [value?.alias ?? key, value]));
for (const [alias, packageConfig] of enabledPackages) {
  let workspaceInfo;
  let resolvedWorkspace;
  const localDrivePath = /^[A-Za-z]:[\\/]/u;
  if (!localDrivePath.test(packageConfig.workspacePath)) fail("PACKAGE_WORKSPACE_NOT_LOCAL");
  try {
    [workspaceInfo, resolvedWorkspace] = await Promise.all([
      stat(packageConfig.workspacePath),
      realpath(packageConfig.workspacePath),
    ]);
  } catch {
    fail("PACKAGE_WORKSPACE_UNAVAILABLE");
  }
  if (!workspaceInfo.isDirectory()) fail("PACKAGE_WORKSPACE_UNAVAILABLE");
  if (!localDrivePath.test(resolvedWorkspace)) fail("PACKAGE_WORKSPACE_NOT_LOCAL");
  const rawPackage = rawByAlias.get(alias);
  if (!rawPackage || !Number.isSafeInteger(rawPackage.maxConcurrent) || rawPackage.maxConcurrent < 1) {
    fail("PACKAGE_CONCURRENCY_INVALID");
  }
}
if (!Array.isArray(rawConfig.tables) || rawConfig.tables.length !== 1 || config.tables.length !== 1) {
  fail("LEGACY_TABLE_COUNT_INVALID");
}
const rawTable = rawConfig.tables[0];
const table = config.tables[0];
if (rawTable.statusField !== undefined || rawTable.stages !== undefined) fail("LEGACY_TABLE_REQUIRED");
if (table.mode !== "manual") fail("LEGACY_MANUAL_MODE_REQUIRED");
if (table.defaultPackageAlias !== "Auto-cut-copyA") fail("LEGACY_HARMLESS_PACKAGE_REQUIRED");
if (rawTable.packageField !== null || rawTable.packageFieldId !== null
    || table.packageField !== null || table.packageFieldId !== null) {
  fail("LEGACY_PACKAGE_FIELDS_MUST_BE_NULL");
}
if (!packages[table.defaultPackageAlias]) fail("LEGACY_DEFAULT_PACKAGE_NOT_ENABLED");
console.log("LOCAL_CONFIG_BINDINGS_OK");
'@
$configValidationOutput = @(& $confirmedNodeExecutable --input-type=module -e $configValidationCode $repositoryRoot $bridgeConfigPath $packageRegistryPath 2>$null)
if ($LASTEXITCODE -ne 0 -or $configValidationOutput[-1] -ne 'LOCAL_CONFIG_BINDINGS_OK') {
  $safeCode = if ($configValidationOutput.Count -gt 0) { [string]$configValidationOutput[-1] } else { 'VALIDATION_PROCESS_FAILED' }
  throw "Local config binding validation failed: $safeCode"
}

.\scripts\start-local.ps1
$bridgeHealth = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:47824/health' -TimeoutSec 3
$listenerState = if ($bridgeHealth.feishuListener.state) {
  [string]$bridgeHealth.feishuListener.state
} else {
  [string]$bridgeHealth.feishuListener
}
if ($listenerState -ne 'disabled') {
  throw 'Default local validation requires the Feishu listener state to be disabled.'
}
Write-Host 'Default local listener: disabled'
.\scripts\check-local.ps1
```

任一检查失败时立即暂停，并且只报告变量名或上面固定的安全错误码。首次部署固定使用当前克隆内的 `taskboard`、`config/bridge.local.json`、`config/taskboard-feishu-packages.json`、`.env.local` 和 `.runtime`；若团队确实需要高级覆盖路径，应单独评审后再部署。进程级 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 会优先于 `.env.local`，因此首次部署也将其视为冲突，防止静默连接到另一应用。让用户自行移除冲突设置并重新打开 PowerShell/Codex；不要由 Codex 执行 `Remove-Item Env:`，也不要修改用户级或机器级环境变量。`.env.local` 校验只输出缺失变量名或统一的存在状态，不输出值。环境门禁、配置校验、启动和监听器断言必须在上面同一个 PowerShell 进程中连续完成。

预期：Taskboard 为 `http://127.0.0.1:47823`，Bridge 为 `http://127.0.0.1:47824`，监听器为 `disabled`，健康接口可读，队列计数可读。`start-local.ps1` 会管理本次启动的本机 Bridge 密钥；不要从日志或环境变量中打印它。

只有团队提供了与当前本机配置完全匹配的固定测试 fixture，Codex 才能运行：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$beforeTaskIds = @(
  (Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:47823/api/tasks?archived=all' -TimeoutSec 3).tasks |
    ForEach-Object { [string]$_.id }
)
$firstSimulation = .\scripts\simulate-ready.ps1
$firstSimulationValid = (($firstSimulation.kind -in @('ready', 'register')) -and (-not [string]::IsNullOrWhiteSpace([string]($firstSimulation.taskId))) -and ($firstSimulation.duplicate -ne $true))
if (-not $firstSimulationValid) {
  throw 'The first simulation did not create a fresh task; the fixed fixture may already be consumed or mismatched.'
}
$afterFirstTaskIds = @(
  (Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:47823/api/tasks?archived=all' -TimeoutSec 3).tasks |
    ForEach-Object { [string]$_.id }
)
$newTaskIds = @($afterFirstTaskIds | Where-Object { $_ -notin $beforeTaskIds })
if ($newTaskIds.Count -ne 1 -or $newTaskIds[0] -ne [string]$firstSimulation.taskId) {
  throw 'The first simulation did not add exactly its returned task ID to Taskboard.'
}
$secondSimulation = .\scripts\simulate-ready.ps1
$secondSimulationValid = (($secondSimulation.duplicate -eq $true) -and ([string]($secondSimulation.taskId) -eq [string]($firstSimulation.taskId)) -and ([string]($secondSimulation.kind) -eq [string]($firstSimulation.kind)))
if (-not $secondSimulationValid) {
  throw 'The simulation replay did not return the same task as a duplicate.'
}
$afterSecondTaskIds = @(
  (Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:47823/api/tasks?archived=all' -TimeoutSec 3).tasks |
    ForEach-Object { [string]$_.id }
)
if (@(Compare-Object -ReferenceObject $afterFirstTaskIds -DifferenceObject $afterSecondTaskIds).Count -ne 0) {
  throw 'The simulation replay changed the Taskboard task ID set.'
}
Write-Host 'Simulation delivery and replay: passed'
```

为每次模拟命令设置有限的工具超时；超时、`blocked`、`ignored`、`pending`、`dead_letter` 或首次就返回 `duplicate` 都是失败或“本轮无法验证”，不能当作成功。固定事件 ID 在同一状态文件中只能完成一次新建验收；已经使用过就跳过本轮模拟，不删除或改写状态文件。没有匹配 fixture 时也跳过，不要把自己的生产 token 填入脚本。模拟事件永远不能获得自动执行资格。

本阶段完成后，Codex 可按需从已确认的仓库目录停止服务：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$env:PATH = (Split-Path -Parent $confirmedNodeExecutable) + ';' + $env:PATH
$resolvedNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $resolvedNodeCommand -or $resolvedNodeCommand.CommandType -ne 'Application' -or
    -not [string]::Equals((Resolve-ExistingLocalFile $resolvedNodeCommand.Source 'The resolved Node.js executable'), $confirmedNodeExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Node.js no longer resolves to the executable verified in phase A.'
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
.\scripts\stop-local.ps1
```

## 7. 阶段 F：真实飞书端到端验收

只有用户确认自己的测试 Base、应用权限、资源 ACL、事件订阅和本机配置都完成后，Codex 才执行：

下面代码块继续填写阶段 A 已验证的 Git、Node.js、npm 和 Codex 四个完全限定路径，并使用本克隆 `.runtime\bootstrap` 中的隔离配置；不得回退到 PATH、用户级 Git/npm 配置或 `APPDATA` 重新寻找替代项。

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$confirmedNpmExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 npm.cmd 完全限定路径>' 'The confirmed npm executable'
$confirmedCodexExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 codex.exe 完全限定路径>' 'The confirmed Codex executable'
$confirmedNodeDirectory = Split-Path -Parent $confirmedNodeExecutable
$confirmedNpmDirectory = Split-Path -Parent $confirmedNpmExecutable
if (-not [string]::Equals($confirmedNodeDirectory, $confirmedNpmDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The confirmed node.exe and npm.cmd are no longer the same installed pair.'
}
$confirmedNpmCli = Resolve-ExistingLocalFile (Join-Path $confirmedNpmDirectory 'node_modules\npm\bin\npm-cli.js') 'The confirmed npm CLI entry'
$expectedNpmVersion = '<阶段 A 已验证的 npm 版本>'
$currentNpmVersion = ([string](& $confirmedNodeExecutable $confirmedNpmCli --version)).Trim()
if ($LASTEXITCODE -ne 0 -or $currentNpmVersion -ne $expectedNpmVersion) {
  throw 'The confirmed Node.js/npm pair no longer matches phase A.'
}
function Resolve-ConfirmedCodexHome([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw 'The confirmed CODEX_HOME must be a fully qualified fixed-local-drive directory.'
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw 'The confirmed CODEX_HOME could not be resolved.'
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw 'The confirmed CODEX_HOME is not an existing local directory.'
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw 'The confirmed CODEX_HOME must be on a ready fixed local drive.'
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The confirmed CODEX_HOME path may not contain a symbolic link, junction, or other reparse point.'
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedCodexHome = Resolve-ConfirmedCodexHome '<阶段 A 已验证的 CODEX_HOME 完全限定目录路径>'
$repositoryRoot = (Resolve-Path -LiteralPath . -ErrorAction Stop).ProviderPath
$isolationDirectory = Join-Path $repositoryRoot '.runtime\bootstrap'
$emptyGitConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'empty.gitconfig') 'The runtime Git config'
$emptyNpmUserConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'user.npmrc') 'The isolated npm user config'
$emptyNpmGlobalConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'global.npmrc') 'The isolated npm global config'
foreach ($configPath in @($emptyGitConfig, $emptyNpmUserConfig, $emptyNpmGlobalConfig)) {
  if ((Get-Item -LiteralPath $configPath -Force).Length -ne 0) {
    throw 'A runtime isolation config is no longer empty.'
  }
}
$env:PATH = ((Split-Path -Parent $confirmedGitExecutable), (Split-Path -Parent $confirmedNodeExecutable), (Split-Path -Parent $confirmedNpmExecutable), $env:PATH) -join ';'
foreach ($tool in @(
  @{ Name = 'git.exe'; Expected = $confirmedGitExecutable; Label = 'Git' },
  @{ Name = 'node.exe'; Expected = $confirmedNodeExecutable; Label = 'Node.js' },
  @{ Name = 'npm.cmd'; Expected = $confirmedNpmExecutable; Label = 'npm' }
)) {
  $resolvedCommand = Get-Command $tool.Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolvedCommand -or $resolvedCommand.CommandType -ne 'Application') {
    throw "$($tool.Label) is shadowed or unavailable in this PowerShell process."
  }
  $resolvedCommandPath = Resolve-ExistingLocalFile $resolvedCommand.Source "The resolved $($tool.Label) executable"
  if (-not [string]::Equals($resolvedCommandPath, $tool.Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$($tool.Label) no longer resolves to the executable verified in phase A."
  }
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$env:NPM_CONFIG_USERCONFIG = $emptyNpmUserConfig
$env:NPM_CONFIG_GLOBALCONFIG = $emptyNpmGlobalConfig
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
$effectiveRegistry = ([string](& $confirmedNodeExecutable $confirmedNpmCli config get registry)).Trim()
if ($LASTEXITCODE -ne 0 -or $effectiveRegistry -ne 'https://registry.npmjs.org/') {
  throw 'The isolated npm registry does not match the approved default.'
}
Set-Item -Path Env:CODEX_EXECUTABLE -Value $confirmedCodexExecutable
Set-Item -Path Env:CODEX_HOME -Value $confirmedCodexHome
if (-not (Test-Path -LiteralPath .\.env.local -PathType Leaf)) {
  throw '.env.local is missing.'
}
if (Select-String -Path .\.env.local -Pattern '^\s*(?:export\s+)?(?!(?:FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=)[A-Za-z_][A-Za-z0-9_]*\s*=' -Quiet) {
  throw '.env.local contains a setting other than FEISHU_APP_ID or FEISHU_APP_SECRET.'
}
.\scripts\start-local.ps1 -EnableFeishu
.\scripts\check-local.ps1 -RequireFeishu
```

若检查失败，先停止并排错，不要反复修改生产记录。`sdk_managed` 只表示官方 SDK 已接管长连接生命周期，不代表事件端到端成功。

首次无害验收使用阶段 C 已由用户在本机确认的 legacy `tables` 条目，不通过 Taskboard UI 新增 Base，也不创建或启用 phased subject。Codex 只核对固定结果码，不输出 Base token、表/字段 ID 或业务值，并逐项确认：

1. `tables` 只包含专用测试 Base/子表；`triggerField`/`triggerFieldId`、单一 `triggerValue` 及可选 `triggerOptionId` 与测试表一致。
2. `mode` 为 `manual`，`defaultPackageAlias` 固定为 `Auto-cut-copyA`，该启用包的 workspace 精确指向当前批准检出中的 `examples\harmless-auto-cut`，prompt 与受版本控制的示例一致。
3. `packageField` 和 `packageFieldId` 保持 `null`；首次验收不依赖状态变更事件通常不会携带的其他字段，也不要求 ZIP 来源或 driver report。
4. `initial`、`first_review`、`final_review` 属于另行配置的 phased 工作流，本次 legacy 验收不创建这些阶段，更不能通过“全部禁用阶段”把 phased subject 当成 legacy。需要验证 phased 工作流时，另备至少一个启用阶段及其完整素材、ZIP 来源和 driver report fixture，并单独验收。

配置启用后，Codex 先查询 `GET http://127.0.0.1:47823/api/tasks?archived=all`，在自己的执行上下文中保留当前完整 Taskboard ID 集合；不要把任务内容或 ID 列表发到对话中。然后 Codex 暂停，让用户在专用测试子表中把一条记录从其他状态切换到配置的触发值。用户确认后，Codex 再次查询同一接口并做集合差，必须恰好得到一个此前不存在的 `todo` 任务 ID；零个、多个、复用旧任务或无法保留调用前基线都只能报告“本轮无法验证”，不能继续执行测试。

要把“任务可以登记”和“Taskboard 确实可以调用现有 Codex”分开验收。只有任务使用无害示例包时，Codex 才继续；真实业务包不得用于首次调用测试。先取得本轮真实测试 Base 新建任务的本地 Taskboard ID，并运行下列固定码校验。它直接核对任务的服务端来源和冻结包快照，但只输出固定结果码，不输出任务、路径、prompt 或配置内容：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$repositoryRoot = (Resolve-Path -LiteralPath .).Path
$testTaskId = '<本轮真实测试 Base 新建任务的 Taskboard ID>'
if ([string]::IsNullOrWhiteSpace($testTaskId) -or $testTaskId.StartsWith('<')) {
  throw 'The new test task ID has not been selected.'
}
$bindingValidationCode = @'
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [root, taskId] = process.argv.slice(1);
const fail = (code) => { console.log(code); process.exit(1); };
try {
  const alias = "Auto-cut-copyA";
  const packageMap = (document) => document?.packages ?? document;
  const [registryDocument, exampleDocument, expectedWorkspace] = await Promise.all([
    readFile(path.join(root, "config", "taskboard-feishu-packages.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "config", "autocut-packages.example.json"), "utf8").then(JSON.parse),
    realpath(path.join(root, "examples", "harmless-auto-cut")),
  ]);
  const active = packageMap(registryDocument)?.[alias];
  const example = packageMap(exampleDocument)?.[alias];
  if (!active || !example || active.alias !== alias || active.state !== "enabled"
      || active.prompt !== example.prompt) fail("HARMLESS_ACTIVE_PACKAGE_INVALID");
  const activeWorkspace = await realpath(active.workspacePath);
  const samePath = (left, right) => path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
  if (!samePath(activeWorkspace, expectedWorkspace)) fail("HARMLESS_ACTIVE_WORKSPACE_INVALID");

  const database = new DatabaseSync(path.join(root, ".runtime", "taskboard", "taskboard.sqlite"), { readOnly: true });
  const row = database.prepare(`
    SELECT origins.metadata_json, snapshots.snapshot_json
    FROM feishu_task_origins AS origins
    JOIN feishu_task_package_snapshots AS snapshots ON snapshots.task_id = origins.task_id
    WHERE origins.task_id = ?
  `).get(taskId);
  database.close();
  if (!row) fail("HARMLESS_TASK_SNAPSHOT_MISSING");
  const origin = JSON.parse(row.metadata_json);
  const snapshot = JSON.parse(row.snapshot_json);
  if (origin.packageAlias !== alias || origin.deliverySource === "simulation"
      || snapshot.packageAlias !== alias || snapshot.prompt !== active.prompt
      || (snapshot.packageRevision ?? 1) !== (active.revision ?? 1)) {
    fail("HARMLESS_TASK_BINDING_INVALID");
  }
  for (const key of ["projectId", "model", "reasoningEffort"]) {
    if ((snapshot[key] ?? null) !== (active[key] ?? null)) fail("HARMLESS_TASK_BINDING_INVALID");
  }
  const snapshotWorkspace = await realpath(snapshot.workspacePath);
  if (!samePath(snapshotWorkspace, expectedWorkspace)) fail("HARMLESS_TASK_WORKSPACE_INVALID");
  console.log("HARMLESS_TASK_BINDING_OK");
} catch {
  fail("HARMLESS_TASK_BINDING_INVALID");
}
'@
$bindingValidationOutput = @(& $confirmedNodeExecutable --input-type=module -e $bindingValidationCode $repositoryRoot $testTaskId 2>$null)
if ($LASTEXITCODE -ne 0 -or $bindingValidationOutput[-1] -ne 'HARMLESS_TASK_BINDING_OK') {
  $safeCode = if ($bindingValidationOutput.Count -gt 0) { [string]$bindingValidationOutput[-1] } else { 'VALIDATION_PROCESS_FAILED' }
  throw "Harmless task binding validation failed: $safeCode"
}
```

冻结绑定校验通过后，再检查无害示例的受控基线：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$emptyGitConfig = Resolve-ExistingLocalFile '<克隆阶段创建的零字节 Git 配置文件完全限定路径>' 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$demoWorkspaceRelative = 'examples/harmless-auto-cut'
$demoResultPath = Join-Path (Resolve-Path -LiteralPath $demoWorkspaceRelative).Path 'demo-result.md'
& $confirmedGitExecutable ls-files --error-unmatch -- "$demoWorkspaceRelative/demo-result.md" | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $demoResultPath -PathType Leaf)) {
  throw 'The tracked harmless demo baseline is missing.'
}
$expectedDemoResult = 'Taskboard 的 Codex 演示任务已完成。'
$actualDemoResult = (Get-Content -LiteralPath $demoResultPath -Raw -Encoding UTF8).Trim()
if ($actualDemoResult -ne $expectedDemoResult) {
  throw 'The tracked harmless demo baseline has unexpected content.'
}
$demoWorkspaceStatus = @(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all -- $demoWorkspaceRelative)
if ($LASTEXITCODE -ne 0) {
  throw 'Could not inspect the harmless demo workspace.'
}
if ($demoWorkspaceStatus.Count -gt 0) {
  throw 'The harmless demo workspace is not clean; preserve it and ask the user how to proceed.'
}
```

确认基线干净后，使用下面的动态验收捕获本轮执行证据。它先确认目标任务在点击前仍是没有 thread 的 `todo`，并记录点击前已有的全部 thread ID；随后 Codex 暂停，让用户在本机 Taskboard 打开刚创建的测试任务并只点击一次“启动 Codex”（或把它从“待处理”拖到“处理中”）。脚本等待该任务绑定一个点击前不存在的新 thread，再固定捕获该 thread 的唯一新 run ID，之后所有轮询都只查询这个 run。不得开启 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION`：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$taskboardUrl = 'http://127.0.0.1:47823'
$testTaskId = '<本轮真实测试 Base 新建任务的 Taskboard ID>'
if ([string]::IsNullOrWhiteSpace($testTaskId) -or $testTaskId.StartsWith('<')) {
  throw 'The new test task ID has not been selected.'
}
function Get-TaskboardErrorDetails([System.Management.Automation.ErrorRecord]$ErrorRecord) {
  $response = $ErrorRecord.Exception.Response
  $statusCode = $null
  if ($null -ne $response -and $null -ne $response.StatusCode) {
    try {
      $statusCode = [int]$response.StatusCode
    } catch {
      $statusCode = $null
    }
  }
  $responseBody = [string]$ErrorRecord.ErrorDetails.Message
  if ([string]::IsNullOrWhiteSpace($responseBody)) {
    if ($null -ne $response -and $response.PSObject.Methods.Name -contains 'GetResponseStream') {
      $responseStream = $response.GetResponseStream()
      if ($null -ne $responseStream) {
        $reader = [System.IO.StreamReader]::new($responseStream)
        try {
          $responseBody = $reader.ReadToEnd()
        } finally {
          $reader.Dispose()
        }
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($responseBody)) {
    return [pscustomobject]@{ StatusCode = $statusCode; Code = $null }
  }
  $errorCode = $null
  try {
    $payload = $responseBody | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return [pscustomobject]@{ StatusCode = $statusCode; Code = $null }
  }
  if ($null -ne $payload.error -and -not [string]::IsNullOrWhiteSpace([string]$payload.error.code)) {
    $errorCode = [string]$payload.error.code
  }
  [pscustomobject]@{ StatusCode = $statusCode; Code = $errorCode }
}
function Invoke-TaskboardJson([string]$Path, [string[]]$AllowedErrorCodes = @()) {
  try {
    Invoke-RestMethod -Method Get -Uri ($taskboardUrl + $Path) -TimeoutSec 5 -ErrorAction Stop
  } catch {
    $errorDetails = Get-TaskboardErrorDetails $_
    if ($errorDetails.StatusCode -eq 404 -and
        $null -ne $errorDetails.Code -and
        $AllowedErrorCodes -contains $errorDetails.Code) {
      return $null
    }
    throw "Taskboard verification request failed for $Path."
  }
}
$encodedTaskId = [System.Uri]::EscapeDataString($testTaskId)
$taskBefore = Invoke-TaskboardJson "/api/tasks/$encodedTaskId"
if ((-not $taskBefore.task) -or
    ([string]$taskBefore.task.status -ne 'todo') -or
    (-not [string]::IsNullOrWhiteSpace([string]$taskBefore.task.threadId))) {
  throw 'The selected task was not a todo task without a thread before the manual click.'
}
$threadsBefore = Invoke-TaskboardJson '/api/local/ai/threads'
$threadIdsBefore = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($thread in @($threadsBefore.threads)) {
  $threadId = [string]$thread.id
  if (-not [string]::IsNullOrWhiteSpace($threadId)) {
    [void]$threadIdsBefore.Add($threadId)
  }
}
Read-Host '在 Taskboard 中只点击一次“启动 Codex”，完成后按 Enter 继续'
$threadDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
$newThreadId = $null
while ([DateTimeOffset]::UtcNow -lt $threadDeadline) {
  $taskAfter = Invoke-TaskboardJson "/api/tasks/$encodedTaskId"
  $candidateThreadId = [string]$taskAfter.task.threadId
  if (-not [string]::IsNullOrWhiteSpace($candidateThreadId)) {
    if ($threadIdsBefore.Contains($candidateThreadId)) {
      throw 'The task was bound to a thread that existed before the manual click.'
    }
    $newThreadId = $candidateThreadId
    break
  }
  Start-Sleep -Seconds 1
}
if ([string]::IsNullOrWhiteSpace($newThreadId)) {
  throw 'Timed out waiting for the selected task to receive a new Codex thread.'
}
$encodedThreadId = [System.Uri]::EscapeDataString($newThreadId)
$runDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
$runId = $null
while ([DateTimeOffset]::UtcNow -lt $runDeadline) {
  # The task can receive its thread ID just before the AI thread row is committed.
  $snapshot = Invoke-TaskboardJson "/api/local/ai/threads/$encodedThreadId" -AllowedErrorCodes 'AI_CHAT_THREAD_NOT_FOUND'
  if ($null -eq $snapshot) {
    Start-Sleep -Seconds 1
    continue
  }
  if ([string]$snapshot.thread.id -ne $newThreadId) {
    throw 'The Taskboard thread snapshot did not match the task thread binding.'
  }
  $candidateRuns = @($snapshot.runs | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.id) })
  if ($candidateRuns.Count -gt 1) {
    throw 'More than one run appeared for the single manual click; the execution is ambiguous.'
  }
  if ($candidateRuns.Count -eq 1) {
    if ([string]$candidateRuns[0].threadId -ne $newThreadId) {
      throw 'The captured Codex run is bound to a different thread.'
    }
    $runId = [string]$candidateRuns[0].id
    break
  }
  Start-Sleep -Seconds 1
}
if ([string]::IsNullOrWhiteSpace($runId)) {
  throw 'Timed out waiting for the new Codex run to be recorded.'
}
$runDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
$runCompleted = $false
while ([DateTimeOffset]::UtcNow -lt $runDeadline) {
  $taskAfter = Invoke-TaskboardJson "/api/tasks/$encodedTaskId"
  $snapshot = Invoke-TaskboardJson "/api/local/ai/threads/$encodedThreadId"
  if (([string]$taskAfter.task.threadId -ne $newThreadId) -or
      ([string]$snapshot.thread.id -ne $newThreadId)) {
    throw 'The Taskboard task and thread bindings changed during execution.'
  }
  $currentRuns = @($snapshot.runs | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.id) })
  if ($currentRuns.Count -ne 1) {
    throw 'The captured Codex thread no longer has exactly one run; the execution is ambiguous.'
  }
  $run = $currentRuns[0]
  if ([string]$run.id -ne $runId) {
    throw 'The captured Codex run disappeared from the thread snapshot.'
  }
  if ([string]$run.threadId -ne $newThreadId) {
    throw 'The captured Codex run is bound to a different thread.'
  }
  $runStatus = [string]$run.status
  if ($runStatus -notin @('running', 'completed', 'failed', 'interrupted')) {
    throw 'The captured Codex run returned an unknown status.'
  }
  if ($runStatus -in @('failed', 'interrupted')) {
    throw 'The captured Codex run did not complete successfully.'
  }
  if ($runStatus -eq 'completed') {
    if ([string]::IsNullOrWhiteSpace([string]$run.finishedAt) -or
        ($null -eq $run.exitCode) -or
        ([int]$run.exitCode -ne 0)) {
      throw 'The captured Codex run completed without the required terminal evidence.'
    }
    $runCompleted = $true
    break
  }
  Start-Sleep -Seconds 1
}
if (-not $runCompleted) {
  throw 'Timed out waiting for the captured Codex run to complete.'
}
Write-Host 'Taskboard-to-Codex dynamic execution evidence: passed'
```

动态证据通过后，再执行下面的不回显文件内容或路径的安全校验：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$emptyGitConfig = Resolve-ExistingLocalFile '<克隆阶段创建的零字节 Git 配置文件完全限定路径>' 'The isolated Git config'
if ((Get-Item -LiteralPath $emptyGitConfig -Force).Length -ne 0) {
  throw 'The isolated Git config is no longer empty.'
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$demoWorkspaceRelative = 'examples/harmless-auto-cut'
$demoResultPath = Join-Path (Resolve-Path -LiteralPath $demoWorkspaceRelative).Path 'demo-result.md'
$expectedDemoResult = 'Taskboard 的 Codex 演示任务已完成。'
if (-not (Test-Path -LiteralPath $demoResultPath -PathType Leaf)) {
  throw 'The tracked harmless demo result is missing after execution.'
}
$actualDemoResult = (Get-Content -LiteralPath $demoResultPath -Raw -Encoding UTF8).Trim()
if ($actualDemoResult -ne $expectedDemoResult) {
  throw 'The harmless Codex demo result did not match the expected content.'
}
$demoWorkspaceStatus = @(& $confirmedGitExecutable status --porcelain=v1 --untracked-files=all -- $demoWorkspaceRelative)
if ($LASTEXITCODE -ne 0) {
  throw 'Could not inspect the harmless demo workspace after execution.'
}
if ($demoWorkspaceStatus.Count -gt 0) {
  throw 'The harmless Codex execution changed its tracked baseline or created an unexpected file.'
}
Write-Host 'Taskboard-to-Codex harmless execution: passed'
```

`demo-result.md` 本来就是受版本控制的无害基线，不创建、不删除，也不能单独把它的现有内容当作执行成功证据；成功证据必须是本轮任务产生的新执行对话及其成功终态。基线或目录状态任一校验不通过时都保留现场并暂停。若模型、推理强度或 Codex 进程启动失败，不得报告部署成功，只保留 Taskboard 的脱敏错误码并停止；本 Runbook 不安装、更新、登录 Codex，也不修复账号状态。

需要验证离开触发值时，由用户另建一条只用于生命周期测试的 `todo` 任务，再把记录移出触发值，确认匹配任务被归档。不要用刚执行过的任务测试自动归档；`in_progress`、`in_review`、`done` 或其他非 `todo` 任务由 Taskboard/Codex 管理，不会被 Bridge 自动中止。

投递语义是至少一次。事件按 `event_id` 幂等处理，但 Taskboard 没有原生原子幂等键时，不对外承诺绝对 exactly-once。真实验收只使用测试 Base，不反复改动生产记录。

验收完成后按需从已确认的仓库目录执行：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$env:PATH = (Split-Path -Parent $confirmedNodeExecutable) + ';' + $env:PATH
$resolvedNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $resolvedNodeCommand -or $resolvedNodeCommand.CommandType -ne 'Application' -or
    -not [string]::Equals((Resolve-ExistingLocalFile $resolvedNodeCommand.Source 'The resolved Node.js executable'), $confirmedNodeExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Node.js no longer resolves to the executable verified in phase A.'
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
.\scripts\stop-local.ps1
```

## 8. 日常操作和排错指令

用户以后要求 Codex 启动服务时，仍只使用正式脚本，并把安全门禁和启动放在同一个 PowerShell 进程中，以保持 loopback、`.env.local` 凭据来源和自动执行关闭：

下面代码块继续填写阶段 A 已验证的 Git、Node.js、npm 和 Codex 四个完全限定路径，并使用本克隆 `.runtime\bootstrap` 中的隔离配置。日常重启仍固定使用这些文件；若文件已移动、更新、非空或被遮蔽，停止并重新执行阶段 A 的验证，不在启动块中自动选择替代文件，也不读取用户级或全局 Git/npm 配置。

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
$confirmedGitExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 git.exe 完全限定路径>' 'The confirmed Git executable'
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$confirmedNpmExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 npm.cmd 完全限定路径>' 'The confirmed npm executable'
$confirmedCodexExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 codex.exe 完全限定路径>' 'The confirmed Codex executable'
$confirmedNodeDirectory = Split-Path -Parent $confirmedNodeExecutable
$confirmedNpmDirectory = Split-Path -Parent $confirmedNpmExecutable
if (-not [string]::Equals($confirmedNodeDirectory, $confirmedNpmDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The confirmed node.exe and npm.cmd are no longer the same installed pair.'
}
$confirmedNpmCli = Resolve-ExistingLocalFile (Join-Path $confirmedNpmDirectory 'node_modules\npm\bin\npm-cli.js') 'The confirmed npm CLI entry'
$expectedNpmVersion = '<阶段 A 已验证的 npm 版本>'
$currentNpmVersion = ([string](& $confirmedNodeExecutable $confirmedNpmCli --version)).Trim()
if ($LASTEXITCODE -ne 0 -or $currentNpmVersion -ne $expectedNpmVersion) {
  throw 'The confirmed Node.js/npm pair no longer matches phase A.'
}
function Resolve-ConfirmedCodexHome([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw 'The confirmed CODEX_HOME must be a fully qualified fixed-local-drive directory.'
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw 'The confirmed CODEX_HOME could not be resolved.'
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
    throw 'The confirmed CODEX_HOME is not an existing local directory.'
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw 'The confirmed CODEX_HOME must be on a ready fixed local drive.'
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The confirmed CODEX_HOME path may not contain a symbolic link, junction, or other reparse point.'
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedCodexHome = Resolve-ConfirmedCodexHome '<阶段 A 已验证的 CODEX_HOME 完全限定目录路径>'
$repositoryRoot = (Resolve-Path -LiteralPath . -ErrorAction Stop).ProviderPath
$isolationDirectory = Join-Path $repositoryRoot '.runtime\bootstrap'
$emptyGitConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'empty.gitconfig') 'The runtime Git config'
$emptyNpmUserConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'user.npmrc') 'The isolated npm user config'
$emptyNpmGlobalConfig = Resolve-ExistingLocalFile (Join-Path $isolationDirectory 'global.npmrc') 'The isolated npm global config'
foreach ($configPath in @($emptyGitConfig, $emptyNpmUserConfig, $emptyNpmGlobalConfig)) {
  if ((Get-Item -LiteralPath $configPath -Force).Length -ne 0) {
    throw 'A runtime isolation config is no longer empty.'
  }
}
$env:PATH = ((Split-Path -Parent $confirmedGitExecutable), (Split-Path -Parent $confirmedNodeExecutable), (Split-Path -Parent $confirmedNpmExecutable), $env:PATH) -join ';'
foreach ($tool in @(
  @{ Name = 'git.exe'; Expected = $confirmedGitExecutable; Label = 'Git' },
  @{ Name = 'node.exe'; Expected = $confirmedNodeExecutable; Label = 'Node.js' },
  @{ Name = 'npm.cmd'; Expected = $confirmedNpmExecutable; Label = 'npm' }
)) {
  $resolvedCommand = Get-Command $tool.Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolvedCommand -or $resolvedCommand.CommandType -ne 'Application') {
    throw "$($tool.Label) is shadowed or unavailable in this PowerShell process."
  }
  $resolvedCommandPath = Resolve-ExistingLocalFile $resolvedCommand.Source "The resolved $($tool.Label) executable"
  if (-not [string]::Equals($resolvedCommandPath, $tool.Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$($tool.Label) no longer resolves to the executable verified in phase A."
  }
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$env:NPM_CONFIG_USERCONFIG = $emptyNpmUserConfig
$env:NPM_CONFIG_GLOBALCONFIG = $emptyNpmGlobalConfig
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
$effectiveRegistry = ([string](& $confirmedNodeExecutable $confirmedNpmCli config get registry)).Trim()
if ($LASTEXITCODE -ne 0 -or $effectiveRegistry -ne 'https://registry.npmjs.org/') {
  throw 'The isolated npm registry does not match the approved default.'
}
Set-Item -Path Env:CODEX_EXECUTABLE -Value $confirmedCodexExecutable
Set-Item -Path Env:CODEX_HOME -Value $confirmedCodexHome
if (-not (Test-Path -LiteralPath .\.env.local -PathType Leaf)) {
  throw '.env.local is missing.'
}
if (Select-String -Path .\.env.local -Pattern '^\s*(?:export\s+)?(?!(?:FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=)[A-Za-z_][A-Za-z0-9_]*\s*=' -Quiet) {
  throw '.env.local contains a setting other than FEISHU_APP_ID or FEISHU_APP_SECRET.'
}
.\scripts\start-local.ps1 -EnableFeishu
.\scripts\check-local.ps1 -RequireFeishu
```

用户要求停止时仍先在新的 PowerShell 进程执行同一门禁，再使用正式停止脚本。若门禁发现冲突变量，先让用户清理当前进程环境并重新打开 PowerShell；不得在受污染的进程中执行仓库脚本：

```powershell
$ErrorActionPreference = 'Stop'
$deploymentBlockedPattern = '^(?:ALL_PROXY|CURL_CA_BUNDLE|HTTPS?_PROXY|SSL_CERT_FILE|BRIDGE_(?:ENV_FILE|CONFIG|WORKFLOW_CONFIG)|CODEX_EXECUTABLE|CODEX_FEISHU_(?:PACKAGES_PATH|BRIDGE_URL|BRIDGE_SECRET)|CODEX_TASKBOARD_.+|FEISHU_(?:APP_ID|APP_SECRET|LISTENER_ENABLED|READ_ENABLED)|GIT_.+|NODE_(?:OPTIONS|PATH|TLS_REJECT_UNAUTHORIZED|EXTRA_CA_CERTS)|NPM_CONFIG_.+)$'
$blockedProcessVariables = @(
  ([Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)).Keys |
    ForEach-Object { [string]$_ } |
    Where-Object { $_ -match $deploymentBlockedPattern } |
    Sort-Object
)
if ($blockedProcessVariables.Count -gt 0) {
  throw "Unsafe inherited process variables are present: $($blockedProcessVariables -join ', ')"
}
function Resolve-ExistingLocalFile([string]$Candidate, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z]:[\\/]') {
    throw "$Label must be a fully qualified fixed-local-drive path."
  }
  try {
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
    $resolved = Resolve-Path -LiteralPath $candidatePath -ErrorAction Stop
  } catch {
    throw "$Label could not be resolved."
  }
  if ($resolved.Provider.Name -ne 'FileSystem' -or
      -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "$Label is not an existing local file."
  }
  foreach ($verifiedPath in (@($candidatePath, [string]$resolved.ProviderPath) | Select-Object -Unique)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($verifiedPath)
    try {
      $driveInfo = [System.IO.DriveInfo]::new($driveRoot)
    } catch {
      throw "$Label drive could not be inspected."
    }
    if (-not $driveInfo.IsReady -or $driveInfo.DriveType -ne [System.IO.DriveType]::Fixed) {
      throw "$Label must be on a ready fixed local drive."
    }
    $pathCursor = $verifiedPath
    while ($true) {
      $pathItem = Get-Item -LiteralPath $pathCursor -Force -ErrorAction Stop
      if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label path may not contain a symbolic link, junction, or other reparse point."
      }
      if ([string]::Equals($pathCursor, $driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        break
      }
      $pathCursor = Split-Path -Parent $pathCursor
    }
  }
  [string]$resolved.ProviderPath
}
$confirmedNodeExecutable = Resolve-ExistingLocalFile '<阶段 A 已验证的 node.exe 完全限定路径>' 'The confirmed Node.js executable'
$env:PATH = (Split-Path -Parent $confirmedNodeExecutable) + ';' + $env:PATH
$resolvedNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $resolvedNodeCommand -or $resolvedNodeCommand.CommandType -ne 'Application' -or
    -not [string]::Equals((Resolve-ExistingLocalFile $resolvedNodeCommand.Source 'The resolved Node.js executable'), $confirmedNodeExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Node.js no longer resolves to the executable verified in phase A.'
}
Set-Location -LiteralPath '<工作目录>' -ErrorAction Stop
.\scripts\stop-local.ps1
```

需要升级源码时，不在现有工作树中执行 `git pull`、`git merge`、`git switch`、`git checkout` 或安装新依赖。先用上面的受控停止流程停止旧实例，再让维护者给出新的批准 tag 或完整 commit SHA，由用户确认另一个尚不存在且路径链无重解析点的本地固定磁盘目录，并从阶段 A 开始执行一次全新 clone、版本门禁、两层依赖安装和完整测试。

新目录不得复制旧目录的 `.git`、`node_modules`、`.runtime`、状态文件或锁文件，也不得自动复制 `.env.local` 和两份本机 JSON。是否迁移本机配置必须依据新版本 schema 和目标路径另行评审；用户仍只在本机输入自己的飞书凭据。新版本完成阶段 E 和阶段 F 验收前，不能替代旧版本，也不能报告升级成功。

固定排查顺序：

1. Node.js 是否 `>=22.13`，Codex 可执行文件是否可发现；
2. 根目录和 `taskboard` 两层依赖、通过已确认 Node/npm CLI 执行的完整 `npm test`；
3. 本机 JSON 中的固定本地磁盘路径、无重解析点的执行工作区、普通状态文件路径和端口；
4. 包 alias 是否存在且为 `enabled`，workspace 是否存在；
5. App ID/Secret 是否由用户在本机填写且非空；
6. 飞书应用权限、Base 资源 ACL、测试 Base 可见性和事件订阅；
7. `47823`/`47824` 是否被其他进程占用；
8. `check-local.ps1` 输出和以下脱敏日志：

```text
.runtime\logs\bridge.stdout.log
.runtime\logs\bridge.stderr.log
.runtime\logs\taskboard.stdout.log
.runtime\logs\taskboard.stderr.log
```

不要删除或手工改写 `.runtime`、状态文件或锁文件来处理重复任务；不要用强制 Git 命令覆盖本机文件；不要把监听地址改成 LAN/公网；不要把路径、命令、Codex 参数、prompt、token 或秘密放入飞书单元格。

## 9. Codex 最终脱敏报告

部署流程结束时，Codex 只输出以下信息，不输出任何秘密、完整配置、完整业务路径或任务内容：

```text
部署结论：成功 / 未完成 / 失败
工作目录：<只报目录名或用户允许的脱敏路径>
仓库 commit：<完整 SHA>
Node.js：<版本>
Codex 可执行文件：已发现 / 未发现
独立桌面环境依赖预检（无临时 CODEX_EXECUTABLE）：通过 / 未执行 / 失败
根目录依赖：通过 / 失败
taskboard 依赖：通过 / 失败
已确认 Node/npm CLI 执行的完整 npm test：通过 / 失败
bridge.local.json：存在 / 缺失（不打印内容）
taskboard-feishu-packages.json：存在 / 缺失（不打印内容）
.env.local：存在且变量非空 / 缺失（不打印值）
Taskboard 健康：通过 / 失败
Bridge 健康：通过 / 失败
监听器：disabled / sdk_managed / 其他
队列：pending=?, processing=?, retryWait=?, deadLetter=?
模拟验收：通过 / 跳过（无匹配 fixture）/ 失败
真实测试 Base 事件：通过 / 未执行 / 失败
Taskboard→Codex 无害执行：通过 / 未执行 / 失败
仍需用户完成：<仅列人工步骤，不列秘密>
```

只有独立桌面环境依赖预检、完整测试、两个本机健康检查、真实测试 Base 的本轮新事件，以及该新任务的 Taskboard→Codex 无害执行全部通过时，`部署结论` 才能写“成功”。模拟验收可以因没有匹配 fixture 而跳过；独立依赖预检、真实事件或无害执行为“未执行”时，结论必须是“未完成”，不能称为已经部署成功。仅在部署进程中设置 `CODEX_EXECUTABLE` 后启动成功，不满足独立依赖预检要求。

不得把本机的 `%USERPROFILE%\.codex`、Codex token、飞书凭据、Base token、Bridge Secret、`.env.local`、两个本机 JSON、`.runtime` 或生产任务数据提交到 Git 或转发给维护者。根目录 `AGENTS.md`、源码、脚本和示例文件才是可以从仓库共享的项目内容；个人 Codex 全局配置和登录态不是部署输入。

## 10. 相关文件

- 运行规则：`AGENTS.md`
- 根说明：`README.md`
- Bridge 示例：`config/bridge.example.json`
- Auto-Cut 包示例：`config/autocut-packages.example.json`
- 启动：`scripts/start-local.ps1`
- 健康检查：`scripts/check-local.ps1`
- 启动依赖预检：`scripts/check-local.ps1 -DependenciesOnly`
- 共用 Codex CLI 发现：`scripts/codex-discovery.ps1`
- 停止：`scripts/stop-local.ps1`
- 模拟事件：`scripts/simulate-ready.ps1`
