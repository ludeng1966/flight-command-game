# 项目提示词

本文件是给 Claude Code 等 AI 开发助手的项目级上下文。工作约定见 `AGENTS.md`，团队协作流程见 `docs/team-collaboration.md`。

## 这是什么仓库

仓库的主线是 AI 空战指挥游戏；WTACRP 回放查看器仅作代码参考，不纳入产品方向。

1. **AI 空战指挥游戏**（`/game/`）：Node.js 本地服务加浏览器前端。玩家用文字或语音下口令，云端指挥官模型理解意图，程序飞行员规划航路，同一气动内核预演、校验并执行；含三关教学、机场运行、雷达/导弹/告警与自动存档。
2. **WTACRP 回放查看器（仅代码参考）**（根 `index.html` 与 `/web/`）：纯静态，浏览器内解析 `.wrpl`，把航迹、击杀、地面单位与地形渲染成 3D 复盘。根入口是预生成演示，`/web/` 是拖拽工具页；保留用于回放解析与渲染参考。

两者共用 `three3d/` 和仓库根入口，但运行时互不依赖：回放参考实现不需要 Node 服务；游戏页不能只靠静态服务器打开，否则 `/api/*` 全部失败，指挥、语音和教学示范都不可用。

当前方向是**以态势研判和兵力调度为核心的多单位实时战术指挥游戏**：先在现有原型上做好基本玩法，再移植到 Godot 继续开发交互、玩法与 PVE 关卡。总路线、短期计划与分工见 `docs/ROADMAP.md`，涉及玩法取舍时先对照该文档。

## 目录

| 路径 | 内容 |
| --- | --- |
| `game/` | 游戏前端：指挥台、通联、教学、存档、机场与武器界面 |
| `sim/` | 仿真核心：任务、飞控、物理、机场、传感器、武器、命令协议 |
| `server/` | Node.js 本地服务：云端模型与语音接口、AI 飞行员 |
| `tests/` | 自动化回归（58 个测试文件） |
| `three3d/` | Three.js 回放渲染器（参考实现） |
| `web/` | 浏览器内 `.wrpl` 解析与工具页（参考实现） |
| `tools/` | 回放解码、地形打包、站点构建 |
| `data/` `terrain/` `tables/` `vendor/` | 游戏数据、地形素材、名称表、第三方库 |
| `docs/` | 设计文档、回放格式、验证与协作说明 |
| 根入口 | `index.html`/`mission.js`（回放演示，参考实现）、`start_game.cmd`/`.ps1`（游戏启动） |

## 运行与验证

- 游戏要求 Node.js 22.12+，无 npm 依赖：`node server/game-server.mjs`，默认监听 `127.0.0.1:8000`；也可双击 `start_game.cmd` 或运行 `.\start_game.ps1`。
- 首次启动前把 `.env.example` 复制为 `.env` 并填写密钥；`.env` 已被 Git 忽略。云端模型需要 `DASHSCOPE_API_KEY`，Inworld 语音需要 `INWORLD_API_KEY`，两者都未配置时物理与手动航路仍可玩。
- `AI_PROVIDER` 固定 `cloud`；本地模型实验已停用，`2B` 飞行员标记为不可用且不提供下载。
- 回放参考实现只需静态服务：`python -m http.server 8080`，打开 `/` 或 `/web/`。
- 回归：`node --test tests/*.test.mjs`（约 50 秒）。测试及其产物写到被忽略的 `.game-server/`，目录不存在时先运行：

```bash
node -e "require('node:fs').mkdirSync('.game-server',{recursive:true})"
```

## 架构不变量

- 模型只提案，程序裁定：模型输出严格 JSON Schema，`sim/orders.js` 逐字段校验，`sim/world.js` 用同一物理内核试飞候选航路；任何一项不通过则整批拒绝。
- 计划整批原子提交；执行中被下层拒绝则整体回滚。连续控制不依赖逐帧模型调用，模型只在指令、起飞方案、事件判断和结果检查时介入。
- 能力表必须诚实：未接入的执行器返回 `capability_unavailable`，界面显示“待接入”，不得假装执行。
- 物理状态始终使用 SI 单位；界面单位可切换。AI 与程序之间以 SI 交换数据。
- 回放数据只来自 `.wrpl` 本身；解不出的字段留空，不编造、不用开发期抓包数据补。

## 文档地图

- `README.md`：仓库总览（游戏主线 + WTACRP 参考实现）；`README.en.md`：英文版。
- `docs/ROADMAP.md`：项目定位、总路线、换引擎前短期计划、里程碑与分工。
- `AGENTS.md`：AI 开发约定；`docs/team-collaboration.md`：分支、PR、测试流程。
- `game/README.md`：游戏交互细节；`server/README.md`：服务配置、API 与 AI 链路。
- `CONTRACT.md`、`docs/REPLAY-*.md`、`docs/DATA-NOTES.md`、`docs/VERIFY.md`：回放格式、解码与验收（参考实现）。
- `docs/LICENSE-RISKS.md`：许可与合规风险清单；涉及第三方代码、数据、素材或对外发布时先读。
- `docs/` 其余文件：雷达、导弹、编队、教学、告警等设计说明。

## 已知工程缺口

- `.github/workflows/ci.yml` 只做 Python/JS 语法检查和回放数据解析，**不运行** `node --test`；它用 Node 20，与文档要求的 22.12+ 不一致。提交前需在本机跑完整回归。
- 仓库没有 `package.json`，启动和测试都直接调用 `node`。
- 本 checkout 通常没有 `.env`，真实云端模型、语音转写和 TTS 未配置，只能靠测试里的模拟上游验证。
- 参考实现的回放地面阵营取 ECS 的 `team` 组件；只有船或没有构造块的单位保持 `unknown`，不按位置猜。

## 工作约定

- 开始前检查目录、分支和未提交改动，保留用户已有工作；按任务开分支，完成后通过 PR 合回 `main`。
- 修改共享命令协议、世界状态或事件结构前，先说明受影响模块与接口。
- 实现后报告行为变化、验证结果和剩余问题；提交只包含本次任务需要的文件。
- 不提交 `.env`、凭据和运行日志；验证配置时只报告是否配置，不输出密钥。
- 新增第三方代码、数据或素材时记录来源、版本与许可；AGPL/GPL 内容不得混入声明为 MIT 的部分。许可风险与处置见 `docs/LICENSE-RISKS.md`。
