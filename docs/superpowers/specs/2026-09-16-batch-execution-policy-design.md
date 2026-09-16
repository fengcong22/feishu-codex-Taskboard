# Windows 双击入口执行策略修复

用户已批准为启动、停止和检查三个 `.bat` 入口添加 `-ExecutionPolicy Bypass`。当前入口直接调用 Windows PowerShell，在目标电脑有效策略为 `Restricted` 时，脚本在加载阶段就被阻止。

仅在 `powershell.exe` 的 `-File` 前加入该参数，保留脚本路径、工作目录、飞书开关、退出码和暂停行为。参数作用于启动的 PowerShell 进程，不持久修改用户或机器的执行策略；组织设置的 `MachinePolicy` / `UserPolicy` 仍具有更高优先级。

通过临时示例项目复制真实 `.bat` 入口，使用无业务副作用的同名 `.ps1`，在继承 `Restricted` 的子进程中验证脚本加载、参数传递和退出码。测试不操作真实服务、飞书记录、配置、凭据或运行数据。README 说明部署替换范围和组策略限制。完成全量测试与独立代码评审后，与 Codex 发现修复一并提交、推送和合并。
