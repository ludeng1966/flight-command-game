# 两人协作与本地开发

## 初次准备

每人保留自己的本地克隆。Node.js 要求22.12+；游戏服务无额外npm依赖。用VS Code打开仓库根目录。

GitHub仓库所有者邀请另一人作为协作者，对方接受后才有共享仓库写入权限。在VS Code的GitHub Pull Requests视图登录GitHub；浏览器授权需要由账号本人完成。

复制 `.env.example` 为 `.env`，配置自己的服务凭据。这个文件已被Git忽略，不能提交。日常拉取源码不需要重新克隆或重建配置。

## 启动与测试

- VS Code按F5，选择“游戏服务（8001）”，访问 http://127.0.0.1:8001/game/ 。停止调试会停止对应服务。使用8001以避开已有8000试玩服务。
- 教学入口：http://127.0.0.1:8001/game/training.html 。模型权限仍需实际调用验证。
- 菜单“终端 → 运行任务 → 游戏：运行自动化测试”运行回归。
- 终端直接运行服务：`node server/game-server.mjs`，默认8000；运行回归前执行 `node -e "require('node:fs').mkdirSync('.game-server',{recursive:true})"` 准备本地输出目录，再运行 `node --test tests/*.test.mjs`。VS Code测试任务会自动准备目录。
- 修改服务端代码或 `.env` 后重启对应服务；前端改动通常刷新页面即可。测试使用模拟上游，不以健康检查代替真实模型验证。

## 每个任务的流程

在工作区干净时，从最新主分支开始：

```bash
git switch main
git pull --ff-only
git switch -c feat/your-task
```

分支按任务创建，例如 `feat/mission-01`、`fix/radar-feedback`、`docs/project-notes`。不要求先固定人员分工。动手前同步本次范围和可能改动的公共接口。

让AI实现并验证后，用VS Code源代码管理检查差异，只暂存本次任务文件，写清提交说明。然后推送当前分支，创建以 `main` 为目标的PR。另一人检查说明、验证结果和实际行为后合并。

没有远程分支时首次推送：

```bash
git push -u origin HEAD
```

PR合并后，确认工作区干净，再切回main并拉取最新代码。正在开发的分支如需主分支更新，可先提交本次工作，再执行 `git fetch origin` 与 `git merge origin/main`；遇到冲突检查双方意图，解决后重新验证。不要用强制推送或硬重置掩盖冲突。

## 本地Git设置

建议仅对当前仓库设置：`pull.ff=only`、`fetch.prune=true`、`push.default=simple`。分支已经分叉时，拉取会停止，先检查状态再决定如何合并。

Git提交姓名和邮箱是提交署名，不等于GitHub登录；能够克隆公开仓库也不等于拥有推送权限。

## 给AI的任务模板

> 在当前仓库的指定功能分支工作。先检查状态，阅读AGENTS.md，说明本次范围和预计影响接口。实现具体行为，运行相关检查，报告手动试玩步骤。只提交本次改动，准备PR供另一人审阅。

任务应包含预期结果和验收方式。世界调度、任务协议与事件格式的改动，由两人协调后确定本次负责人。
