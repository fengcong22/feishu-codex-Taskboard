# Auto-Cut Lite 交接说明（小白版）

这份说明只讲你需要做什么；技术细节都在同目录的
[`auto-cut-lite-interface-requirements.md`](./auto-cut-lite-interface-requirements.md)。

## 这次要交给谁

把两份文件交给**另一台电脑上打开的 Auto-Cut Lite 源码任务**：

1. 本文件：告诉对方如何交付；
2. `auto-cut-lite-interface-requirements.md`：完整接口、需求和验收标准。

不要把当前电脑已经安装的 Auto-Cut Lite 覆盖掉，也不要要求对方直接部署。

## 你只需要复制的提示

先确认另一台电脑打开的是**带 `.git` 的真实 Auto-Cut Lite 源码仓库**，不是名称相似的安装目录。让对方核对并报告 Git remote 仓库地址；如果无法确认，就先停止，不要修改。确认后新建任务，把下面这段话和上面两份 Markdown 文件一起发过去：

> 请先确认当前目录是带 `.git` 的真实 Auto-Cut Lite 源码仓库，而不是安装目录，并报告 Git remote 仓库地址；无法确认时请停止，不要修改。确认后，严格按照 `auto-cut-lite-interface-requirements.md` 实现全部 `REQUIRED` 项，并保留 `CURRENT` 兼容性。请在源码仓库新建独立分支开发、测试和构建候选包；不要安装、覆盖或部署到当前生产电脑。完成后一次性交付：源码分支名、完整 Git commit SHA、是否已推送 GitHub（如已推送则给分支链接，以及按需创建的 PR 链接）、版本化候选包、候选包 SHA-256、中文测试报告和中文交付说明。请把这些文件放在一个版本化交付文件夹中。

## 对方交回来时，你要拿到什么

对方应该交给你一个类似下面的文件夹，而不是只说“已经改好了”：

```text
autocut-lite-delivery-<版本号>/
├─ candidate/<带版本号的候选包>
├─ candidate/<带版本号的候选包>.sha256
├─ test-report.zh-CN.md
└─ delivery-note.zh-CN.md
```

同时要有：

- 源码分支名；
- 完整 Git commit SHA；
- GitHub 分支或 PR 链接（如果已经推送）；
- 明确说明是否还没有推送 GitHub。

## 你拿到后怎么做

不用自己安装或看代码。把对方交回的整个文件夹、源码分支/commit 信息和链接发给我，并说“请验收 Auto-Cut Lite 交付”。我会帮你检查：

1. 候选包的 SHA-256 是否和交付说明一致；
2. 测试报告是否覆盖三阶段、三种音频来源和目录自动编号；
3. 源码 commit 是否能定位到对应修改；
4. 是否缺少必须文件或有不应部署的风险；
5. 通过后，再给你一份很短的部署步骤。

在我明确说“可以部署”前，不要双击候选包，也不要替换当前电脑上的 Auto-Cut Lite。

## Git commit 和 GitHub 是什么关系

- **Git commit**：源码仓库里的一个版本存档，像一个可追溯的“存档编号”。
- **推送到 GitHub**：把这个存档上传到 GitHub 网站，其他人才能通过链接查看或审查。
- 所以，**有 commit 不等于已经上传 GitHub，也不等于已经部署**。

如果对方没有 GitHub 推送权限，也可以先交付本地分支、完整 commit 和候选包；只是后续要由有权限的人先把分支推送到 GitHub，再按需基于该远端分支创建 PR，避免修改只留在那台电脑上。

## 什么时候才部署

顺序固定为：源码修改 → 测试与候选包 → 我帮你验收 → 测试表验证 → 你明确同意 → 安装/部署 → 真实飞书记录验证。

这样当前正在用的 Auto-Cut Lite 不会被直接改坏。
