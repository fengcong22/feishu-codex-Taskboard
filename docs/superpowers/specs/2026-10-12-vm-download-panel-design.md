# VM 下载面板与常驻队列

用户已在本会话确认实施：Taskboard 常驻队列、共享 Shadow 登录、审批等待与恢复、面板入口及飞书异常提醒。手机/电脑飞书直接确认后换取 Shadow 凭据、独立自动续期尚无可验证服务端契约，界面必须准确报告能力，不能伪造授权成功。

## 可交付行为

- 本机设置提供共享的「VM 账号与队列」。PMO VMID 字段、申请部门/原因属于学科与 VM 包的流程配置。手工输入一个或多个 VMID、部门、原因、本机输出目录保留为默认折叠的「手动批量下载（补救入口）」；每个 VMID 独立申请，批量入队先校验全部输入，重复请求返回现有任务。学科自动流程目前仍为草稿预览，不能把独立下载队列描述为已接通 PMO。
- 下载任务独立于 Auto-Cut 受控任务，不能获得剪辑执行资格；不更改 Bridge 事件筛选、包白名单、自动剪辑开关或 PMO 回写。
- 随 Taskboard 启动的 worker 按到期时间处理持久化队列，没有 30 分钟退出限制。仅一个循环处理，现有 SQLite 租约及单次提交/领取约束继续生效。退出时等待当前安全操作完成，再关闭会话与存储。
- 通过正常 Shadow SSO 连接账号；凭据仅在后端内存中，多个任务共享一个客户端，响应轮换仅更新该客户端。界面不接受或显示 Token。程序重启保留队列，但需要重新连接账号才继续处理。
- 定期通过身份接口检测会话；获取有效凭据后验证身份。解析 JWT 的 exp 仅作为到期提示，服务端鉴权才是可用性依据。不以“当前时间 + 6 小时”伪造准确有效期；用户截图提供的 6 小时仅是参考规则。暂不调用猜测的续期接口。
- 正常 SSO 回调后，仅对同一用户的 auth_required 任务自动恢复原阶段；更换账号不自动推进原账号任务。网络错误与认证失效分别显示，失败时不清空队列、不重新申请。
- 待审批每分钟查询 VM；仅 APPROVED 且对应资源 finished 才领取。驳回/撤销停止；等待 24 小时提醒一次；审批确认提交后最多等 7 天，超时暂停并支持明确延长 7 天。制作等待独立计时；异常保留原申请。
- 通过现有飞书应用的机器人向登录用户发送文本异常通知：需要重新连接、已知到期时间临近、24 小时待审批、驳回/取消/超时/失败。以 Shadow 已验证身份的企业邮箱寻址，避免跨应用复用 open_id。通知按任务/会话去重，失败退避；无凭据或权限时面板显示通知不可用。消息中不包含 Token、下载 URL 或本机回调地址。无需搭建公网监听；本轮不发送测试消息或真实生产申请。
- 桌面默认输出目录，但用户可在本机面板指定绝对目录；资源 origin 固定白名单。内网资源地址必须通过本机受控配置提供，网页与飞书记录均不能注入任意源站或 shell 参数。

## 本机 API

所有路由位于 `/api/local/vm-downloads`，继承 Host/Origin/loopback 校验；写操作额外要求 `x-taskboard-client: web` 和 JSON。不得通过共享配置导出凭据或本机路径。

- GET 根路径：`{ session, settings, jobs, notifications }`。
- PUT `/settings`：`{ outputRoot, department, reason, notificationsEnabled }`。
- POST `/login`：返回 `{ loginUrl, session }`，后台等待回调，前端打开正常 SSO。
- POST `/logout`：关闭当前登录接收器、清除内存客户端，暂停网络处理。
- POST `/jobs`：`{ vmids: string[], department, reason, outputRoot }`，每批最多 50 个，全部验证后入队，返回 `{ jobs }`。
- POST `/jobs/:id/resume`：恢复可重试失败；认证任务在同账号重连后自动恢复。
- POST `/jobs/:id/extend`：仅延长审批/制作等待超时，保留申请 ID。

`session`：`{ status: 'disconnected'|'connecting'|'connected'|'auth_required'|'unavailable', account: {name,userId}|null, expiresAt:number|null, expirySource:'token'|'unknown', lastCheckedAt:number|null, errorCode:string|null, automaticRefreshSupported:false, crossDeviceAuthorizationSupported:false }`。

`settings`：`{outputRoot,department,reason,notificationsEnabled}`。

任务输出沿用脱敏摘要，增加 `created_at/updated_at/approval_wait_started_at/approval_deadline_at/media_wait_started_at/media_deadline_at/output_root/department/reason`，不返回原始远端对象或下载 URL。

## 验证与边界

先以本地 fixture 验证跨重启队列、跨 30 分钟运行、双循环互斥、SSO失效/晚到回调、同用户恢复、审批/制作分别超时、通知去重和失败恢复；HTTP 测试覆盖远端 Host/Origin 和写请求标识。组件测试验证用户操作与错误状态。执行根 `npm test`，本机隔离测试服务进行桌面/窄屏 UI 验收。更新 README 和下载文档，代码评审通过后交付本地改动，不合并或发布。
