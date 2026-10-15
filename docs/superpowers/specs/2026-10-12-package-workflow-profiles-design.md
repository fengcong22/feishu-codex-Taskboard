# 按剪辑包保存流程配置

用户已确认继续完成“每个包独立配置、切换恢复、草稿与生效版本分离”。本轮完善旧 ZIP 包与现有 VM 草稿的配置管理，不开发 VM 剪辑执行器。

## 行为与数据

- 配置身份为学科、包别名、模板 ID、模板版本。ZIP 与 VM 表单沿用现有内置模板，未知模板拒绝。
- ZIP 草稿使用现有独立包草稿表，配置为可编辑的 subject 字段（trigger/title/execution/packageRoute/upload/statusField/reviewStatusField/documentField/namingField/stages/delivery），不接受 subject 身份、metadata、生命周期、版本或凭据。包路由必须与路径指定别名一致。
- 新包没有历史配置时生成保守默认值，不复制另一包的目录、回写和执行模式。旧学科配置从该包最近的历史快照恢复；不要求重填，不改历史版本。旧 API 保存、导入和字段刷新产生的草稿也更新对应档案，避免新旧入口互相覆盖而不知情。
- 草稿有独立 revision，保存不调用 Bridge、不改变当前生效快照。切换包只选编辑对象；浏览任意草稿均不会替换活动流程。
- 启用指定已保存 ZIP 草稿同时检查 profile revision 和学科 configVersion；使用学科全局下一个版本，并按现有字段、包白名单、manifest、上传条件及 Bridge 同步规则验证。同步失败回滚本机变更并保留旧活动配置。VM 继续 preview-only。
- 已有 subject PATCH/enable/disable API 保持兼容；活动快照、任务冻结版本和包删除占用规则保持。普通草稿不新增包删除阻断，删除后的档案保留但不可使用，重建别名仍按实际 manifest 校验。
- UI 分别显示编辑包/草稿 revision 与当前生效包/配置版本。按完整身份缓存未保存修改和音频辅助状态，切包可恢复，配置内切换学科保持配置页。离开/刷新提示未保存修改；冲突与读取失败保留输入并阻止误启用。
- 共享导出仍沿用现有可移植学科配置，不导出本机包档案及目录；不扩大共享协议。

## 接口

现有 GET/PUT `/api/local/feishu/subjects/:subjectKey/package-workflow-drafts/:alias` 扩展支持 ZIP。响应 `{subjectKey,packageAlias,workflowTemplate,revision,config,updatedAt}`；PUT `{expectedRevision,config}`。ZIP config 仅上述可编辑字段；VM 形状保持。

新增 POST 同路径 `/enable`，输入 `{expectedRevision,expectedVersion}`，返回 `{subject}`。读取活动信息通过 subject 响应新增 `activePackageAlias`，配合已有 `activeConfigVersion`。本机路由沿用现有 Host/Origin/loopback 限制。

## 验证

使用离线 fixture 验证两个 ZIP 包和跨学科隔离、ZIP/VM 切换、重启恢复、历史迁移、草稿不改活动、revision 冲突、启用全局版本单调、Bridge 失败回滚、元数据失效、未保存保护及迟到响应。不得发送生产事件、修改真实 registry 或启用生产工作流。保留当前未提交工作，适当测试和独立代码评审后交付源码。
