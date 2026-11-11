# 许可与合规风险清单

> 状态：工程风险记录，**不是法律意见**。公开发布、商业化或大规模分发前，必须由熟悉开源许可的律师复核本文列出的条目。
>
> 相关文档：[README](../README.md) · [第三方组件与数据](../THIRD-PARTY-NOTICES.md) · [项目路线](ROADMAP.md) · [回放解码](REPLAY-DECODE.md) · [回放格式](REPLAY-FORMAT.md)

## 0. 结论先行

**仓库当前的许可声明与实际内容不一致，不能简单对外宣称“整个仓库是 MIT”。**

两处最直接的问题：

1. **回放解码部分参考/移植了 AGPL-3.0 项目**。`tools/wrpl_decode.py`、`tools/wrpl_decode_ecs.py` 的注释写明帧格式、FM 布局、实体/模板/组件结构“移植自” [wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector)（Go，AGPL-3.0）；`docs/REPLAY-FORMAT.md` 还记录参考了 `wrpl` crate 0.10.0（AGPL-3.0），并出现“直接照抄其字段宽度”的表述。
2. **机场目录数据自身标注 AGPL-3.0**。`terrain/airfields.json` 顶层字段为 `"license":"AGPL-3.0"`、`"source":"wrpl-acmi"`；`tools/build_airfields_catalogue.py` 也写明“derived file is distributed under AGPL-3.0 to match its source”。但仓库根 `LICENSE` 是 MIT。

在这两点解决之前，仓库应视为**混合许可、许可状态未决**，而不是纯 MIT 项目。

WTACRP 回放查看器现仅作代码参考，但其代码与数据仍在仓库中，相关许可风险不因定位调整而消失。

## 1. 风险总览

| ID | 风险 | 等级 | 当前状态 |
|---|---|---|---|
| R1 | 回放解码移植 AGPL-3.0 代码/结构 | **高** | 已有移植说明与署名，但未做法务判断 |
| R2 | `terrain/airfields.json` 为 AGPL-3.0 派生数据，与 MIT 声明冲突 | **高** | 文件自标 AGPL，仓库整体仍写 MIT |
| R3 | 战争雷霆衍生数据（回放、载具名、飞行数据、地形） | **中高** | 未分发原始游戏文件，示例已匿名化 |
| R4 | War-Thunder-Datamine 载具表许可未记录 | **中** | 仅保留显示名/类别，来源与版本有记录，许可未确认 |
| R5 | WT-MAP-ANALYZE 地形数据许可未核实 | **中** | 仓库保留样例，完整数据构建时拉取 |
| R6 | 云端模型与 TTS 服务条款、数据出境 | **中低** | 密钥仅服务端，文本会发送至 DashScope/Inworld |
| R7 | 本地 2B 模型（实验已停用）与 llama.cpp 许可 | **低** | 模型不随仓库分发，`.local-ai/` 已忽略 |
| R8 | three.js / fzstd / NumPy / lz4 / zstandard | **低** | 均为宽松许可，已有声明 |
| R9 | FAA/ALSSA 航空术语参考 | **低** | 已改为中文摘要并标注来源，非官方译本 |
| R10 | Godot 移植后的许可边界 | **中低** | 引擎 MIT，但移植不能洗掉 AGPL 义务 |
| R11 | 品牌与命名（War Thunder / Ace Combat） | **中** | 已有非关联声明，项目名与宣传仍需注意 |

## 2. 逐项说明

### R1 回放解码移植 AGPL-3.0（高）

**证据**

- `tools/wrpl_decode.py` 头部：帧格式与 FM 布局“移植自 wrpl-inspector（Go，AGPL-3.0）”。
- `tools/wrpl_decode_ecs.py` 头部：实体/模板/组件组织结构“移植自 wrpl-inspector v3（Go，AGPL-3.0）”。
- `docs/REPLAY-DECODE.md`：位流布局与帧格式“移植自” wrpl-inspector，并声明“交付内容里不复制该项目的代码文本”。
- `docs/REPLAY-FORMAT.md`：参考 `wrpl` crate 0.10.0（AGPL-3.0），并写有“直接照抄其字段宽度”。
- `docs/QUICK-REF.md`：wrpl-inspector、wt_blk、wrpl crate 三项均标为 AGPL-3.0。

**风险**

- 如果被认定为 AGPL-3.0 作品的衍生作品，按 MIT 分发即违反 AGPL 的署名、源码提供和同许可要求。
- 若把服务端/网页作为网络服务提供给用户，AGPL 第 13 条（网络交互用户可获取对应源码）可能适用。
- “只复制字段宽度/格式事实”可能属于不受版权保护的思想或事实，但“结构移植”“按它改正”“直接照抄”等表述会显著提高被认定为衍生的风险；最终取决于具体代码相似度与司法辖区。

**现有缓解**

- 仓库不包含上游参考实现，`build/` 与 `build/wrpl-inspector/` 已被忽略。
- 文档与工具头保留了来源和 AGPL 声明，没有隐匿出处。
- 解码实现是独立的 Python 代码，不是整段复制。

**建议处置（按优先级）**

1. 法务复核：对 `tools/wrpl_decode.py`、`tools/wrpl_decode_ecs.py`、`tools/wrpl_header.py` 做与上游的相似度审查，判断是否构成衍生。
2. 三选一：
   - **整体改 AGPL-3.0**：如果 AGPL 派生成立且不排斥 copyleft，这是最简单、最诚实的方案；
   - **隔离**：把回放解码与相关数据拆成独立的 AGPL 子项目/可选包，游戏主体保持 MIT，但分发组合时仍需满足 AGPL；
   - **净室重写**：只依据回放格式事实和黑盒测试重写解码器，保留独立设计和测试记录，再考虑 MIT。
3. 在结论出来前，README 和发布说明不要声称“整个仓库 MIT”。

### R2 机场目录 AGPL-3.0 与 MIT 冲突（高）

**证据**

- `terrain/airfields.json` 顶层：`"source":"wrpl-acmi"`、`"license":"AGPL-3.0"`、带来源 commit。
- `tools/build_airfields_catalogue.py`：输出文件“distributed under AGPL-3.0 to match its source”。
- 仓库根 `LICENSE` 为 MIT；README 与 `THIRD-PARTY-NOTICES.md` 也以 MIT 为主口径。
- `web/airfields.js` 与 `web/index.html` 会消费该目录，属于实际交付内容。

**风险**

- 同一仓库里同时存在 MIT 声明和 AGPL-3.0 数据，接收者无法从根 `LICENSE` 判断哪些内容受哪个许可约束。
- 若机场目录被认定为 AGPL 作品的衍生数据，分发包含它的整体产物需要满足 AGPL（提供许可证文本、源码、同许可）。
- 仅删除字段或裁剪数据不一定能消除数据库/汇编层面的权利。

**建议处置**

1. 在仓库中明确标注 `terrain/airfields.json`（以及任何由它生成的 `web/` 数据）为 AGPL-3.0，且**不在 MIT 覆盖范围内**。
2. 附带 AGPL-3.0 完整许可证文本（`LICENSES/AGPL-3.0.txt`）与来源、commit。
3. 如果不想让整个分发受 AGPL 影响，改用非 AGPL 来源重新生成机场目录，或把它做成可移除的可选数据包。
4. 更新 `README.md`、`THIRD-PARTY-NOTICES.md` 和发布说明，明确“混合许可”。

### R3 战争雷霆衍生数据（中高）

**证据与现状**

- `mission-data.js`、`attitude-data.js`、`terrain/*`、`tables/*` 均由玩家本机 `.wrpl`、游戏关卡文件或社区整理数据派生。
- 仓库不包含 `.wrpl`、关卡、贴图、模型；示例玩家名、账号 ID、战队标签已匿名化。
- README 已声明与 Gaijin 无关。

**风险**

- 回放数据、载具名称、飞行性能参数、机场与地形数据可能仍受 Gaijin 的版权、数据库权利或 EULA 约束；匿名化不改变数据来源。
- 公开分发、商业化或用于宣传时，风险高于本地自用。
- “War Thunder”名称与相关标识涉及商标；界面/文档中应避免暗示官方关联或背书。

**建议处置**

- 公开发布前做法务/权利评估；必要时替换为原创虚构载具、地图与参数。
- 继续确保不重新分发游戏原始文件。
- 保留“非官方、与 Gaijin 无关”的声明，避免在项目名、Logo、商店页中使用官方标识。
- 商业化前优先考虑原创素材路线。

### R4 War-Thunder-Datamine 载具表（中）

- `tables/vehicle_names.json`、`tables/vehicle_categories.json` 的来源记录为 `gszabi99/War-Thunder-Datamine`，仓库只保留显示名与类别。
- 该上游仓库的许可未在本仓库文档中明确记录；本次核查也未能在线确认。
- **动作**：核实上游许可与使用条款，记录版本/commit；若许可不明，改为原创命名或只保留自行整理的分类。

### R5 WT-MAP-ANALYZE 地形数据（中）

- 仓库保留少量地形样例（等高线、掩膜、高度栅格），完整数据集在构建时从 `ShioUmiusi/WT-MAP-ANALYZE` 拉取。
- 该数据集许可未在本仓库文档中明确记录，本次核查未能在线确认。
- **动作**：核实数据集许可与再分发条件；在 README 与 `THIRD-PARTY-NOTICES.md` 写明来源、版本与许可；若不允许再分发，移除样例并改为构建时获取。

### R6 云端模型与 TTS（中低）

- 指挥官/语音识别使用阿里云百炼 DashScope（`qwen3.7-flash`、`qwen3-asr-flash`），通联语音使用 Inworld TTS。
- 风险不在开源许可，而在服务条款、数据处理与隐私：玩家语音与指令文本会发送到第三方；密钥、配额和地域限制需遵守。
- **动作**：在隐私说明中写明发送的数据与目的；不发送与游戏无关的敏感信息；密钥只保存在本机 `.env`；商用前确认服务条款允许。

### R7 本地 2B 模型（实验已停用，低）

- 本地 2B 实验已停止支持；`server/README.md` 仅保留历史第三方组件记录：llama.cpp（MIT）、Qwen3.5-2B（Apache-2.0）、Unsloth GGUF 量化。
- 模型与运行时放在被忽略的 `.local-ai/`，不随仓库分发；不要在新的部署中启用。
- **动作**：若将来重新启用并随安装包分发模型，重新核对模型卡与量化版本的许可和再分发条款。

### R8 宽松许可组件（低）

- three.js（MIT）、fzstd（MIT）、NumPy（BSD-3-Clause）、lz4（BSD-3-Clause）、zstandard（BSD-3-Clause）。
- 保留版权与许可文本即可；`vendor/` 与 `web/vendor/` 已有许可文件。
- **动作**：新增依赖时继续记录许可，避免引入 GPL/AGPL 依赖而不自知。

### R9 航空术语与公开资料（低）

- FAA Pilot/Controller Glossary、ALSSA Brevity 等公开资料被改写为中文摘要，并标注来源。
- 风险主要是被误读为官方译本或作战授权。
- **动作**：保留“非官方译本、仅游戏参考”的声明；不要把原文大段复制进仓库。

### R10 Godot 移植（中低）

- Godot 引擎为 MIT，本身不构成 copyleft 风险。
- 但如果阶段 2 把 AGPL 派生的回放解码逻辑移植进 Godot 项目，AGPL 义务会随代码走，不会因为换引擎而消失。
- **动作**：移植前完成 R1 的许可结论；在 Godot 项目里保持模块边界与许可声明；不要把 AGPL 代码混入声明为 MIT 的核心。

### R11 品牌与命名（中）

- 项目名、README、截图与宣传中出现 “War Thunder”“Ace Combat” 等名称。
- **动作**：只作兼容性/风格参考的描述，不暗示官方关联；公开发布前评估是否需要在产品名与素材上完全去品牌化。

## 3. 发布前检查清单

- [ ] 对 `tools/` 回放解码做上游相似度与衍生性审查，形成书面结论。
- [ ] 决定许可模型：整体 AGPL-3.0、AGPL 子项目隔离，或净室重写后保持 MIT。
- [ ] 为 `terrain/airfields.json` 及其生成物添加 AGPL-3.0 声明与完整许可证文本，或替换为非 AGPL 来源。
- [ ] 更新根 `LICENSE`/`README.md`/`THIRD-PARTY-NOTICES.md`，删除“整个仓库 MIT”的表述，改为混合许可说明。
- [ ] 核实 WT-MAP-ANALYZE、War-Thunder-Datamine 的许可与再分发条件，记录版本/commit。
- [ ] 确认仓库不包含上游参考实现、游戏原始文件、密钥与运行日志。
- [ ] 评估 War Thunder 衍生数据与商标风险；公开/商业发布前决定是否替换为原创素材。
- [ ] 检查云端模型与 TTS 的服务条款、隐私说明和数据发送范围。
- [ ] Godot 移植前复核许可边界，确保 AGPL 义务不被“换引擎”绕过。
- [ ] 以上结论由法务复核后再对外发布。

## 4. 当前禁止事项

- 不要对外宣称“本仓库全部代码与数据均为 MIT”。
- 不要在未确认许可前删除现有来源、署名与 AGPL 声明。
- 不要把 wrpl-inspector、wrpl-acmi、wt_blk、wrpl crate 的代码整段复制进本仓库。
- 不要在未处理 R1/R2 前进行商业化分发或提供网络服务。
- 不要因为“只保留了字段/裁剪了数据”就假定许可风险消失。
