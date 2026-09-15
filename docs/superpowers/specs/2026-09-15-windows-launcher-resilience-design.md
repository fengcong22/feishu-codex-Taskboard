# Windows 启动与右键菜单稳定性设计

## 目标

修复 Windows 上右键任务卡片时 Git 子进程窗口抢焦点导致菜单立即关闭的问题，并让启动脚本在 `CODEX_EXECUTABLE` 指向已被 Codex Desktop 升级删除的旧文件时，安全回退到当前可发现的 `codex.exe`。

## 方案

Taskboard 的开发上下文扫描仍执行现有三个只读 Git 命令，但每个 `execFileAsync` 调用都显式设置 `windowsHide: true`。保留右键菜单的 `window.blur` 关闭行为，因为隐藏子进程窗口后它仍用于正常的窗口失焦交互。

`scripts/start-local.ps1` 新增独立的 `Resolve-CodexExecutable` 函数。解析顺序固定为：存在且为普通文件的显式 `CODEX_EXECUTABLE`、PATH 中的 `codex.exe`、与当前 Windows 进程架构匹配的全局 npm vendor 候选。有效路径统一解析为绝对文件系统路径；显式值非空但不是文件系统文件或文件不存在时，只输出不含路径的警告并继续发现。所有来源均不可用时，启动流程才使用现有失败门禁终止。已运行的进程保留启动时接收的路径，更新后按 README 的停止、更新、启动步骤加载新路径；路径回退本身不新增强制重启条件。

## 安全与兼容性

- 不改变 Taskboard/Bridge 的 loopback 监听、飞书事件、凭据或 Auto-Cut 执行边界。
- 有效的 `CODEX_EXECUTABLE` 仍保持最高优先级。
- vendor 兜底只选择当前进程可用的架构；`PROCESSOR_ARCHITEW6432` 仅在当前 PowerShell 为 x86（WOW64）时用于识别原生架构。
- 不建议把 Codex Desktop 的版本哈希目录持久化为环境变量；自定义覆盖只适合当前进程或稳定安装路径。
- 不删除或改写用户的环境变量、配置、状态文件或任务。

## 测试

- Taskboard 回归测试确认三个 Git 开发上下文子进程都显式隐藏 Windows 窗口。
- PowerShell 行为测试确认有效显式路径优先、相对文件路径规范化、非文件系统或失效显式路径产生警告并回退到 PATH 中的新版、vendor 架构选择，以及完全找不到时返回空值。启动门禁另有源代码断言。
- 已运行仓库标准测试阶段；并行 Node 测试遇到随机端口与超时问题后，完整 Node 测试使用串行模式通过。最后的 PowerShell 改动仅复跑相关启动测试。
