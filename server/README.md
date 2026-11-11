# Qwen 指挥服务（云端）

## 当前默认：3.7-Flash 指挥官 + 程序飞行 + 结果检查后复述

本机和 .env.example 固定 AI_PROVIDER=cloud。双击 start_game.cmd 启动，Qwen3.7-Flash 理解玩家口令，程序完成气动预演、地形检查、装订和连续控制。每次指令得到程序结果后，POST /api/tactical/pilot/result 唤醒飞行员模型（默认 Flash）检查，再复述关键参数与结果。所有飞机共用一个串行队列，逐机检查。

检查提供明确的指令、实际装订值、当前测量值、时间和任务版本；区分执行中、达到目标、无法执行、装订不一致和只读报告。程序校验单位、数值、对象和结果，不允许把刚装订说成已经到达；失败最多修复一次，仍失败则明确显示检查未完成，飞机继续已装订任务。人工改令、切换单位或重置会使旧复述作废。

检查完成后立即结束本次模型调用。正常航路不持续推理；每秒的轻量事件检查不使用模型，只在新威胁、未检查过的新战术任务或持续航路失败时调用 /api/tactical/pilot/assess。已检查的同一任务不重复唤醒。模型报告和事件建议不会直接改写航点、物理状态或飞控输入。

默认显示km/h、m、km，可切换kt、ft、NM。省略单位的命令按context.unitSystem理解；明确单位优先，API始终使用SI。马赫数是无量纲比值，两套单位均使用M。单位转换由sim/units.js统一实现，界面、航点、通联和结果检查共用。
通联高度按10米/10英尺、速度按整数播报，避免换算小数冗长。客户端先完成指挥员通联，再把实际`speechText`捕获为`commanderMessage`提交给飞行员；任务规划、离场方案、结果检查和持续执行监控均使用该通话，不转交玩家原始输入。通话中的数字由程序解码换算成SI并绑定到模型输出字段，防止090被读成270或重新换算错误。物理状态和未下新令的计划不因格式化改变。详见[指挥员与飞行员接令说明](../docs/commander-pilot-radio.txt)。

GET /api/health 的pilotAssistant显示休眠/加载/结果检查状态、模型调用次数与resultChecks；服务固定使用云端模型，不加载本地模型。

2026-11-07 真实验证：3.7-Flash 在 Edge 浏览器完成英制、公制各一条省略单位的指令；从下令到检查后复述约 12 秒（含云端理解、逐点预览与推理）。这是结果检查与云端链路验证，尚不能证明战术飞行能力改善。

本机记录：.game-server/pilot-result-live.json、.game-server/units-result-browser.json；截图：.game-server/units-result-browser.png。这些目录被Git忽略。

## 飞行员可读文件

航路责任由 `sim/command-planning.js` 统一声明，编译结果的 `execution.planning` 包含每条命令的航路类型、航点提供方、是否要求玩家路线、战术选择责任和缺失信息，界面直接展示。Flash读取 `12_谁来规划航路.txt`。

巡航可直接执行，无现有航路时保持当前航向；有航路时保留各航点高度，不因巡航改为单一高度。标记点带有目标高度，玩家另行明确高度时优先。靶眼导航使用 `mode=bullseye`、`bearingDeg`、`rangeM`，由程序按正北0度、顺时针方位和水平距离换算，模型不计算中间航点。场景可配置 `bullseye: { name: "训练靶眼", position: [eastM, northM, referenceAltitudeM] }`；未配置时请求靶眼基准，不借用本机或地图标记。靶眼坐标通报不触发导航，明确接敌才是接敌意图；现有战术/雷达能力状态继续由执行层检查。

`data/pilot-handbook/` 包括职责、数据、口令、编队、机场、结果检查、统一单位和航路分工说明。新增FAA与ALSSA公开词库的2188条中文简释，并补充47条本游戏易混解释、自动索引全部游戏意图。完整速查在14、15号文件；指挥员及飞行员的任务规划、起飞方案、事件判断、结果复述请求均会附带相关词义。Flash每次最多14条/4200字符，额外片段不触发模型加载。`knowledgeUsed`中的`aviation_terms.termIds`记录实际注入的词条。词库覆盖范围、来源及构建方法见[航空术语说明](../docs/aviation-terms.txt)。

云端指挥官请求会按口令读取相关文件，并在响应的 `knowledgeUsed` 中列出本次加载的文件。默认导航读取职责与数据说明；涉及接敌或军事术语时读取职责、口令和动作说明。文件改动在下一次请求生效。

`GET /api/tactical/handbook` 列出文件；`GET /api/tactical/handbook?id=terms` 读取某份文件。仅支持列表中的文件ID。这里提供的是阅读和术语依据，不表示战术执行器已经实现。
`GET /api/tactical/terms`返回词库数量、版本和来源；加`?q=FOX%20THREE&limit=6`查询相关简释。检索只读本地文件，不调用模型、不占GPU，也不需要新增外部服务。

## 本地模型实验（已停用）

当前产品与文档只支持云端模型。早期本地 2B 实验已停止支持，不再提供安装、配置或基准步骤；相关代码、测试和历史记录保留在仓库中，但不要在新的部署中启用。

历史第三方组件：llama.cpp（MIT）、Qwen3.5-2B（Apache-2.0）、Unsloth GGUF 量化。历史对照数据保存在 `.game-server/local-ai-benchmark.json` 与 `.game-server/hybrid-evaluation.json`，仅用于说明早期实验，不代表当前支持范围。

回归：`node --test tests/*.test.mjs`。

## 云端配置

服务固定使用云端模式，`.env.example` 已设置 `AI_PROVIDER=cloud`，无需修改。以下介绍云端与语音识别配置。

链路：浏览器麦克风 → 单声道 PCM16 WAV → 本地 `/api/voice/transcribe` → `qwen3-asr-flash` → 可编辑识别文字 → `/api/tactical/interpret` → `qwen3.7-flash` → 校验 → 原有 Pilot / Flight。

## 本机配置

需要 Node.js 22.12 或更高版本，无额外 npm 依赖。在仓库根目录双击 `start_game.cmd`，首次启动自动复制 `.env.example` 为 `.env`。在 `.env` 填写：

```dotenv
DASHSCOPE_API_KEY=在本机填写百炼密钥
QWEN_COMMAND_MODEL=qwen3.7-flash
QWEN_ASR_MODEL=qwen3-asr-flash
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

然后执行 `powershell -ExecutionPolicy Bypass -File .\start_game.ps1 -Restart`，刷新游戏 http://127.0.0.1:8000/game/ 。只重启本启动器记录并确认端口归属的游戏服务。

密钥必须有对应模型权限且与所用地域匹配。新加坡地域将 Base URL 改为 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`。
ASR 可以分别设置 `QWEN_ASR_BASE_URL` 和 `QWEN_ASR_API_KEY`，留空则沿用主配置。已有同名环境变量优先于 `.env`。
环境变量 `GAME_PORT` / `.env` 的 `GAME_PORT` 可更换端口；也可以启动时指定 `-Port 8001`。
`QWEN_TIMEOUT_MS` 默认 30000，每次上游调用最多等 30 秒；结构化结果未通过本地校验时最多修复一次。浏览器的转写加解析总等待上限为 95 秒，期间可以取消。

`.env` 和日志目录均已加入 `.gitignore`；本地服务不提供它们的下载，前端不包含密钥。录音只在内存中处理，不写入本地音频文件；录音和指令分别发送至所配置的百炼接口。
本实现仅监听 127.0.0.1，适合本机原型。静态站点托管不提供这两个 API；多人联网版本需要另行实现服务端身份认证和权威模拟。

## 操作

- 先选飞机，再按住 V；首次允许麦克风。松开结束，或者使用“开始录音 / 结束录音”按钮。
- 默认转写后只填入文字，检查后点击“下达指令”或按 Enter 发送；可在设置中主动开启自动下令，文字也可以直接输入。
- 录音最多 20 秒。过短、静音、权限拒绝、没有设备均显示可读提示。
- “取消”会使当前结果失效；即使远端稍后返回也不会执行。本地取消不承诺取消已经发送给云端的计费请求。
- 录音开始绑定所选飞机；之后切换选择不会把同一句话改发给另一架飞机。指令明确点名时以点名为准。
- 手动改高度/速度、变更航路或暂停等操作会更新指令版本，使正在分析的旧结果作废。重置战场也会取消旧指令。
- 飞行任务设置目标值，经气动积分逐渐执行。界面“已执行”表示命令已应用，不代表已经到达目标高度或位置。

## 支持范围

军事口令先解析为 `sim/military-commands.js` 的统一意图协议，再编译为 `sim/orders.js` 的实际飞行命令。完整的58类意图、能力状态及扩展规则见 [军事口令手册](military-commands.md)。界面也提供可展开的口令手册。

| action | 含义 |
| --- | --- |
| set_flight | 设置目标高度和 / 或真空速；指定高度时同步调整现有航点高度 |
| fly_to | 替换或追加三维航点，各航点高度独立 |
| fly_heading | 按指定航向建立三维航路；未给距离时滚动延伸，给定距离时完成后盘旋 |
| orbit | 在当前位置或指定中心盘旋 |
| clear_waypoints | 清除航路并盘旋 |
| report_status | 只读报告本机航向、高度、速度与飞行状态 |
| pause / resume | 暂停 / 继续模拟 |

高度 500–15000 米，真空速 400–2400 千米/小时；API 速度字段统一米/秒。自动驾驶按机型包线和安全路径管理速度、过载及加力。
“保持当前高度 / 速度”使用请求时的测量值，未指定的参数保留现有目标。“向右转 30 度”相对请求时航迹航向计算。
“这里 / 标记点”使用正在预览的空间点或最后确认的空间航点，未提供点时要求澄清。
雷达、武器、编队、战斗、起降和条件调度能够解析为明确意图并记录对象、参数、先后与条件；对应执行器尚未接入时返回 execution.status=capability_unavailable，列出缺失能力。兼容的 plan.status=unsupported、tasks=[]，整批不部分执行。通报使用 informational，澄清与未知口令分别处理。

计划不能直接覆盖坐标、速度或姿态。服务端和客户端都会校验命令、参数、单位与范围；客户端还检查飞机是否仍存活、当前版本及整批航路的地形可行性。
计划超出 120 秒模拟时间即失效；航向任务在分析期间航迹改变超过 30 度也要求重新下令。

## API

- `GET /api/health`：本地服务和模型配置状态；ready 仅表示密钥已配置，不代表已验证云端权限。
- `POST /api/voice/transcribe`：`Content-Type: audio/wav`，请求体是 WAV 字节，返回 `{ "text": "识别文字" }`。限制 4 MiB，接受 0.25–30 秒 PCM16 单声道 WAV（界面限制 0.3–20 秒）。
- `GET /api/tactical/catalog`：版本、58类意图词典和本地能力状态。
- `POST /api/tactical/interpret`：JSON `{ requestId, instruction, context }`。上下文通过 `commandContext(world, selectedId, mapPoint, radioStyle)` 构造，最多 32 架飞机、1000 字指令。返回 `{ requestId, revision, simTimeSec, interpretation, execution, plan }`。

`plan` 格式：

```json
{
  "status": "accepted",
  "summary": "一号机目标高度八千米、真空速六百公里每小时",
  "tasks": [{
    "unitId": "blue-1",
    "action": "set_flight",
    "altitudeM": 8000,
    "speedMps": 166.66666666666666,
    "headingDeg": null,
    "eastM": null,
    "northM": null,
    "distanceM": null,
    "append": false
  }]
}
```

字段必须完整，未使用的数值字段为 null。另两种状态为 `needs_clarification` 与 `unsupported`，此时 `tasks=[]`。
模型使用严格 JSON Schema 输出；若服务或模型不兼容该模式，返回错误，不改用未经校验的自由文本。

## 验证

```powershell
node --test tests/voice-orders.test.mjs
```

测试使用模拟百炼响应，覆盖 WAV 编码、语音 HTTP → 解析 HTTP → 模拟执行、坐标不瞬移、航向保持、手动覆盖、重复执行、整批地形拒绝、无密钥、错误响应、跨站访问与配置文件保护。
没有百炼密钥时不能验证真实模型准确率、账号权限、云端延迟或真实麦克风。需要本机配置后分别试一句文字和一句语音指令。

## 官方接口依据

- [Qwen3.7-Flash 模型能力](https://www.alibabacloud.com/help/en/model-studio/qwen3-7-flash)
- [千问录音文件识别与 Base64 输入](https://help.aliyun.com/zh/model-studio/recording-file-recognition-qwen)
- [结构化输出](https://help.aliyun.com/en/model-studio/qwen-structured-output)

## 本机实测（2026-11-07）

已使用真实百炼 API，通过 Edge 浏览器的录音按钮、AudioWorklet 和自动下令流程完成端到端测试。
测试音频由 Windows 慧慧中文语音合成后注入浏览器虚拟麦克风，未使用实体麦克风。

- 输入：“一号机，航向九十度，高度八千米，速度六百公里每小时。”
- ASR 返回：“一号机，航向90°，高度8000m，速度600km/h。”，本次约 1.02 秒。
- Qwen 解析并应用组合航向任务，本次约 1.86 秒；二号机原任务不变。
- 暂停状态下应用命令没有改变实际坐标；以 8× 速度运行 240 秒模拟时间后，一号机航向 89.998°、海拔 7993.95 米、真空速 600.00 千米/小时。
- 浏览器没有运行时错误。15 项自动化回归测试通过。

实测修复了组合指令中动作与参数不匹配的问题：Schema 按 action 分支约束参数，含航向的组合请求使用 fly_heading。
同时合并重复的地形预检，保留批次原子校验与独立航点高度。
爬升中速度会因能量消耗下降；达到高度后恢复目标速度，因此执行测试包含爬升后的稳定阶段。

本机详细记录：`.game-server/live-e2e-report.json`；浏览器截图：`.game-server/live-e2e.png`。

## 军事口令 v1 升级验证

统一协议扩展为57类意图，包含任务对象、目标引用、跑道、武器数量、顺序阶段和触发条件。通联风格仅保留中文与北约/ICAO。
本轮30项回归测试通过，7条代表性真实API口令全部通过：航向、起飞后集合、攻击与条件防御、进近与条件复飞、FOX通报、全体交战规则/雷达/对抗措施、本机状态报告。

Edge浏览器测试通过完整的合成语音注入→ASR→军事意图解析→航路生成→气动飞行，并验证了尚未接入的起飞与集合指令会保留阶段、显示缺失能力且不改变现有任务。浏览器没有运行时错误，实体麦克风收音效果仍需玩家自行试说。

代表性真实API验证不表示所有自然语言组合都已经穷尽测试，也不表示已实现战斗或起降仿真。未来能力仍需各自的执行器与验收。

本机记录：`.game-server/military-live-report.json`、`.game-server/military-browser-report.json`；截图：`.game-server/military-browser.png`。

## 指挥台与电脑飞行员分工

玩家是唯一指挥权来源；Qwen负责理解玩家意图并形成指挥命令，不自行选择作战目的或生成内部中间航点。响应新增 `command`，明确 `authority=player`、`speakerRole=commander`、`planningOwner=pilot`，保留原 `plan` 字段兼容现有接口。

本地 `runCommandSession` 等待指挥台播报与电脑飞行员复诵完成，核对关键参数后才调用 `preparePilotPlan` 规划。规划没有物理副作用；地图以琥珀色逐点展示拟设航点，再由 `commitPilotPlan` 原子装订。电脑飞行员继续通过同一气动内核操纵飞机，实际坐标和速度不会瞬间改写。规划失败、版本过期或尚无执行能力时保留原任务；装订前取消不执行，装订后停止通话不撤销已执行任务。

字幕与语音由 `createRadioConsole` 按指挥台、塔台和飞行员角色输出。默认使用 Inworld TTS-2 Flash；`spoken` 仅在音频播放结束后记录，静音、失败与取消分别记录为 `muted` / `unavailable` / `cancelled`。云端合成失败时，同一句通联尝试浏览器本地语音，保留故障原因与字幕；已装订的飞行任务继续执行。云端恢复成功后自动停止本地回退。

播报按字段含义规范化，字幕保留原文：`G1机位` 读作 `GOLF ONE` 机位，`ALPHA 01` 读作 `ALPHA ONE`（呼号序号去掉显示用的前导零）。中文通联的跑道 `09L` 仍读“洞九左”，航向 `009` 仍读“洞洞九”；不因同句出现英文呼号就改成整句英文数字。英文通联的跑道则读 `ZERO NINER LEFT`。同一规则用于云端与浏览器本地播报。

同一规范覆盖 `BRAVO 02` / `BRAVO ZERO TWO` → `BRAVO TWO`、`G2机位` / `G2停机位` / `机位G2` → `GOLF TWO`、`A1滑行道` / `滑行道A1` → `ALFA ONE`；支持列表、前后置字段以及 `AE1` / `BE1` 等双字母滑行道编号。仅在地面编号上下文展开字母，保留 `STAND BY`、机型、容量与内部图节点。读法统一在最终播报层处理，不修改字幕、指令数据与飞行任务。

统一检查：`node --test tests/radio-pronunciation-audit.test.mjs`。测试收集真实机位→滑行→起飞→返场→G2停稳的机场事件，以及指挥台、逐机复诵、AI结果回报、无法执行、手动航路、飞行修订和雷达入口；验证全部机场机位/滑行道/跑道、四种字幕/语音语言组合、云端和本地合成，并检查重复规范化与字幕原样保留。

### Inworld 通联语音

在根目录 `.env` 配置以下变量，再执行 `powershell -ExecutionPolicy Bypass -File .\start_game.ps1 -Restart`：

```dotenv
TTS_PROVIDER=inworld
INWORLD_API_KEY=填入Inworld平台复制的Base64密钥
INWORLD_VOICE_COMMANDER=Dennis
INWORLD_RATE_COMMANDER=1.12
INWORLD_VOICE_CONTROLLER=Ashley
INWORLD_VOICE_PILOT=Alex
INWORLD_VOICE_PILOT_1=
INWORLD_VOICE_PILOT_2=
INWORLD_TTS_TIMEOUT_MS=15000
```

从 [Inworld 平台](https://platform.inworld.ai/) 的 API Keys 创建 Standard 密钥；只用于合成时，Voices 和 Router 资源不需要写权限。直接使用复制的 Base64 凭据，不要再次编码。音色可替换为自己工作区可用的 voiceId。默认模型为 `inworld-tts-2-flash`；开启飞行员英语本地化后，两位飞行员的中英混合通联使用 `inworld-tts-2`，以支持整句语言标记与语气控制。指挥员默认使用 1.12 倍语速，可用 `INWORLD_RATE_COMMANDER` 在 0.5–1.5 范围内调整；其他角色保持 1.08 倍。音色描述用于管理说明，Flash 不通过描述提示词控制语气，音色特征主要取决于参考录音。

浏览器将通联文本、角色及 `unitId` 发送到本机 `POST /api/voice/synthesize`，服务端选择音色并通过 Basic 认证调用 `https://api.inworld.ai/tts/v1/voice`，解码 `audioContent` 后返回 `audio/mpeg`。每条通联只发起一次上游合成，不再逐语种拼接。飞行员 1（`blue-1` / Alpha）使用 `INWORLD_VOICE_PILOT_1`，飞行员 2（`blue-2` / Bravo）使用 `INWORLD_VOICE_PILOT_2`；按单位 ID 固定绑定，不受当前选择或列表顺序影响。某项留空、未提供单位或其他飞机沿用 `INWORLD_VOICE_PILOT`。指挥员与塔台继续按角色选择；浏览器传入的 `voiceId` 不决定实际音色。输入及规范后上游文本（含语言标记和语气提示）均限制为 2000 个 UTF-16 单元；超长会在调用上游之前返回 400。英文呼号、术语及缩写保留英文原文，不改写为中文音译；纯英文强制 `en-US`，纯中文沿用请求中的中文语言设置。未启用飞行员本地化的 Flash 混合通联省略上游 `language` 参数以自动识别。Flash 不发送自然语言 steering 参数。音频只在内存中处理，不默认写入磁盘，响应禁止缓存；API Key 不发送到浏览器。通联文本会发送至 Inworld，音色试听和语音生成使用账号额度。

`GET /api/health` 的 `tts` 返回来源、模型和配置就绪状态，不包含密钥；`ready` 表示配置齐全，实际权限和额度在调用时验证。缺少密钥或云端失败时尝试本地语音，设置中的语音按钮显示当前回退状态，悬停可看原因。HTTP 402 明确提示计费或额度受限；故障期间最多每分钟随新通联重试云端，避免每句都请求失败。401/403等待重新配置或手动重试。设置中“重试Inworld语音”可播报一条语音检查，额度恢复后可立即验证；成功后显示Inworld并停止回退。静音不请求合成；打开麦克风、切换单位、重置和取消通联会中止请求及播放，丢弃晚到音频并回收临时 URL。TTS 使用单独并发额度，不占用指令解释/结果检查队列。

需要本地合成时，显式设置 `TTS_PROVIDER=browser` 并重启，沿用浏览器 SpeechSynthesis。接口契约参考 [Inworld 合成文档](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech)；自动化验证：`node --test tests/inworld-tts.test.mjs tests/command-session.test.mjs`。

2026-11-07 本轮验证：49项自动化测试通过，包含规划无副作用、复诵核对、阶段顺序、逐点显示、取消与过期、不可行反馈、装订后停话以及语音静音。Edge真实百炼语音闭环返回270°航向；浏览器语音引擎完成三段播报，拟设航点1–4依次可见且装订前正式航路为空。运行约60秒模拟时间后实际航向约270.8°，飞机正常飞行。输入使用Windows合成语音注入虚拟麦克风，未测试实体麦克风或物理扬声器听感。

报告：`.game-server/commander-browser-report.json`；截图：`.game-server/commander-browser.png`。

双语男声：在同一 `voiceId` 下完成 `en-US` 本地化、确认 `promptLanguages` 同时包含 `zh-CN` 与 `en-US` 后，设置 `INWORLD_PILOT_EN_LOCALIZED=true` 并重启。两个飞行员的混合通联先按航空规则规范文本，再用 TTS-2 整句生成 MP3。`language: en-US` 选择原音色的英语本地化，句内 `<lang lang="en-US">` 标记英文呼号、机位和滑行道，`<lang lang="zh-CN">` 标记中文正文及“洞九左”；一段简短的英语 steering 提示要求自然、沉稳、连贯的飞行员复诵，`deliveryMode: STABLE` 保持输出稳定。整句只有一次合成，避免每切换语种就重置语调、停顿与音高。字幕、音色 ID 和任务数值不变；单语通联和指挥员继续使用 Flash。健康接口的 `tts.bilingualPilotModel` 明示混合飞行员通联模型。参考 [语言标记](https://docs.inworld.ai/tts/capabilities/language-tags) 和 [语气控制](https://docs.inworld.ai/tts/capabilities/steering)。验收：`node --test tests/bilingual-speech.test.mjs tests/radio-pronunciation-audit.test.mjs`。
