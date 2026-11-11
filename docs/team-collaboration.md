# 飞行指挥游戏小组协作流程

自 2026 年 11 月 11 日起，所有项目协作统一使用 **GitHub＋本机同步程序**。任务与讨论放在 Issues，代码评审放在 Pull Requests，流程与项目说明放在仓库 docs。成员在各自电脑运行游戏，本阶段不购买云服务器或域名。

GitHub 已接通，源码已首次上传，本机同步工具已提供。各成员在自己的电脑初始化并开启；程序把已保存的修改上传到独立个人备份分支，正式任务仍按评审流程合并。

项目方向、总路线、换引擎前的短期计划与分工见 [ROADMAP.md](ROADMAP.md)。新增第三方代码、数据或素材时记录来源、版本与许可；不要把 AGPL/GPL 内容混入声明为 MIT 的部分，详见 [LICENSE-RISKS.md](LICENSE-RISKS.md)。

## 常用入口

- [任务与讨论 Issues](https://github.com/ludeng1966/flight-command-game/issues)
- [源码仓库](https://github.com/ludeng1966/flight-command-game)
- [代码修改与评审](https://github.com/ludeng1966/flight-command-game/pulls)
- [运行和本机配置说明](../server/README.md)

## 小组分工

仓库维护人目前为 `ludeng1966`，负责邀请成员和合并修改。每项任务指定一名负责人；涉及游戏行为的修改，请另一名组员看过再合并。评审人可以轮换，小范围改错字、补说明可由维护人检查后直接提交。

每位成员使用自己的 GitHub 账号和本地工作目录，所有任务决定记录在相关 Issue 或 PR 中。仓库当前公开；写入仍须接受协作者邀请。

仓库属于 ludeng1966 的个人账号，目前仅所有者有管理员权限，协作者为读写权限。beacon-of-science 和 liyixin1023 已加入；XY0xiaoyu 和 cyberwalker0419 已收到读写邀请，接受后生效。若需要多人管理员，需另行迁移到 GitHub 组织仓库。

## 成员第一次加入

1. 把 GitHub 用户名交给维护人，由维护人邀请加入仓库，并接受邀请。
2. 在 GitHub 阅读本流程，并在 Issues 中确认自己的任务。
3. 在自己的电脑克隆仓库，按运行说明准备 Node、依赖和本机配置。
4. 用一个小任务完成一次“修改、推送、评审、合并”，再开始较大的工作。

```sh
git clone https://github.com/ludeng1966/flight-command-game.git
cd flight-command-game
```

新克隆目录的项目远端名为 `origin`。维护人当前的 `F:\mygame\wt_repo_research\WTACRP` 使用 `private` 指向小组仓库，原 `origin` 保留为上游来源。在这个已有目录运行下文命令时，把项目远端 `origin` 换成 `private`。

## 每项任务怎么做

**GitHub Issues 里领任务 → 建个人任务分支 → 本机修改与同步 → 提交合并请求 → 组员检查 → 合并到 main。**

开始前在 Issue 写清四件事：要做什么、谁负责、主要改哪些文件、怎样算完成。状态只用“待做、进行中、待评审、已合并”。同时改同一模块时，先在 Issue 评论中说明各自负责的文件。

本地工作区没有未提交修改时，更新 `main`，再为本次任务建立分支：

```sh
git switch main
git pull --ff-only origin main
git switch -c work/昵称/任务名
```

把“昵称”和“任务名”换成自己的短名称。一个分支对应一项任务；多人各用自己的分支。当前目录已有未提交修改时，先整理到对应任务分支，再切换或更新 `main`。

正式任务使用手动提交和推送。先检查差异，再只添加本任务的文件：

```sh
git status --short
git diff
git add 具体文件路径
git commit -m "说明本次改动"
git push -u origin HEAD
```

如果 `git diff` 没有显示某个新文件，单独打开该文件检查后再添加。提交说明写具体变化，例如“修正机场排队顺序”。临时备份可用 `WIP: 机场排队调整`。

## 本机同步程序的工作规则

程序入口为 `tools/local-sync.mjs`，配置与日志保存在本机 Git 目录内，不进入源码仓库。维护人电脑使用 `private` 远端；新克隆的目录使用 `origin`。每位成员首次设置时，在项目目录运行下面的命令，并把用户名换成自己的 GitHub 用户名：

```powershell
git credential-manager github login --username 你的用户名 --browser
powershell -NoProfile -ExecutionPolicy Bypass -File .\sync_project.ps1 -Action Init -Member 你的用户名 -Remote origin
powershell -NoProfile -ExecutionPolicy Bypass -File .\sync_project.ps1 -Action Once
```

初始化会确认当时已有的源代码目录和根目录文件。此后双击 `start_sync.cmd` 开始、`sync_status.cmd` 查看状态、`stop_sync.cmd` 停止。工具需要本机 Node 和 Git；首次推送时先完成自己的 GitHub 登录。同步不会设置开机自启动，关机后下次需重新开启。

| 项目 | 约定 |
| --- | --- |
| 启停 | 成员主动开启或暂停；开始时显示仓库、分支和同步文件范围 |
| 上传范围 | 处理初始化时确认过的源代码目录和根文件；新增根目录或根文件显示为待确认路径 |
| 上传节奏 | 每5秒检查一次，文件停止编辑至少30秒后，把本轮修改批量保存为 WIP 快照并推送；网络耗时另计 |
| 上传位置 | 独立的 `work/用户名/live-sync` 个人备份分支；当前工作分支和暂存区保持原状，不自动提交或推送 main |
| 获取其他人的修改 | 同步时检查备份分支远端版本；检测到其他写入则暂停；不自动合并或覆盖正在编辑的文件 |
| 网络中断 | 本地提交保留，恢复联网后重试推送 |
| 推送被拒绝 | 暂停并提示检查远端变化；不强制覆盖 |
| 状态 | 显示最后成功时间、提交编号、待上传数量及错误；网络失败不显示为已同步 |

每次自动提交前检查忽略规则和疑似密钥。`.env`、模型文件、运行日志、缓存及原始回放不进入同步；`.env.example` 只放配置示例。已经被 Git 跟踪的文件不会因为新增忽略规则自动退出版本管理，需要另行处理。

个人备份分支用于实时查看进展与讨论，可以监视当前 main 或任务分支的工作目录；程序通过独立索引保存快照，不把工作目录切到备份分支。正式任务仍从各自任务分支发起 PR，避免把备份分支里混合的多个任务直接合入 main。不要在运行同步时检出个人备份分支。

如果状态显示新增根路径待确认，检查内容后再加入同步范围，例如：

```sh
node tools/local-sync.mjs approve --path 新目录
```

网络失败时最多每30秒重试一轮，已保存的本地快照不会丢失。程序不执行 pull、强制推送、切换分支或覆盖工作文件；遇到冲突先停止同步，再由本人检查处理。单文件超过50 MiB或整个快照超过200 MiB时暂停，先检查是否混入原始资源或需要单独存放的大文件。

这个节奏用于备份和分享已保存的代码，不提供逐字共同编辑。成员看到新修改后，可以从 GitHub 查看差异并讨论。电脑关闭后本机同步和预览暂停，已经推送到 GitHub 的代码与评审记录仍可访问。

## 评审和合并

任务准备好后，从自己的任务分支向 `main` 发起 Pull Request，并在 PR 中用 Closes #议题编号 关联对应 Issue。描述用下面四行即可：

```text
改了什么：
对应任务：
怎样验证：
需要组员重点看什么：
```

涉及程序行为时，先运行本次修改对应的测试；跨多个模块时再运行完整测试。界面修改附一张截图或简短操作步骤。未完成的验证明确写出来。现有 CI 主要检查原播放器，不能替代新增游戏模块的测试。

```sh
node --test tests/相关模块.test.mjs
# 需要完整回归时：
node --test tests/*.test.mjs
```

由另一名组员查看差异和验证结果，代码问题直接在 PR 对应位置评论；Issue 和 PR 中记录任务决定和最终结果。维护人确认后使用 **Squash and merge**，把 WIP 提交整理成一次任务提交。先保留任务分支，后续统一清理。这里的一人评审是小组约定，本次没有配置付费保护规则或自动审批。

合并完成后，各成员在工作区干净时更新 `main`，后续任务从新的 `main` 建分支。已经 squash 合并的旧任务分支不继续用于下一个任务。

## 冲突和恢复

遇到合并冲突，先把当前工作保存到自己的任务分支，再获取远端变化，结合双方差异逐处处理；不确定时找相关文件的另一位修改者一起确认。解决后重新验证，再继续评审。

共享分支不使用强制推送或重写历史。需要撤回已经合并的修改时，新增 revert 提交并按同样流程评审；不要直接把 `main` 重置到旧版本。本机同步程序遇到冲突只报告并暂停。

## 本机查看游戏

各成员按运行说明配置自己的 `.env`、模型和语音服务，再启动 `start_game.cmd`，在本机浏览器查看游戏。密钥各自在本机填写。

`http://127.0.0.1:8000/game/` 指向访问者自己的电脑，不能把这个地址当成组员可访问的预览链接。组内交流用截图、录屏或屏幕共享；这套协作流程不包含全天在线预览或多人同一局游戏。

## 当前完成情况

- [x] 建立 GitHub 仓库并完成源码上传；当前可见性为公开。
- [x] 维护人账号和本机 Git 已连接。
- [x] 确定小组协作流程与本机同步规则。
- [x] 已邀请四名组员加入 GitHub 仓库；新成员需自行接受邀请。
- [x] 提供本机同步工具、启停入口和状态日志；每位成员分别初始化并开启。
- [ ] 由第二名成员完成一次任务、评审、合并和本机运行。

后续以 GitHub 仓库内这份文档为准，所有任务、讨论、评审与流程更新都在 GitHub 完成。

## 参考

- [GitHub 合并请求说明](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)
- [Git 忽略规则](https://git-scm.com/docs/gitignore)
