# 飞书 Bridge 团队运行规范

## 固定数据流

生产流程固定为：飞书多维表格发生变化 → 飞书官方 SDK 长连接接收事件 → Bridge 按表和字段规则筛选、标准化、去重 → Taskboard 创建或归档受控任务。
Bridge 创建的飞书任务必须通过 Taskboard 的本机专用来源登记接口，并携带由启动脚本注入的 `CODEX_FEISHU_BRIDGE_SECRET`；普通任务描述中的标记或标签不能获得 Auto-Cut 执行资格。

Bridge 和 Taskboard 只绑定本机 loopback（`127.0.0.1`），不得改成 LAN 或公网监听。Bridge 永不启动 Codex；Taskboard 只有在“本机设置 → 允许本机自动剪辑”显式开启时，才可自动执行由 Bridge 专用接口登记、活动配置快照为 `automatic` 且项目包别名已在本机白名单中的任务。该开关默认关闭；尚未保存本机设置时，兼容 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` 作为初始值，保存后以本机数据库设置为准。设置立即生效并在重启后保留；关闭只取消尚未开始的自动预约，正在执行的任务继续完成，开启本身不补跑历史任务。普通任务、伪造描述标记或标签不得获得自动执行资格。旧 ZIP 流程仅在唯一 ZIP 成功发布后产生阶段完成及首个课程路径回写；VM/PMO MP4 流程使用下述独立的交付完成条件。目标仅限实时校验后已存在的字段与单选选项，回写通过认证的本机专用接口完成。模拟事件、普通任务和伪造标签不会创建交付目录、上传制品或回写飞书；整体投递仍为至少一次，不宣称 exactly-once。

模拟事件只用于本机测试和可靠投递演练，必须由 Bridge 标记为非生产来源；即使 Taskboard 的自动执行开关已开启，模拟事件也不得获得自动执行资格。

独立 `vm_pmo_review_video` 流程使用认证的 `/api/local/feishu/vm/tasks` 登记接口。包模板身份为 v1；可执行的包 manifest 必须同时声明 `vm_pmo_review_video` 执行协议 v2 和固定 driver。活动配置可启用 `initial` 与 `review` 阶段，使用实时校验过的单选选项边沿触发；初稿按正常 VM 审批队列取得源视频，审核只复用 Taskboard 已确认交付的上一轮 MP4，不另申请下载。VM 初稿审批以 Taskboard `task/run` 为幂等范围：同一任务重放复用原审批项，不同任务即使 VMID 与请求内容相同也创建独立审批项；手动下载仍按规范化请求复用，下载资源摘要按 `application_id` 隔离，同一申请不可经不同任务重复领取相同素材，不同已批准申请可独立领取相同素材；Bridge 的 `event_id` 去重保持独立。task/run 首次登记时冻结规范化审批请求；本机下载设置后续变化不得改写历史 run，VMID、部门和原因仍须匹配冻结任务上下文。Taskboard 启动时只自动恢复 `needs_attention/VM_TASK_BINDING_CONFLICT` 且没有 plan/render/制品证据的 run；恢复前必须重新验证原绑定审批仍为 `ready`、采集回执及源文件摘要有效，并沿用原 task/run/审批。其他 `needs_attention` 不自动恢复，已有 render 启动证据的 run 不得自动重跑。v2 支持明确保留区间和证据绑定的语音删词/静音/cue；词级操作必须绑定本轮源 SHA 和唯一词时间戳，缺少 ASR、匹配有歧义或保护词冲突时在渲染前阻断。该流程的完成凭据为同一 task/run 的唯一 MP4 校验通过、上传到配置附件字段并读回确认，不要求 ZIP；不得全局放宽旧 ZIP 的完成条件。实际 render 子进程启动后才回写处理中，附件读回确认后才回写阶段完成。独立成片归档只读取已确认的最新交付指针，重新校验 SHA 并采用无覆盖发布；同名异 SHA 为冲突。审批等待不占剪辑槽，申请必须由正常审批队列和获批采集回执证明，不能通过改数据库或复制源文件绕过审批。普通任务、模拟来源和伪造标签不得申请、渲染、上传 MP4 或回写。附件更新接口无条件写入能力，真实联调时避免同时编辑目标附件字段。

只允许对 `WORD_ALIGNMENT_UNRESOLVED` 且尚无 render/制品证据的 VM run 提供用户手动规划重试。重试沿用原 task/run、已批准审批项和已校验素材，不重新申请或下载；开始前重新检查审批仍为 `ready`、获批采集回执有效且素材 SHA 未变。每次尝试写入独立、不可覆盖的输入目录并保留旧失败证据，最多三次规划尝试。Taskboard 本机重试接口必须 loopback 保护、校验任务版本，并要求本次明确授权原视频音轨 ASR 和新的本机规划文件写入；不得自动重试、不得对其他错误开放，也不得通过更改数据库状态绕过审批。

对 `UNSUPPORTED_INSTRUCTION` 的人工返修另走源 SHA 绑定的结构化片段入口，仅限可信 VM task/run 在获批、素材与回执重新校验通过且无 render/制品证据时创建新规划尝试；原飞书意见不改写，旧尝试证据不覆盖，最多三次。`VM_APPLICANT_CHANGED` 且尚未产生审批项、规划或渲染证据的初稿 run 可在同一入口冻结返修，再恢复正常审批队列；新 task/run 仍需独立审批，绝不领取旧申请的素材。该入口必须 loopback、任务版本和本次源视频/本机规划授权三重约束；源 SHA 不一致时在渲染前阻断。

若 render 子进程已关闭，且原 run 精确停在 `needs_attention/VM_PMO_START_EVIDENCE_FAILED`、没有结果文件、MP4 或交付证据，可由用户通过 loopback 本机接口按当前任务版本手动恢复一次渲染。恢复前重新验证原审批 `ready`、采集回执、素材 SHA 和已保存规划 SHA；沿用原 task/run、审批及下载，不重新 ASR 或规划，保留首次启动时间证据。待启动的人工恢复仍受当前本机自动剪辑开关约束，关闭开关取消尚未开始的恢复；调用 spawn 前须持久记录启动意向，重启后不得将结果未知的启动意向重新开放为一次恢复。其他有 render 启动证据的 run 不开放此恢复，启动时不得自动恢复。VM 最新阶段判定忽略已归档的误触发任务，但仍以未归档的新阶段任务阻止旧轮次回写。

旧版校验器将合法的画面/语音同步 cue 误判为 `PLAN_INVALID` 时，仅允许人工通过本机 loopback 接口对同一 `needs_attention/PLAN_INVALID` run 重新校验已经保存的 ready 计划；要求任务版本匹配、原审批仍为 `ready`、获批采集回执和源 SHA 有效，并确认尚无 render 启动、结果或 MP4 证据。校验成功后沿用原 plan/run 继续渲染，不重新规划、识别、申请或下载；失败仍停在原状态，其他 `needs_attention` 不开放此恢复。

历史 task/run 专属审批若仅 `private_endpoints` 与冻结请求不同，只有在 job id 可由原 task/run 重新计算、其余请求字段完全一致、审批为 `ready` 且采集回执和源文件摘要复核通过时，才可迁移绑定到该 job 的请求；此恢复不重新下载。

剪辑包看板及显示偏好按学科、包别名和模板版本隔离，只从可信来源和冻结快照筛选任务。切换看板不得启用配置、启动执行器或补跑历史任务；已移除包仅可通过可信历史快照查看任务及调整显示偏好。VM 看板将已确认 MP4 轮次投影为等待飞书审核，不要求本机验收；只有同轮获准成片 NAS 校验发布成功才表示业务流程已完成。审核修改可连续生成新轮次，父成片必须匹配包、模板、学科、记录和附件字段；并发登记须重新核对父轮。归档请求冻结源与目标，重试不得改用后续成片。共用进度字段的归档处理仅截取进入归档选项的真实边沿，不得阻断初稿或审核触发。看板状态查询不得产生执行、联网、上传或配置启用副作用。

包 manifest 声明 contract v3 和固定 driver `vm_pmo_review_video_v3` 时，可信 VM task/run 改由 AI 意图规划：Taskboard 生成 schema v3 输入，规划步骤依次运行包 `analyze`、一次无人值守 Codex 会话（工作目录为本轮运行目录、`workspace-write` 沙箱且会话内命令不联网、剥离飞书/Bridge/VM/Jira 凭据，模型由 `CODEX_VM_PMO_AI_MODEL` 指定）和包 `plan`；AI 只能写 `edit-intent.json` 和新增证据，会话结束后若 input、execution-context、intent-context、analyze 回执或 ASR 对齐文件任一字节变化，或已出现 plan/plan-result/result/MP4/qa/qa-review/qa-result 文件（即使会话超时或失败），均在包 `plan` 前阻断为 `AI_INTENT_SCOPE_VIOLATION`，该阻断不开放同目录重跑；渲染后运行 `qa --reverse-asr`，`qa-result.json` 回执缺失或未绑定本轮 `plan.json`/`qa.json` 时不可交付，`overall: failed` 或 QA 未能运行均阻断。AI 步骤最长 15 分钟、不自动重试，超时、无意图或会话失败记为阻断且不回退固定句式；只能由用户经 loopback 接口按任务版本和本次授权在同一运行目录复用已有识别与证据重跑，每轮最多两次。结构化人工返修在 v3 下仍走 rule 规划。审核轮在 input.json 的只读 `prior_rounds` 中冻结以往各轮原意见，并用 `codex exec resume` 接回上一轮最后一次成功 AI 会话的同一对话，提示给出上一轮运行目录（只读）和本轮运行目录；续接未能开始会话时，在同一尝试中新开会话。AI 不提问、按剪辑准则执行到底，只有准则要求阻断时才写 blocked 意图。包 manifest 的 `interface.inputs` 含 `review_original_source` 时，审核轮登记时若上一轮为已完成的初稿（v2/v3 微秒片段计划、获批或人工素材、原文件仍在）或本身已回到原片的审核轮，则在 stageSnapshot 冻结 `reviewSource`（根初稿 run 与其已校验原素材），该审核 run 以原素材为源（`review_round.source_basis: "vm_original"`，只允许 ai_intent）；否则仍以上一轮成片为源。回到原片的审核轮在 `instructions` 中执行全部轮次意见（初稿在原片时间轴，`carried_over`；每轮审核意见在该轮所看那一稿的时间轴并带 `time_map_id`，本轮为 `current_round`），`time_maps` 为各稿 plan.json 的片段表，准备输入时按各 run 渲染的 planSha256 复核计划字节；不再发送 `prior_rounds`。准备输入和重试前复核原素材与冻结引用一致；链路不完整、计划被改或原素材缺失时以 `VM_PMO_REVIEW_SOURCE_INVALID` 阻断，不回退到成片。学科可选绑定一个“AI 处理说明”多行文本字段（`vmWorkflow.fields.aiNotesFieldId`，不得与其他绑定字段重复）：每轮交付完成或进入阻断/需要处理后，Taskboard 用该轮最后一次 AI 会话报告、包阻断明细与质检计数重建说明（最多 4096 字），以内容摘要为幂等键经认证 Bridge 回写，排在同 run 进度回写之后；未绑定时不回写，回写失败不影响交付。普通任务、模拟来源和伪造标签不得启动 AI 会话。

审核意见截图字段为空时允许文字审核流程；非空时必须由执行协议显式支持后才可继续。只有包 manifest 声明 contract v3 且 `interface.inputs` 含 `review_images` 时，审核轮才登记带截图的记录：登记时冻结截图引用（file_token、名称、大小、图片 MIME，最多 10 张），渲染前复核记录时截图变化视为记录变化；Taskboard 在 AI 步骤前把截图下载到运行目录之外（AI 不可写）的 `review-images/`，单张不超过 20 MB，记录 SHA-256 并在每次使用前复核，只作为图片附给 AI 会话用于理解意见，不进入 input.json，也不作为时间来源。v2、未声明的包或非图片附件仍返回 `VM_REVIEW_IMAGES_UNSUPPORTED`，不得静默忽略图片生成交付。

VM 初稿阶段可选在初稿进度字段上绑定“素材已就绪”和“下载失败”两个回写选项；两者均未绑定时行为不变。获批采集回执校验通过后回写素材已就绪并继续同一 run。审批驳回或撤销、审批或制作等待超时、下载重试耗尽或其他需处理状态、Shadow 登录连续失效超过 2 小时，统一将 run 置为 `blocked/VM_DOWNLOAD_FAILED`，回写下载失败并通知原因；此后该 run 不再自动领取原申请素材。Bridge 对从触发选项进入这两个选项的回写回声既不归档也不登记。只有真实飞书事件中“下载失败 → 素材已就绪”的边沿，经认证的 `/api/local/feishu/vm/manual-source` 接口提交人工素材，且仅限 VM 已确认审批通过（有 application_id、instance_code 和审批后等待证据）、尚无 plan/render/制品证据的同一初稿 task/run。Taskboard 只按冻结 VMID 读取本机 VM 下载目录下“人工素材”文件夹中的 `VMID.mp4`，复制到 run 自有目录并按获批视频同等规则校验（完整解码、分辨率不低于 1280x720、大小上限），记录为 `operator_asserted` 及其 SHA 后沿用原 task/run 和原审批继续；不重新申请、不领取其他申请的素材，后续重试按该回执重新校验 SHA。文件缺失、同名歧义或校验失败时保持阻断并再次回写下载失败。未获批的失败只能把进度改回初稿触发选项，登记新任务并重新审批。表格单元格不能提供路径。渲染前复核记录时，状态为触发选项或已回写的素材已就绪均视为未变化。

## 标准命令

在仓库根目录执行：

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
- Taskboard 的 Shadow 登录凭据只能以 Windows DPAPI（当前 Windows 用户范围）加密后保存在本机数据目录的 `vm-shadow-session.bin`，不得以明文写入磁盘、日志、飞书或 Git；无 DPAPI 的平台不保存。重启恢复时必须重新验证身份且账号一致，断开账号或认证失效时删除。登录失效时只允许在本机默认浏览器打开固定 Shadow 登录页，每次失效最多自动打开一次。
- Codex 的 AI 接口（多套服务商地址、key、日常模型与 AI 剪辑模型）在“本机设置 → AI 接口”中管理，只走 loopback 本机接口且要求 `x-taskboard-client: web`。保存的 key 只能以 Windows DPAPI（当前 Windows 用户、独立用途标签）加密后存于 Taskboard 数据目录的 `ai-provider-keys.bin`，任何接口响应、日志、飞书或 Git 都不得返回或写入 key，界面只显示末 4 位；无 DPAPI 的平台不保存。“设为当前”先把原 `config.toml` 备份为 `config.toml.taskboard-backup`，再只改写其中 Taskboard 专用的 `[model_providers.taskboard]` 表及顶层 `model_provider`、`model`，其余 Codex 配置原样保留；Codex 自身要求该表中的 key 为明文。当前接口的 AI 剪辑模型优先于 `CODEX_VM_PMO_AI_MODEL`；已登记 run 的 `ai_session.model` 冻结不变，切换后与冻结模型不一致的 run 以 `VM_PMO_AI_SESSION_CHANGED` 阻断，不改用新模型。
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
