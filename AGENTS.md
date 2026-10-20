# 飞书 Bridge 团队运行规范

## 固定数据流

生产流程固定为：飞书多维表格发生变化 → 飞书官方 SDK 长连接接收事件 → Bridge 按表和字段规则筛选、标准化、去重 → Taskboard 创建或归档受控任务。
Bridge 创建的飞书任务必须通过 Taskboard 的本机专用来源登记接口，并携带由启动脚本注入的 `CODEX_FEISHU_BRIDGE_SECRET`；普通任务描述中的标记或标签不能获得 Auto-Cut 执行资格。

Bridge 和 Taskboard 只绑定本机 loopback（`127.0.0.1`），不得改成 LAN 或公网监听。Bridge 永不启动 Codex；Taskboard 只有在“本机设置 → 允许本机自动剪辑”显式开启时，才可自动执行由 Bridge 专用接口登记、活动配置快照为 `automatic` 且项目包别名已在本机白名单中的任务。该开关默认关闭；尚未保存本机设置时，兼容 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` 作为初始值，保存后以本机数据库设置为准。设置立即生效并在重启后保留；关闭只取消尚未开始的自动预约，正在执行的任务继续完成，开启本身不补跑历史任务。普通任务、伪造描述标记或标签不得获得自动执行资格。旧 ZIP 流程仅在唯一 ZIP 成功发布后产生阶段完成及首个课程路径回写；VM/PMO MP4 流程使用下述独立的交付完成条件。目标仅限实时校验后已存在的字段与单选选项，回写通过认证的本机专用接口完成。模拟事件、普通任务和伪造标签不会创建交付目录、上传制品或回写飞书；整体投递仍为至少一次，不宣称 exactly-once。

模拟事件只用于本机测试和可靠投递演练，必须由 Bridge 标记为非生产来源；即使 Taskboard 的自动执行开关已开启，模拟事件也不得获得自动执行资格。

独立 `vm_pmo_review_video` 流程使用认证的 `/api/local/feishu/vm/tasks` 登记接口。包模板身份为 v1；可执行的包 manifest 必须同时声明 `vm_pmo_review_video` 执行协议 v2 和固定 driver。活动配置可启用 `initial` 与 `review` 阶段，使用实时校验过的单选选项边沿触发；初稿按正常 VM 审批队列取得源视频，审核只复用 Taskboard 已确认交付的上一轮 MP4，不另申请下载。VM 初稿审批以 Taskboard `task/run` 为幂等范围：同一任务重放复用原审批项，不同任务即使 VMID 与请求内容相同也创建独立审批项；手动下载仍按规范化请求复用，下载资源摘要按 `application_id` 隔离，同一申请不可经不同任务重复领取相同素材，不同已批准申请可独立领取相同素材；Bridge 的 `event_id` 去重保持独立。task/run 首次登记时冻结规范化审批请求；本机下载设置后续变化不得改写历史 run，VMID、部门和原因仍须匹配冻结任务上下文。Taskboard 启动时只自动恢复 `needs_attention/VM_TASK_BINDING_CONFLICT` 且没有 plan/render/制品证据的 run；恢复前必须重新验证原绑定审批仍为 `ready`、采集回执及源文件摘要有效，并沿用原 task/run/审批。其他 `needs_attention` 不自动恢复，已有 render 启动证据的 run 不得自动重跑。v2 支持明确保留区间和证据绑定的语音删词/静音/cue；词级操作必须绑定本轮源 SHA 和唯一词时间戳，缺少 ASR、匹配有歧义或保护词冲突时在渲染前阻断。该流程的完成凭据为同一 task/run 的唯一 MP4 校验通过、上传到配置附件字段并读回确认，不要求 ZIP；不得全局放宽旧 ZIP 的完成条件。实际 render 子进程启动后才回写处理中，附件读回确认后才回写阶段完成。独立成片归档只读取已确认的最新交付指针，重新校验 SHA 并采用无覆盖发布；同名异 SHA 为冲突。审批等待不占剪辑槽，申请必须由正常审批队列和获批采集回执证明，不能通过改数据库或复制源文件绕过审批。普通任务、模拟来源和伪造标签不得申请、渲染、上传 MP4 或回写。附件更新接口无条件写入能力，真实联调时避免同时编辑目标附件字段。

只允许对 `WORD_ALIGNMENT_UNRESOLVED` 且尚无 render/制品证据的 VM run 提供用户手动规划重试。重试沿用原 task/run、已批准审批项和已校验素材，不重新申请或下载；开始前重新检查审批仍为 `ready`、获批采集回执有效且素材 SHA 未变。每次尝试写入独立、不可覆盖的输入目录并保留旧失败证据，最多三次规划尝试。Taskboard 本机重试接口必须 loopback 保护、校验任务版本，并要求本次明确授权原视频音轨 ASR 和新的本机规划文件写入；不得自动重试、不得对其他错误开放，也不得通过更改数据库状态绕过审批。

历史 task/run 专属审批若仅 `private_endpoints` 与冻结请求不同，只有在 job id 可由原 task/run 重新计算、其余请求字段完全一致、审批为 `ready` 且采集回执和源文件摘要复核通过时，才可迁移绑定到该 job 的请求；此恢复不重新下载。

剪辑包看板及显示偏好按学科、包别名和模板版本隔离，只从可信来源和冻结快照筛选任务。切换看板不得启用配置、启动执行器或补跑历史任务；已移除包仅可通过可信历史快照查看任务及调整显示偏好。VM 看板将已确认 MP4 轮次投影为等待飞书审核，不要求本机验收；只有同轮获准成片 NAS 校验发布成功才表示业务流程已完成。审核修改可连续生成新轮次，父成片必须匹配包、模板、学科、记录和附件字段；并发登记须重新核对父轮。归档请求冻结源与目标，重试不得改用后续成片。共用进度字段的归档处理仅截取进入归档选项的真实边沿，不得阻断初稿或审核触发。看板状态查询不得产生执行、联网、上传或配置启用副作用。

审核意见截图字段为空时允许文字审核流程；非空时必须由执行协议显式支持后才可继续。当前 v2 未定义图片资产输入，有图必须返回 `VM_REVIEW_IMAGES_UNSUPPORTED`，不得静默忽略图片生成交付。

## 标准命令

在仓库根目录 `D:\codex\codex-feishu` 执行：

```powershell
npm install
npm test
.\scripts\start-local.ps1
.\scripts\check-local.ps1
.\scripts\simulate-ready.ps1
.\scripts\check-local.ps1 -RequireFeishu
.\scripts\stop-local.ps1
```

`-RequireFeishu` 只在需要验证真实长连接时使用；模拟流程可以在监听器 disabled 时运行。

## 配置和安全边界

- 真实 Bridge 配置只放在被 Git 忽略的 `config/bridge.local.json`；示例结构维护在 `config/bridge.example.json`。Auto-Cut 包定义单独放在被 Git 忽略的 `config/taskboard-feishu-packages.json`，示例结构维护在 `config/autocut-packages.example.json`。
- `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 只放在 `.env.local` 或团队批准的密钥管理工具中，不写入飞书单元格、日志、任务描述或 Git。
- `CODEX_FEISHU_BRIDGE_SECRET` 只用于本机 Bridge/Taskboard 互认，放在 `.env.local` 或由 `start-local.ps1` 临时生成；不要写入飞书单元格、日志、任务描述、共享配置或 Git。
- 飞书单元格只能提供受控字段值和项目包别名；不能提供工作区路径、shell 命令、Codex 参数或 prompt。
- Bridge 只解析配置白名单中的项目包别名，并使用配置中的绝对工作区路径和固定 prompt。
- `CODEX_FEISHU_PACKAGES_PATH` 可覆盖默认包 registry 路径；启动脚本会在目标不存在时复制示例，但不会覆盖已有 registry。Taskboard 和 Bridge 必须使用同一路径，registry 中只有 `enabled` 包会进入 Bridge 白名单。

## 事件不变量

- `vm_pmo_review_video` 的 `initial` 阶段允许记录首次创建或首次填写状态时没有有效前选项、当前值直接为已启用触发项的事件登记初稿任务；仅限初稿阶段，`review` 仍要求从另一有效选项进入触发项，启用前已经停在触发项的历史记录不扫描、不补跑。
- 旧版 `tables` 配置只有从其他值变化到配置的可开始值（当前示例为 `待剪辑`）才创建任务；离开该值时，只归档同一 Base、表、记录和触发字段流程下仍为 Taskboard `todo` 的任务。
- Taskboard 管理的受控工作流按活动配置中的 `initial`、`first_review`、`final_review` 三个阶段处理；只有从其他 option 进入某个已启用阶段的 option 才创建该阶段任务。离开已启用阶段或进入另一已启用阶段时，只归档上一阶段同一记录仍为 `todo` 的任务；不会把飞书状态直接映射为 Taskboard 的 `in_progress`、`in_review` 或 `done`。
- 已是 `in_progress`、`in_review`、`done` 或其他非 `todo` 状态的任务不得被 Bridge 自动归档或中止。
- 当前不启用“飞书字段状态 → Taskboard 各流程列”的通用映射；Taskboard 的处理中等执行状态由 Taskboard/Codex 自己维护。
- 同一事件按 `event_id` 幂等处理：已持久化成功状态或同机有效租约下的正常重放不得创建第二个任务。整体投递语义是至少一次；Taskboard 没有原生原子幂等键时，不得宣称绝对 exactly-once。
- Taskboard 暂时不可用时必须持久化 `retry_wait`/`pending` 状态，按有限退避安全重试；Bridge 重启时恢复过期租约，超过上限的事件保留为 `dead_letter`，不得静默丢弃。
- 未知或缺失项目包别名必须阻断执行，不得把单元格内容当作路径或命令。

## 故障排查

1. 先运行 `.\scripts\check-local.ps1`，再根据输出查看 `.runtime\logs\bridge.stdout.log` 和 `taskboard.stdout.log`。
2. 真实事件需要运行 `.\scripts\check-local.ps1 -RequireFeishu`，监听器必须显示 `sdk_managed`。这只证明官方 SDK 已接管长连接；SDK 没有公开物理 socket 或连接回调，必须用指定测试表事件完成端到端验证。
3. 修改配置后先停止并重新启动服务，再用模拟事件验证；不要直接删除状态文件来“修复”重复任务。
4. 网络/DNS 重试持续发生时，记录时间和日志后再重启服务；不要在飞书表格中反复改动生产记录做测试。

状态文件不是合法对象映射时 Bridge 必须 fail-closed；不要用空文件或手工改写内容覆盖它。`stateFile` 必须是稳定的普通文件路径，不支持状态文件本身的符号链接、硬链接或多链接别名，也不要在运行中替换路径。状态文件的读写（包括健康队列统计）都经过同一校验和本机互斥锁；写入使用原子替换，进程间互斥由本机 Windows/Linux 的操作系统锁托管，进程崩溃后锁由系统释放；不要手工删除锁或状态文件来“修复”重复任务。Taskboard 成功响应结构异常会进入受控重试，HTTP 错误和日志只允许使用安全错误码。

生命周期归档按“同一记录、触发字段和阶段的全部匹配流程任务”筛选；如果离开阶段事件延迟到一次快速“离开 → 再次进入同一阶段”之后，旧事件可能把新一轮仍为 `todo` 的任务一并归档。这是当前至少一次事件模型下的已知边界，后续如需严格按轮次隔离再增加记录版本/事件顺序约束。

健康接口 `/health` 返回脱敏的监听器对象（`state`、`lastEventAt`、`lastError`）和队列计数（`pending`、`processing`、`retryWait`、`deadLetter`）。模拟事件在已持久化的 `retry_wait` 或 `dead_letter` 结果下返回 HTTP 202，表示 Bridge 已安全接收并记录，不能据此要求飞书重复投递。

## 变更规则

`AGENTS.md` 是本仓库唯一的运行规范文件。任何会改变事件筛选、任务路由、凭据处理、端口或启动方式的修改，都必须：

- 同时更新自动化测试和 README；
- 先在测试表/示例项目中验证；
- 经过代码评审后再合并。

不要创建第二份 `agents.md`，也不要把本地凭据或运行状态提交到仓库。
