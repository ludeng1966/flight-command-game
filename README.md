# FLIGHT COMMAND — AI 空战指挥模拟器

本项目的主线是 AI 空战指挥游戏（`/game/`）。仓库同时保留 WTACRP 回放查看器（根 `index.html` 与 `/web/`）作为代码参考，不纳入产品主线。

项目协作统一使用 GitHub：[协作与自动同步流程](docs/team-collaboration.md) · [任务与讨论](https://github.com/ludeng1966/flight-command-game/issues) · [代码评审](https://github.com/ludeng1966/flight-command-game/pulls)。

- **AI 空战指挥游戏**（`/game/`）：本机 Node.js 服务加浏览器前端。玩家用文字或语音下令，AI 指挥官理解意图，程序飞行员规划航路，同一气动内核预演、校验并执行。
- **WTACRP 回放查看器（仅代码参考）**（根 `index.html` 与 `/web/`）：纯静态，浏览器内解析 `.wrpl`，把航迹、击杀、地面单位与地形渲染成极简 3D 复盘；保留用于回放解析与渲染参考，不作为当前产品方向。

[English](README.en.md) · [游戏交互](game/README.md) · [服务与 AI](server/README.md) · [协作流程](docs/team-collaboration.md) · [回放格式](docs/REPLAY-FORMAT.md) · [解码](docs/REPLAY-DECODE.md) · [数据说明](docs/DATA-NOTES.md)

## 入口一览

| 入口 | 用途 | 运行方式 |
|---|---|---|
| `/game/` | 指挥游戏主入口 | Node 服务 |
| `/game/training.html` | 三关逐步指挥教学 | Node 服务 |
| `/game/flight-data.html` | 飞行与导弹数据页 | Node 服务 |
| `/` | 回放演示页（仅代码参考）：一局预生成的示例数据（`mission-data.js`），打开即看 | 静态服务 |
| `/web/` | WRPL 工具页（仅代码参考）：拖入任意 `.wrpl`，浏览器内解析后播放 | 静态服务 |

游戏页不能只靠静态服务器打开：飞行画面会显示，但 `/api/*` 全部失败，指挥、语音转写和教学示范都不可用。

## 路线与分工

当前方向是把游戏做成**以态势研判和兵力调度为核心的多单位实时战术指挥游戏**：玩家在指挥部决定谁去哪里、守哪一侧、什么时候增援或撤回，具体飞行由程序飞行员完成。先把基本玩法在现有原型上做好，再把代码移植到 Godot，继续开发交互、玩法与 PVE 关卡。

完整方向、总路线、换引擎前的短期计划、里程碑与分工见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 快速开始

### 1. 指挥游戏

需要 Node.js 22.12+，没有 npm 依赖。在仓库根目录双击 `start_game.cmd`，或运行：

```powershell
.\start_game.ps1
```

也可以直接启动服务，默认监听 `127.0.0.1:8000`：

```bash
node server/game-server.mjs
```

打开 http://127.0.0.1:8000/game/ 。首次使用启动器会把 `.env.example` 复制为 `.env`，填写百炼 `DASHSCOPE_API_KEY` 后执行 `.\start_game.ps1 -Restart`。直接运行 `node` 时需自行复制 `.env.example`。

`.env` 中的关键配置：

| 变量 | 作用 |
|---|---|
| `DASHSCOPE_API_KEY` | 云端指挥官与语音识别 |
| `AI_PROVIDER` | 固定 `cloud`；本地模型模式已停用 |
| `QWEN_COMMAND_MODEL` / `QWEN_ASR_MODEL` | 指令模型与识别模型，默认 `qwen3.7-flash` / `qwen3-asr-flash` |
| `INWORLD_API_KEY` | Inworld TTS-2 Flash 通联语音 |
| `TTS_PROVIDER` | 需要浏览器本地播报时设为 `browser` |
| `GAME_PORT` | 服务端口，默认 8000 |

没有密钥时游戏仍可运行：物理、手动航路和界面都正常，指挥电台会明确提示需要配置。密钥只保存在服务端；服务只监听本机地址，并校验 Host/Origin。

### 2. 教学与飞行数据

服务启动后打开：

- http://127.0.0.1:8000/game/training.html — 零基础逐步教学
- http://127.0.0.1:8000/game/flight-data.html — 飞行与导弹数据页

### 3. WTACRP 参考实现（仅代码参考）

参考实现是纯静态站点，不需要构建就能在本地看两个页面：

```bash
python -m http.server 8000
# 打开 http://localhost:8000/          演示页（预生成数据）
# 打开 http://localhost:8000/web/      工具页（拖入 .wrpl）
```

若游戏服务已经占用 8000，改用 `python -m http.server 8080`，地址相应改成 8080。

参考工具页可部署到 GitHub Pages；演示页与预生成数据留在仓库里供本地对照和回归。

完整的全地图地形（163 张等高线 + 掩膜，约 100 MB）来自 [WT-MAP-ANALYZE](https://github.com/ShioUmiusi/WT-MAP-ANALYZE) 的数据集，构建时打包：

```bash
python tools/pack_terrain.py --data ../WT-MAP-ANALYZE --out dist/terrain
```

仓库里只保留演示地图的样例。本地想看完整地形（163 图），把 WT-MAP-ANALYZE 的数据目录指给页面：

```js
window.ACE_TERRAIN_BASE = '/path/to/dataset/contours/';
window.ACE_MASK_BASE    = '/path/to/dataset/landmask/';
```

也可以用 `tools/pack_terrain.py` 打包到 `dist/terrain` 后从 `dist/` 起服务；其它地图缺素材时地形层留空并在 `limits` 里说明。

## 指挥游戏：模型提议，程序裁定

玩家是指挥权的唯一来源。一次下令的链路是：

1. 玩家在指挥电台输入文字或按住 V 说话；
2. 指挥官模型把原话解析成结构化命令；
3. 程序校验对象、参数、单位、范围与地形可行性；
4. 飞行员规划航路，同一物理内核试飞候选，拒绝失速、净空不足或飞出地形的方案；
5. 装订后由 10 Hz 飞控和 60 Hz 物理积分连续执行，不逐帧调用模型；
6. 结果检查模型复述实际装订值与执行状态，程序核对后才播报。

模型输出严格 JSON Schema，`sim/orders.js` 逐字段校验，`sim/world.js` 用同一气动内核试飞候选航路，任何一项不通过则整批拒绝。计划整批原子提交，执行中被下层拒绝则整体回滚。连续飞行、地形碰撞、机场运行和武器弹道都由程序裁定，模型只负责理解、提案和事后检查。

军事口令覆盖 58 类意图。导航、航向、速度、高度、编队、掩护、机场滑行/起飞/进近/着陆、通信失效和雷达告警等已有执行器；高级协同、部分武器与条件调度明确标记为“待接入”，界面不会假装执行。

机场为海湾国际机场 BAY：双平行 3600×45 米跑道、滑行道、六个机位、航站楼与灯光标线；支持滑行、跑道外等待、对正、起飞、中断、进近、着陆、复飞和回机位。空中有雷达搜索与跟踪、AIM-120/AIM-7/AIM-9 系列导弹与 RWR 告警自卫。两架 F-16A Block 10 默认停在 G1/G2 机位。

教学为 3 个可独立进入、反复练习的大关卡，共 52 个短步骤：呼号与地面通联、机位与离场、航向/靶眼/TACAN 几何与返场。教学与普通游戏共用同一套 AI 指挥链路，不用关键词解析器。

存档保存世界状态、训练进度和界面状态；存档不兼容时保留原档并阻止继续，不会静默覆盖。

## WTACRP 参考实现（仅代码参考）

回放部分原名 **WTACRP — 战争雷霆回放 → Ace Combat 风格 3D 播放器**，现仅作为回放解析与渲染的代码参考保留，不纳入产品主线。

把《战争雷霆》的 `.wrpl` 回放变成一段可拖动的极简 3D 演出：航迹、击杀、地面单位、地形等高线与陆水掩膜、可切换机位与播放控制。解析全部在浏览器内完成，页面本身不发任何网络请求。

两页复用同一套渲染与播放（`three3d/scene.js`、`mission.js`、`ace.css`、`mission.css`）。工具页解析完成后通过 `window.ACEUI.mount()` 换数据，保留用户的显示设置。

### 特性

- 三维航迹（本机 / 小队 / 友军 / 敌军分色），按航向的机型图标与地面单位方块；
- 击杀落点常驻标记与扩散环，底部进度条带击杀刻度，支持 seek 与 1/2/4/8 倍速；
- 地形层：等高线与陆水掩膜按地图名加载，缺失时整层留空而不是编造；
- 地面单位会移动：`ptype=4` 的 MPI `0xF073`（服务器 `0xF074`）批量位置同步，1 Hz 阶梯保持；按构造块里的 uid 绑定型号，阵营取 ECS 的 `team` 组件（1=蓝/2=红）；
- 标签（型号 / 类别）、机位切换、网格、航迹开关、全屏、帮助；
- 呼号可自定义，队友按回放里实际小队绑定；玩家名/队伍从 slot 包精确解出（`unit__playerId`），队友 uid 直接绑定；
- 被击毁/销毁的单位按 ECS 销毁包（`0x26`）结束航迹，不再飞到回放结束；
- 机场跑道：地形素材没带机场时用机场目录（67 图 / 256 任务，由 wrpl-acmi 数据整理）兜底，按回放实际生成的 marker 选 rank 变体。
- 导弹弹道：`ptype=4` 的 WeaponSync（`0xF0DB` / `0xF11A`）真实同步位置，弹体不画，用白色虚线表示已飞过的航迹；设置面板可关。
- 本机与队友呼号下方可显示机体型号（设置面板“呼号下型号”开关）。

## 数据从哪来

回放的位置与事件全部来自回放本身：`ptype=2` 的 FlightModel 三维航迹、`ptype=4` 的击杀包与地面同步、`ptype=6` 的 ECS 地面/机场标记点与 team，以及结算 BLK 的玩家表。仍旧读不出的字段（小队归属等）用回放内部证据推断，推断项在 `?` 帮助与 `docs/DATA-NOTES.md` 里写明。

示例数据已匿名化：玩家名、账号 ID、战队标签均为合成值，`ALPHA 01`…`ALPHA 32`。

解码与生成（Python，依赖见 `requirements.txt`）：

```bash
python tools/wrpl_header.py  --replay <replay.wrpl> --out-dir build/wrpl
python tools/wrpl_decode.py  --help      # 航迹
python tools/wrpl_decode_ecs.py --help   # ECS（地面、机场、发射点）
python tools/wrpl_kill_events.py --help  # 击杀
python tools/build_ace_mission.py --help # 汇总成 mission-data.js
python tools/check_ace_mission.py --help # 交叉校验
```

各脚本的参数与产物路径见 `docs/REPLAY-DECODE.md`、`docs/REPLAY-DECODE-ECS.md`、`docs/QUICK-REF.md`。

## 目录

```
game/                                    游戏前端（指挥台、教学、通联、存档）
sim/                                     仿真核心（任务、飞控、物理、机场、传感器、武器）
server/                                  Node 本地服务、模型与语音接口
tests/                                   自动化回归（58 个测试文件）
index.html  mission.js  mission.css  ace.css  scene3d3-loader.js   回放演示页
mission-data.js  attitude-data.js        演示数据
three3d/scene.js                         渲染器（ES module）
web/                                     浏览器内解析（含 fzstd）
vendor/three/                            three.js r186
tables/                                  载具显示名与类别
terrain/                                 示例地图的等高线 / 掩膜
data/                                    游戏数据
tools/                                   解码、生成、打包脚本
docs/                                    回放格式、解码、验证与数据说明；另含游戏设计文档
```

## 测试与 CI

```bash
node -e "require('node:fs').mkdirSync('.game-server',{recursive:true})"
node --test tests/*.test.mjs
```

58 个测试文件、461 项测试，约 50 秒跑完，覆盖物理、飞控、机场、传感器、武器、命令校验、AI 链路（模拟上游）、存档和回放解码。测试产物写入被 Git 忽略的 `.game-server/`。

需要知道的缺口：`.github/workflows/ci.yml` 只做 Python/JS 语法检查和回放示例数据解析，**不运行** `node --test`，并且使用 Node 20，与文档要求的 22.12+ 不一致。`pages.yml` 只在 `main` 上构建并部署工具页到 GitHub Pages。也就是说，461 项回归目前依赖提交前在本机手动运行。

## 已知问题

- **CI 覆盖不足**：见上节；共享功能改动必须在本地跑完整回归。
- **没有 `package.json`**：启动与测试直接调用 `node`，没有统一的脚本入口和依赖声明。这是有意的零依赖设计，但也意味着工具链需要手工约束。
- **AI 链路默认未配置**：本 checkout 没有 `.env`，云端模型、语音识别和 TTS 都未启用；真实模型调用未验证，回归使用模拟上游。
- **2B 飞行员不可下载**：产品固定使用云端 Flash；2B 选项标记为不可用（`sim/pilot-models.js` 的 `available:false`），界面提示“下载暂未提供”。本地模型实验已停用。
- **阵营标识**：空中用击杀关系二色 + 出生位置聚类；地面用 ECS 的 `team` 组件（与上游 wrpl-acmi 对拍 6 份回放 715 个地面单位，0 分歧）。只有船/没有构造块的单位拿不到 team，保持 `unknown`，不按位置猜。
- **空中阵营方向未能独立闭合**：开发期用外部抓包颜色族只能确认“未猜补、极性自洽”，无法给出绝对真值；详见 `docs/VERIFY.md` 与 `docs/DATA-NOTES.md` 的说明。

## 构建与部署

`tools/build_site.py` 把参考工具页与完整地形打包到 `dist/`（演示页不部署），`.github/workflows/pages.yml` 在 `main` 分支构建并部署到 GitHub Pages；`ci.yml` 做语法检查与示例数据解析检查（详见“测试与 CI”）。这条部署链只服务参考实现，不属于游戏产品主线。绑定自定义域名时在仓库 Pages 设置里填，并先配好 DNS。

## 许可与来源

> **许可证风险提示**：仓库根 `LICENSE` 是 MIT，但回放解码部分参考/移植了 AGPL-3.0 项目，机场目录 `terrain/airfields.json` 自身也标注 AGPL-3.0，与 MIT 声明存在冲突。公开发布或商业化前必须先处理，详见 [docs/LICENSE-RISKS.md](docs/LICENSE-RISKS.md)。

- 根 [LICENSE](LICENSE) 为 MIT；但回放解码的衍生性尚未判定，机场目录为 AGPL-3.0 派生数据，不能把整个仓库视为 MIT，见风险清单；
- three.js（MIT）与 fzstd（MIT）见 `THIRD-PARTY-NOTICES.md`；
- 回放、地形与载具名数据均由玩家本机文件派生；《战争雷霆》及其素材版权归 Gaijin Entertainment，本项目与 Gaijin 无关；
- 仓库不包含游戏原始资源（`.wrpl`、关卡、贴图、模型）。
