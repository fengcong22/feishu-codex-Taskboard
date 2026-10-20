# VM 素材采集验证

`taskboard/cli/vm-approval.mjs` 是独立运行的审批申请与素材领取入口：本机排队 → 正常登录 → 申请 → 等待批准与制作完成 → 下载和媒体校验。`taskboard/cli/vm-source.mjs` 保留为操作者提供已获批 HTTPS 地址或本机 MP4 的采集入口。两者成功后均使用准确文件与回执，不扫描“最新文件”；CLI 仍是独立操作者入口，不直接登记 Bridge 受控任务、启动自动剪辑、上传 PMO 附件或回写。

PMO 业务来源在「学科 PMO 配置 → 对应 VM 剪辑包 → 视频来源」选择 VMID 文本字段并配置申请部门和用途，不需要为每条 PMO 记录手填 VMID。独立 `vm_pmo_review_video` workflow 已接通 `initial` 与可选 `review`：初稿使用真实审批下载；审核使用 Taskboard 已确认交付的上一轮 MP4，不重复申请 VM 下载。包 manifest 和本机 runtime 须满足 v2 contract/driver 后才能启用审核。Taskboard 冻结原始意见并交给剪辑包；删词、静音和 cue 的语义理解、时间定位及保护词冲突检查均由剪辑包完成，并使用源哈希绑定的词级证据。Taskboard 校验输入/回执身份和最终成片，不重复推导剪辑操作。完整配置仍须显式启用；最终成片 NAS 归档由独立可选 worker 处理。实现与离线验证不代表真实整链路已验收，新申请到下载、渲染、附件读回及归档仍须用指定测试记录验证，步骤见 [VM / PMO 联调](vm-pmo-offline-integration.md)。

全局「VM 账号与队列」负责共享 Shadow 会话和独立下载监控。「手动批量下载（补救入口）」默认折叠，展开后仍可提交临时下载；其申请默认值不会覆盖任何学科或包草稿。

## 审批 CLI 的日常使用

需要 Node.js 22.13+，下载时需要 `ffprobe`、`ffmpeg` 和可达资源服务器的网络/VPN。以下命令在仓库根目录运行。请求、队列和制品均保存在被忽略的 `.runtime/`；请求不接受令牌、下载 URL、shell 命令或 Codex 参数。

先创建 `.runtime/vm-download-check/approval-request.local.json`，按本机真实位置修改 `output_root`。以下 VMID 和目录仅为示例：

```json
{
  "schema_version": 1,
  "vmid": "0123456789abcdef01234567",
  "department": "动画组",
  "reason": "切片剪辑",
  "output_root": "E:\\codex\\feishu-codex-Taskboard-main\\.runtime\\vm-download-check\\materials",
  "allowed_origins": ["https://vm-resource.yangcong345.com"],
  "private_endpoints": [
    { "origin": "https://vm-resource.yangcong345.com", "addresses": ["10.8.8.11"] }
  ]
}
```

必填字段为 `schema_version: 1`、24 位小写十六进制 `vmid`、纯文本 `department`（最多 100 字符）、`reason`（最多 500 字符）、绝对路径 `output_root` 和精确 HTTPS origin 数组 `allowed_origins`。`private_endpoints` 可选，只能配置操作者已确认的 origin/RFC1918 IPv4 地址。首版用途固定 `ORIGINAL`、质量固定 `HIGH`；实际文件宽、高均不得低于 1280x720，允许更高分辨率。

已有申请可增添 `application_id`，直接接管该申请；身份、原因、用途、质量、VMID 与飞书审批实例绑定仍须通过后台校验。可选 `reuse_receipt` 为已有 `acquisition.json` 的绝对路径，必须同时填写 `application_id`，且回执必须绑定同一 VMID、同一申请及同目录的 `source.mp4`。复用重新核对 SHA-256、字节数与既有媒体校验结果，不重新传输或全量解码。人工采集的既有回执继续标为 `operator_asserted`，不会升级成 API 绑定凭证。

```powershell
node taskboard/cli/vm-approval.mjs enqueue --request .runtime/vm-download-check/approval-request.local.json --state .runtime/vm-download-check/approval.sqlite --id vm-test
node taskboard/cli/vm-approval.mjs status --state .runtime/vm-download-check/approval.sqlite --id vm-test
node taskboard/cli/vm-approval.mjs run --state .runtime/vm-download-check/approval.sqlite --id vm-test --login
```

`enqueue` 只校验并持久化请求，不访问 VM；省略 `--id` 时由请求内容生成稳定 ID，同一请求即使用不同 ID 入队也返回已有任务，不重置进度。`status` 省略 `--id` 时列出全部摘要。`run` 输出 `awaiting_login` 和 `login_url` 后，在浏览器完成正常 Shadow SSO；登录窗口默认 10 分钟，临时接收器仅监听 `127.0.0.1`。令牌只保留在内存，响应中的轮换令牌也仅用于本进程后续请求。支持由进程环境提供 `SHADOW_TOKEN` 代替 `--login`，不接受命令行令牌，也不隐式读取 `.env`。空 Bearer 和缺失申请参数均在请求前拒绝。

`tick` 与 `run` 参数相同但只推进一次，不接受 `--max-wait-ms`。两者支持 `--ffprobe ABSOLUTE_PATH`、`--ffmpeg ABSOLUTE_PATH`。`run` 默认最多等待 30 分钟，可用 `--max-wait-ms` 指定正整数毫秒；期限在操作之间检查，已开始的 API 请求或下载会安全完成。待审批或待制作时每 60 秒查询一次，单次休眠不超过 30 秒。Ctrl+C 中断等待；保留队列，以同一 ID 再运行即可继续，进程重启后重新登录。退出后没有后台服务继续轮询。

### 状态与恢复

| 状态 | 行为与操作 |
| --- | --- |
| `queued` / `submitting` / `reconciling` | 校验身份并持久化提交意图，最多提交一次，再核对申请列表；响应不明时不重复 POST。 |
| `waiting_approval` / `waiting_media` | 等待 `APPROVED` 和对应资源 `finished`；待审批状态即使返回 URL 也不下载。 |
| `retry_wait` | API 暂时失败按有限退避重试，起始 60 秒、间隔上限 30 分钟，最多 6 次失败后保留为 `dead_letter`。 |
| `acquiring` | 传输前已保存精确回执路径；中断恢复只认该文件和回执，通过摘要、大小、媒体结果与 API 审批绑定检查后才转 `ready`。 |
| `ready` | 已取得或复用了校验通过的文件，摘要含精确路径、字节数、SHA-256 与媒体规格。 |
| `auth_required` / `dead_letter` | 恢复认证或处理网络故障后，用 `resume` 恢复原阶段，再运行 `run --login`；提交意图保留。 |
| `rejected` / `canceled` | 申请被驳回或取消，停止领取。 |
| `needs_attention` | 绑定不符、申请匹配不唯一、提交/下载结果不明、资源已被其他任务占用，或排队超过 7 天等；停止并人工核对，不支持直接 `resume`。 |

```powershell
node taskboard/cli/vm-approval.mjs resume --state .runtime/vm-download-check/approval.sqlite --id vm-test
node taskboard/cli/vm-approval.mjs run --state .runtime/vm-download-check/approval.sqlite --id vm-test --login
```

缺少登录凭据时 CLI 返回 `VM_AUTH_REQUIRED`，原任务状态保留；只有后台认证拒绝导致任务进入 `auth_required` 才需要先 `resume`。`resume` 不能清除下载结果不明，也不会重新申请。提交后最多核对 6 次仍找不到唯一申请时转人工核对；不能通过换 ID 或删除队列强制重提。

状态库使用 SQLite 事务、进程间锁与可续期租约，损坏状态、符号链接或硬链接路径会关闭处理。下载地址只在内存中，库内仅存摘要；资源占用按 `(application_id, fingerprint)` 唯一，同一 VM 申请不能由多个队列项重复领取，不同已批准申请可分别领取相同素材。升级旧状态库时，已有全局占用会迁移到原所有者的申请编号，不丢失队列或占用记录。不得用另建数据库、清空状态或手工改写数据解除占用。下载结果不明且精确回执未成功发布时转 `needs_attention`，不自动重放单次领取地址。

申请接口没有已验证的服务端幂等键，因此不承诺绝对 exactly-once。提交意图已落盘但实际 POST 尚未发出的崩溃窗口，会保守进入核对状态；无法唯一找到申请时停止，不自动补发。

审批 CLI 退出码：`0` 表示命令成功或 `ready`；`2` 请求无效；`3` 失败、驳回、取消或需要人工处理；`4` 仍在等待；`5` 需要认证；`130` 用户中断。输出为脱敏 JSON，`--login` 先输出一行登录信息，再输出最终摘要。申请状态读取不依赖邮箱权限。

2026-10-09 新 CLI 已实际通过 `tick --login` 接管既有获批测试申请，并用 `reuse_receipt` 复核先前文件后返回 `ready`、退出码 `0`：提交次数 `0`、下载次数 `0`、14,937,774 字节、255.125 秒、1280x720，SHA-256 与既有文件一致。回执仍为 `operator_asserted`。新 worker 的全新申请到首次下载尚未完成真实整链路验收；此前后台提交与真实下载的独立验证记录见下文。

## 认证与接口边界

初次授权使用 VM 当前前端的 Shadow SSO 流程和临时 loopback 回调，尚无正式外部客户端稳定契约。当前实现会在本进程内接收轮换令牌；长期令牌续期、进程重启后自动恢复登录尚未实现。新 worker 不需要读取邮箱、浏览器 Cookie 或存储。业务认证头仅发往固定 Shadow origin，素材下载不携带认证头。

## 已确认的下载流程

VM 下载需要先申请审批。审批通过后，邮件中的 `https://vm.yangcong345.com/applyResult?...` 是审批结果页，不是视频文件。在人工 CLI 路径中，操作者确认结果页为已批准、目标文件制作完成，并核对视频与 VMID 后，将页面提供的实际视频下载地址写入本机请求文件。

人工 `vm-source.mjs` CLI 由操作者核对 VMID，采集回执将这种绑定标为 `operator_asserted`，不代表已通过 VM API 验证。审批 worker 经接口校验后首次下载的回执标为 `vm_api_verified`，记录对应审批实例和资源 ID；复用旧回执不会改变其声明。2026-10-09 的后台接口验证已对测试素材同时核对 `getVideoList.videos[].id`、申请结果 `urlObjList[].id` 与输入 VMID 完全一致；该证据保存在本机验证记录中，不改写既有采集回执，也不能据单个样本推断所有结果条目的 ID 语义。`video_variant` 是操作者的版本声明，实际分辨率、时长、编码和音轨由媒体探测记录。本次学科流程以 1280x720 为采集最低尺寸，使用 `approved_rendition`，并在请求内填写 `expected_resolution`；任何视频流宽或高低于对应下限时报 `SOURCE_RESOLUTION_MISMATCH`，不发布文件。更高分辨率不会因尺寸不等于 1280x720 被拒绝。

2026-10-09 已完成一条获批文件的真实下载验证：连接公司 VPN 后成功下载并通过全量解码。实测 14,937,774 字节、时长 255.125 秒、1280x720、25 fps、H.264 视频与 AAC 双声道 44.1 kHz 音频，满足用户确认的 720p 要求。连接 VPN 前本机 TCP 443 不可达，下载安全失败；本机生成的测试 MP4 也已跑通离线复制、SHA-256、元数据探测、全量解码与回执发布。

## 自动申请与领取验证进度

2026-10-09 已通过已登录 VM 网页，为同一测试视频提交一次下载申请，填写用途“原始视频”、部门“动画组”、原因“切片剪辑”。官方飞书审批 API 已能在后台查询该申请，并核实状态为 `APPROVED`。审批详情没有返回 VM 申请 ID、VMID 或结果页链接；不能用审批实例 ID 替代 VM 申请 ID，也不能把审批通过当作文件制作完成。

此前的网页申请已完成网页领取与后台下载验证：在已登录飞书网页版中找到申请时间一致的通知，从通知链接进入已登录 VM 结果页，核对申请人、时间、用途、原因、视频名称、“已批准”和“制作完成”，再将该页目标条目的实际下载地址交给本机 CLI。2026-10-09 18:09（北京时间）下载成功，实测 14,937,774 字节、255.125 秒、1280x720、25 fps、H.264 与 AAC 双声道，SHA-256 与此前同一素材一致，媒体元数据和全量解码校验均通过。这次领取未要求用户手工提供链接。

随后已完成 VM 后台申请与结果领取接口的真实验证。通过 VM 使用的 Shadow 正常 SSO 流程，将一次授权码回调到临时 `127.0.0.1` 接收器，后台交换得到仅保存在内存的令牌；身份、视频、部门、申请列表和申请详情查询均返回 HTTP 200。在提交前保存本机意图记录，随后只调用一次后台申请接口，返回 HTTP 200 和空对象。后台列表确认新增且唯一匹配的申请，并取得 VM 申请 ID 和飞书审批实例号。该申请先观察到 `PENDING`，随后 VM 详情与飞书官方审批接口均确认 `APPROVED`，目标资源为 `finished`、`HIGH`，资源 ID 与已查询的视频 ID 和输入 VMID 一致。

本次后台接口直接返回获批资源地址，无需读取邮箱或结果网页。新地址与此前已消费的地址完全相同，因此未重新请求视频文件，复用了已通过媒体校验的 1280x720 文件，并重新核对 SHA-256 与字节数。此次验证没有重新执行文件传输或全量解码；既有采集回执保持不变。本机脱敏证据位于被忽略的 `.runtime/vm-download-check/background-api-validation.local.json`。

这证明一次正常授权之后可以在后台申请、查询审批结果并取得资源地址。随后已封装为上文的持久化审批 worker，初次授权仍走网页 SSO，长期无人值守认证尚未完成。本次独立验证结束后已清除内存令牌并关闭临时接收器。VM 直接结果查询通路不依赖邮箱读取权限。

### 已实测的后台接口

后台 origin 固定为 `https://shadow.yangcong345.com`，业务前缀为 `/api/video-manager`。接口来自 VM 当前公开前端（版本 `33dadec`）实际调用定义，尚无下载接口的正式稳定性文档。

| 接口 | 用途与实测约束 |
| --- | --- |
| `GET /api/auth/code/{code}` | 交换正常 Shadow 回调的授权码；不读取浏览器 Cookie 或存储。 |
| `GET /api/auth/me` | 获取当前身份；申请人的 `feishu*` 字段取同次响应的 `raw.feishu`。 |
| `POST /api/video-manager/video/getVideoList` | `{pageIndex, pageSize, videoIds}` 精确查询，要求唯一目标的 `id` 等于输入 VMID。 |
| `POST /api/feishu-open-apis/contact/v1/department/detail/batch_get` | 请求 `department_ids` 来自当前身份；唯一匹配选定部门名称，提交其 `id`。 |
| `POST /api/video-manager/video/applyVideo` | 提交申请；本次返回空对象，需通过列表核对新增记录，不把 HTTP 成功当作已获批。 |
| `POST /api/video-manager/videoApply/getVideoApplys` | `{page, size, beginTime, endTime, applyType:"VIDEO_DOWNLOAD"}` 返回 `{list,count}`；`instanceCode` 可精确关联飞书审批。日期为空的默认查询已实测有效，同日 `beginTime=endTime` 返回零条，不能据此认定没有提交成功。 |
| `GET /api/video-manager/videoApply/getVideoApply?id={applicationId}` | 按 VM 申请 ID 查询审批状态、质量和 `urlObjList`；资源地址无需邮件。 |

申请字段包括 `videoIds`、`applyReason`、`department`、`videoUse`、`videoQuality`、`fileBase64`、`watermark`、`feishuUserName`、`feishuOpenId`、`feishuDepartmentId`、`feishuUserId`、`feishuUserEmail`、`isMergeSubtitle`。本次用途 `ORIGINAL` 对应质量 `HIGH`（VM 枚举为 1280x720），空模板和水印，不合并字幕。`department` 为所选部门选项 ID，`feishuDepartmentId` 按现有页面行为取当前身份的首个部门 ID；两个字段不可混同。请求仅使用用户正常授权取得的身份，不使用公开前端中的其他服务密钥。

待审批申请也可能返回 `finished` 和资源 URL。领取 worker 同时要求 `applyStatus === "APPROVED"`、目标资源 ID 精确匹配、条目 `status === "finished"` 和期望质量；有 URL 不能替代审批检查。业务认证头只发给固定 Shadow origin，不能传给素材下载 origin。视频文件最终仍须实测为 1280x720。申请接口未观察到幂等键；提交意图先持久化，响应不明时核对申请列表，无法唯一关联则停止，不能盲目重提。

“原始视频”用途不保证所有素材恰为 720p，最终仍须校验 `expected_resolution` 给出的最低尺寸。当前要求宽、高分别至少为 1280 和 720，尺寸更高时可继续使用。通知声明链接 72 小时后过期、下载一次后失效；自动领取采用上述单次领取保护与精确回执恢复。历史验证的请求文件位于已忽略的 `.runtime/`；新审批状态库不保存下载地址。

## 面板队列的本机配置与恢复

入口为 Taskboard「本机设置 → VM 下载」。面板管理共享账号与持久化下载队列，独立 PMO 初稿运行时使用同一队列并冻结精确申请绑定。「手动批量下载」仍是操作者补救入口，不会通过下载申请获得自动剪辑执行资格。批量是最多 50 条单视频申请，不代表一个审批单合并 50 个视频。手动下载的相同规范化请求返回原任务；修改部门、用途或输出目录会成为不同请求，应先检查现有任务。受控 VM 初稿按 Taskboard task/run 幂等，同一任务重放复用原审批项，不同任务即使 VMID 与请求一致也可各自申请；资源摘要按 VM `application_id` 隔离，同一申请内防止重复领取，不同已批准申请可各自领取。

升级兼容：旧版同一审批项若已绑定多个初稿任务，启动时按 `created_at`、再按 `task_id` 确定唯一保留者；其他任务解除旧关联，并在后续协调时申请各自的 task/run 审批项。若旧版在审批入队后、任务绑定落库前崩溃，系统会按精确申请指纹恢复 legacy 队列项。旧版审批项没有记录“手动下载”或“任务流程”的来源，因此无法从该队列记录区分其原始用途；恢复仍要求请求指纹和申请内容完全匹配，并继续使用正常审批及获批采集回执。

Taskboard 随服务启动持久化 worker，按 `next_attempt_at` 处理任务；正常待审批不会耗尽网络失败重试次数，没有 CLI 的 30 分钟等待退出限制。唯一匹配申请绑定时开始审批七天计时；审批通过才开始独立的制作七天计时。24 小时待审批、需要重新登录、已知到期前 15 分钟、驳回、撤销、超时和失败可发送飞书提醒。通知以稳定幂等 ID 入本机 outbox，失败最多六次退避；跨进程崩溃仍为至少一次，不承诺永久的绝对去重。

本机 API 为 `/api/local/vm-downloads`，仅 loopback。写操作要求同源校验、`x-taskboard-client: web` 和 JSON；不接受网页提交任意素材 origin、私网地址或凭据。设置、脱敏收件人及通知 outbox 保存在 Taskboard SQLite，Shadow 凭据只在内存。断开账号暂停后续请求和尚未开始的素材传输，已经开始的传输完成当前安全操作。

默认队列为 `CODEX_TASKBOARD_DATA_DIR/vm-approval.sqlite`。若其同级 `vm-download-check/approval-workflow.sqlite` 已存在且默认队列不存在，则直接沿用旧 CLI 状态库，保留单次提交和资源消费记录。两处同时存在时拒绝猜测，面板显示 `VM_DOWNLOAD_STATE_AMBIGUOUS`；先核对历史，再用绝对路径 `CODEX_VM_APPROVAL_STATE` 指定唯一队列。不要删除状态库、复制空库或更换队列来重试。

以下设置仅由本机可信 `.env.local` 或进程环境提供；环境变量优先。读取 `.env.local` 不会把飞书应用密钥注入 Codex 子进程，面板不显示其内容。

| 设置 | 用途 |
| --- | --- |
| `CODEX_VM_APPROVAL_STATE` | 可选的既有审批 SQLite 绝对路径；未设置时按上述规则选择。 |
| `CODEX_VM_DOWNLOAD_PRIVATE_ENDPOINTS_JSON` | 可选的精确内网 origin/IP 列表；仅允许固定素材 origin，未设置时拒绝内网 DNS。 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 既有飞书机器人应用身份，用于异常通知；不配置时下载仍可运行，面板提示通知不可用。 |

已确认的企业素材内网地址示例（应由本机操作者核对当前网络，不能从审批记录或单元格自动生成）：

```dotenv
CODEX_VM_DOWNLOAD_PRIVATE_ENDPOINTS_JSON=[{"origin":"https://vm-resource.yangcong345.com","addresses":["10.8.8.11"]}]
```

面板对 `VM_SOURCE_ADDRESS_NOT_ALLOWED` 提供“更新白名单后使用原审批重试”。该错误发生在 HTTP 下载请求发出前；更新当前本机精确白名单后，Taskboard 会检查本轮采集目录中的 `source.mp4`、`source.mp4.part`、`acquisition.json` 和 `acquisition.json.part` 均不存在，再用新策略继续查询同一条已批准申请。

面板也允许操作者对 `VM_DOWNLOAD_OUTCOME_UNKNOWN` 手动恢复。该错误表示传输已开始，但没有确认完整交付；Taskboard 不会自动重试。面板的 `diagnostic_code` 会用稳定错误码区分 HTTP 拒绝/资源不存在、TLS 错误、连接重置、超时、媒体校验或采集阶段失败，不包含 URL、响应正文或原始异常信息。操作者须确认 VM 允许在原审批下重复获取，Taskboard 随后检查上述本机采集文件均不存在，核对当前精确白名单、原审批与资源状态后再获取。审批编号、申请编号、资源占用保持不变，不会再次提交审批；只有 VM 仍返回 `APPROVED` 且资源为 `finished` 才会重新采集。存在任一完整视频或回执时恢复会被拒绝。

旧队列中的 `VM_RESOURCE_ALREADY_CLAIMED` 可在状态库迁移后显示“确认并用当前审批重试”。仅当记录保存了与本记录绑定的独立 `APPROVED` 凭据且当前申请此前没有成功采集回执时才允许恢复；操作者确认后，会沿用这条已批准申请并重新检查审批状态，不会新建申请。相同 `application_id` 的资源占用仍会阻止第二个队列项领取；不同已批准申请的资源占用彼此独立。

需要公司网络/VPN，以及 PATH 中的 `ffprobe`、`ffmpeg`。改变本机配置后正常重启 Taskboard；队列会保留，但需再次连接 Shadow。桌面默认值为当前用户主目录下的 `Desktop`；若系统桌面已重定向到 OneDrive 或其他位置，请在面板保存实际绝对路径。完成任务展示校验后的准确文件路径。

飞书应用必须开启机器人、具备发送消息权限并对登录用户可用。收件人来自 Shadow 已验证身份的企业邮箱；不复用另一个应用的 open_id，也不发送 Token、下载链接或 loopback 回调地址。通知状态包含配置/接收人缺失或发送失败的安全错误码；即使消息失败，任务状态仍可从面板恢复。关闭通知只停止后续发送，不能撤回已发出的消息。

当前支持电脑正常 SSO 回调后的自动续接，尚未发现可验证的 Shadow 自动续期/跨设备授权契约。`/auth/sendMsg`、`/auth/check` 是短信验证，并非飞书授权轮询。仅凭用户截图的“6 小时”不能推导当前精确到期时间；只有 JWT 自带 `exp` 时显示提示，最终可用性以身份接口为准。认证失败暂停队列，网络临时不可用保留会话并自动复查。

## 人工采集 CLI 的本机请求

请求文件保存在已忽略的 `.runtime/` 内。签名下载 URL 不能写入 Git、共享配置、PMO 单元格、任务描述或普通日志。以下占位内容不可直接运行：

```json
{
  "schema_version": 1,
  "vmid": "0123456789abcdef01234567",
  "source": {
    "kind": "approved_url",
    "approval_ref": "approved-application-id",
    "video_variant": "approved_rendition",
    "expected_resolution": { "width": 1280, "height": 720 },
    "url": "https://vm-resource.yangcong345.com/APPROVED-VIDEO.mp4",
    "allowed_origins": ["https://vm-resource.yangcong345.com"],
    "private_endpoints": [
      {
        "origin": "https://vm-resource.yangcong345.com",
        "addresses": ["10.8.8.11"]
      }
    ]
  }
}
```

`allowed_origins` 和 `private_endpoints` 只能由本机操作者填写可信配置，不能从飞书记录或其他远端输入自动生成。每一跳重定向都重新检查 HTTPS、origin 和全部 DNS 地址。私网例外仅允许精确 origin 与 RFC1918 IPv4 地址；loopback、link-local、IPv6 或未批准的混合 DNS 结果仍被拒绝。下载不发送 Cookie 或 Authorization。VPN 不通时不能扩大白名单绕过。

已下载本机文件使用绝对路径：

```json
{
  "schema_version": 1,
  "vmid": "0123456789abcdef01234567",
  "source": {
    "kind": "approved_file",
    "approval_ref": "approved-application-id",
    "video_variant": "approved_rendition",
    "expected_resolution": { "width": 1280, "height": 720 },
    "file": "E:\\approved-materials\\source.mp4"
  }
}
```

尚未获批使用 `"source": { "kind": "approval_required" }`，返回 `blocked / SOURCE_APPROVAL_REQUIRED`，不创建采集目录。`approved_url` 与 `approved_file` 可选填 `expected_sha256` 和 `expected_bytes`，用于核对已有准确摘要；`expected_resolution` 提供本次采集的最低像素尺寸，当前学科流程使用 1280x720（宽、高分别至少达到该值，允许更高尺寸）。

## 运行与结果

需要 Node.js 22.13+，以及 PATH 中可用的 `ffprobe` 和 `ffmpeg`。也可以显式指定两个工具的绝对路径。

```powershell
node taskboard/cli/vm-source.mjs acquire `
  --request .runtime/vm-download-check/request.local.json `
  --output-root .runtime/vm-download-check/materials `
  --timeout-ms 600000
```

默认单文件上限 20 GiB、单阶段最长 30 分钟；`--max-bytes`、`--timeout-ms` 必须为正整数且不超过上述上限。媒体工具只接收本机文件协议，先执行 MP4 元数据探测，再对视频和存在的音轨全量解码。允许无声视频，不自动添加音轨。

每次采集使用新的 `vm-<vmid>-<随机值>` 目录，不扫描“最新文件”或覆盖已有制品。成功回执包含准确文件路径、SHA-256、字节数、时长、视频/音频参数和审批引用，不包含下载 URL。失败不发布可用源文件；空目录可能保留用于定位此次尝试。文件和回执正式发布后，临时链接清理尽力执行；文件系统拒绝清理时可能保留 `.part`，正式回执及其源文件仍保持有效。

| 退出码 | 结果 |
| --- | --- |
| `0` | `ready`，文件和回执已发布。 |
| `2` | `VM_REQUEST_INVALID`，请求或参数无效。 |
| `3` | 采集失败，输出脱敏错误码。 |
| `4` | 审批未完成，`SOURCE_APPROVAL_REQUIRED`。 |

`VM_SOURCE_TRANSFER_FAILED` 仅表示传输未完成，不暴露签名 URL 或底层错误。先检查公司内网/VPN 与资源服务器端口连通性；重试前确认链接未过期、未被消费，已发布并通过校验的文件直接复用。链接失效时须通过获批结果页或受认证的 VM 申请详情接口确认可领取资源，不能盲目重放同一请求或重新申请。人工采集 CLI 本身不自动重试或申请审批；审批 CLI 的重试与恢复规则见上文。

```powershell
node --test taskboard/test/vm-source-transfer.test.mjs `
  taskboard/test/vm-source-adapter.test.mjs `
  taskboard/test/vm-source-cli.test.mjs `
  taskboard/test/vm-approval-auth.test.mjs `
  taskboard/test/vm-approval-client.test.mjs `
  taskboard/test/vm-approval-store.test.mjs `
  taskboard/test/vm-approval-workflow.test.mjs `
  taskboard/test/vm-approval-cli.test.mjs
```
