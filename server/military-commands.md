# 军事口令协议与手册 v1

本系统把玩家语音或文字转换成军事任务意图，再由能力检查和本地执行器决定执行方式。中文军用数字通联与北约/ICAO通联共用同一意图协议。

识别词典包含 58 类常见意图，可持续扩展。它覆盖导航、编队、作战、武器、传感器、起降和报告；不是对所有军种全部条令的穷尽实现。

## 玩家怎么下令

- “Alpha，航向两拐洞，高度八千米。”：识别为航向270°与目标高度8000米，生成可见三维航路。
- “Bravo，heading zero nine zero，前出十公里。”：建立指定长度航段，到达后盘旋。
- “Alpha，二拐跑道起飞，离地后爬升三千米，然后和Bravo集合。”：保留跑道27、起飞、爬升与集合的顺序，目前等待起降和编队执行器。
- “Bravo攻击前方匪机，Alpha掩护；如果遭到导弹攻击则防御。”：分别保留对象、目标、协同与防御条件。
- “Alpha，加入27跑道进近，跑道被占用则复飞。”：保留进近与条件复飞两个阶段。
- “Alpha，FOX THREE。”：记录为通报，不会触发发射。

呼号：Alpha / Alfa / 阿尔法 / 幺洞幺 / 101 对应一号机；Bravo / 布拉沃 / 幺洞两 / 102 对应二号机。旧 ALPHA 02 仍作为二号别名保留。

航向按三位逐位数字理解，例如两拐洞=270、洞勾洞=090；英文 ZERO NINER ZERO 也可表达090。通联风格不改变游戏的米、秒和米制坐标。

## 当前如何执行

已接入导航、航点、盘旋、高度、速度、本机状态报告和模拟暂停/继续。航向意图先生成三维航点，飞机沿航路由原气动内核飞行；未给距离时按航向滚动延伸前视航路，手动改航路会终止自动延伸。地形或飞行可行性限制可能阻止新航段，界面会显示原因。

双机集合、跟随、六种双机队形、掩护、护航和长僚机分工已有实际控制。简化雷达搜索/锁定以及导弹选择、准备和明确发射已接入；高级交战协同与条件调度尚未接入。机场任务以当前场景机场数据和能力表为准。缺失能力时界面显示“已识别/待接入”，不会改用普通航点伪装完成。一个复合任务中有缺失能力时整批不执行。

已识别的待接入任务保存在当前 World.commandLog（最近32条）中，作为可审阅的任务记录，不会在未来安装执行器后自动启动。

## API 与结构

- GET /api/tactical/catalog：协议版本、完整词典、能力状态。
- POST /api/tactical/interpret：保持 requestId/instruction/context 请求格式；新增 interpretation 与 execution 返回值，plan 为兼容现有自动驾驶的执行计划。
- interpretation：version、status、summary、orders；status 为 understood / needs_clarification / unknown。
- 每条 order：id、intent、unitIds、speechAct、timing、condition、parameters。
- speechAct 区分 directive（指令）、request（请求）、report（通报）、clearance（许可）。
- timing 区分 now / after_previous / on_condition；condition 保留明确条件。条件存在时以 on_condition 为准。
- parameters 保存高度、速度、航向、距离、坐标、数量、目标方位、目标引用、机场、跑道、等待点、队形、左右、武器、模式、角色与尚未具备执行接口的额外约束。所有未指定字段为 null，append 默认为 false。字段定义在 server/military-planner.mjs。
- execution.status：ready / capability_unavailable / informational / needs_clarification / unknown；missingCapabilities 列出缺失系统，orderStates 对应各子任务。
- 单次最多8条意图、16条实际执行任务；飞机和目标ID由请求上下文动态约束。

## 口令词典

“可执行”指已有本地执行器；“待接入”指能识别并记录意图，但不生成执行动作。

### 导航与飞行

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| fly_heading | 航向与前出 | 可执行 | Alpha，航向两拐洞，前出十公里 |
| set_flight | 高度与速度 | 可执行 | 幺洞幺，爬升八千米，速度六百公里每小时 |
| fly_to | 飞往或追加航点 | 可执行 | Bravo，飞往标记点，保持当前速度 |
| orbit | 盘旋待命 / ANCHOR | 可执行 | Alpha，ANCHOR，保持高度 |
| clear_waypoints | 清除航路 | 可执行 | Alpha，清除当前航路 |

### 编队与协同

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| follow_unit | 跟随友机 | 可执行：空中双机 | Bravo，跟随 Alpha，保持两公里间隔 |
| join_formation | 集合入队 / JOIN UP | 可执行：空中双机 | Bravo，加入 Alpha 编队 |
| formation_change | 改变队形 | 可执行：空中双机六种队形 | 全体，改为左右横队 |
| formation_split | 分散编队 / SPLIT | 待接入：高级编队战术 | 全体分散，Alpha 向左，Bravo 向右 |
| assign_role | 分配长僚机或任务角色 | 可执行：lead/wingman，其他角色待接入 | Alpha 为长机，Bravo 为僚机 |
| cover | 掩护友机 | 可执行：后上方保护位随行 | Bravo，掩护 Alpha |
| cooperate | 双机协同模式 | 待接入：编队协同、交战战术决策、任务管理 | 全体，采用双机自由配合 |

队形 `formation` 支持：梯队 `echelon`、纵队 `trail`、横队 `line_abreast`、战斗疏开 `combat_spread`、楔形 `wedge`、战斗翼队 `fighting_wing`、四指 `finger_four`。四指需四机，两机可用楔形。协同 `cooperate.mode` 使用相互支援 `mutual_support`、双机自由配合 `loose_deuce`、萨奇剪 `thach_weave`；夹击、护航、掩护仍使用各自意图。

`targetId` 是参照或受保护机，`rangeM` 保存明确间隔，`side` 为 `left/right`，角色使用 `lead/wingman/engaged/free`。Flash 按需读取完整编队手册，口令解析只附一个相关短例子。来源及工程映射见 [研究说明](../docs/formation-cooperation-research.txt)。

当前实际支持六种双机队形，四指暂不执行。间隔限400–5000米；默认1200米，默认右侧或沿用现有关系。首次“全体改队形”使用选中机作长机，之后保留原长机。长机继续原任务，僚机通过真实飞控追赶，左右换位从长机后方进行。给僚机独立命令可退出编队。见[双机控制说明](../docs/formation-flight-control.txt)。

### 任务与巡逻

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| patrol | 巡逻 / CAP | 待接入：任务管理 | Alpha，在指定空域执行战斗巡逻 |
| escort | 护航 | 可执行：已存在友机的侧后方伴飞 | Bravo，护航Alpha，保持左侧 |
| recon | 侦察 | 待接入：任务管理、雷达与目标航迹 | Alpha，侦察指定区域 |
| search | 搜索空域 | 待接入：任务管理、雷达与目标航迹 | Alpha，搜索前方空域 |
| return_to_base | 返航 / RTB | 待接入：任务管理、机场与跑道任务、燃油与续航管理 | 全体，返航本场 |
| divert | 备降 / DIVERT | 待接入：任务管理、机场与跑道任务、进近与着陆控制 | Alpha，转往备用机场降落 |
| abort_mission | 中止任务 / ABORT | 待接入：任务管理 | Alpha，中止当前任务，等待指令 |

### 交战与防御

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| intercept | 拦截 / COMMIT | 待接入：雷达与目标航迹、交战战术决策 | Alpha，拦截前方匪机 |
| attack | 攻击目标 | 待接入：雷达与目标航迹、交战战术决策、武器与交战规则 | Alpha，攻击指定目标 |
| banzai | BANZAI 进攻战术 | 待接入：雷达与目标航迹、交战战术决策、武器与交战规则 | Alpha，BANZAI，目标一号 |
| crank | CRANK 偏置支持 | 待接入：雷达与目标航迹、交战战术决策、武器与交战规则 | Alpha，CRANK LEFT，继续支持导弹 |
| f_pole | F-POLE 间隔优化 | 待接入：雷达与目标航迹、交战战术决策、武器与交战规则 | Alpha，执行 F-POLE |
| defend | 威胁防御 / DEFEND | 待接入：雷达与目标航迹、交战战术决策、告警与对抗措施 | Alpha，防御来袭导弹 |
| notch | NOTCH 防御机动 | 待接入：雷达与目标航迹、交战战术决策 | Alpha，NOTCH LEFT |
| drag | DRAG 脱离机动 | 待接入：雷达与目标航迹、交战战术决策 | Alpha，向西 DRAG |
| disengage | 脱离交战 / DISENGAGE | 待接入：交战战术决策 | 全体，脱离交战 |
| reengage | 重新交战 | 待接入：雷达与目标航迹、交战战术决策 | Alpha，重新进入攻击 |
| bracket | BRACKET 夹击 | 待接入：编队协同、交战战术决策 | Alpha、Bravo，左右夹击目标 |
| extend | EXTEND 拉开间隔 | 待接入：交战战术决策 | Alpha，向西 EXTEND，准备再进入 |

### 武器与交战规则

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| weapons_hold | 武器保持 / WEAPONS HOLD | 已接入：只接受明确发射令 | 全体，WEAPONS HOLD |
| weapons_tight | 严格识别后交战 / WEAPONS TIGHT | 已接入：设置规则，不自动发射 | 全体，WEAPONS TIGHT |
| weapons_free | 放宽交战规则 / WEAPONS FREE | 已接入：设置规则，不自动发射 | Alpha，WEAPONS FREE |
| select_weapon | 选择武器 | 已接入：选择本机已挂载型号 | Alpha，选择 AIM-9M |
| launch_weapon | 明确发射武器 | 已接入：弹量、准备状态与本机目标观测校验后实际发射 | Alpha，向 TGT 01 发射一枚 AIM-120 |
| cease_fire | 停止射击 / CEASE FIRE | 已接入：恢复武器保持，不撤回在空弹 | 全体，停止射击 |
| jettison | 抛弃指定挂载 | 待接入：武器与交战规则、起落架与襟翼控制 | Alpha，抛弃副油箱 |

### 传感器与对抗

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| radar_mode | 雷达工作模式 | 待接入：雷达与目标航迹 | Alpha，雷达切换搜索模式 |
| lock_target | 锁定目标 | 待接入：雷达与目标航迹 | Alpha，锁定目标一号 |
| emcon | 电磁管制 / EMCON | 待接入：雷达与目标航迹 | 全体，关闭主动雷达，保持静默 |
| countermeasures | 释放箔条或热焰弹 | 待接入：告警与对抗措施 | Alpha，释放热焰弹 |

### 起飞与降落

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| taxi | 滑行 / TAXI | 待接入：机场与跑道任务、地面滑行与滑跑 | Alpha，沿滑行道滑行到二拐跑道等待点 |
| hold_short | 跑道外等待 / HOLD SHORT | 待接入：机场与跑道任务、地面滑行与滑跑 | Alpha，跑道二拐外等待 |
| line_up | 进入跑道对正 / LINE UP | 待接入：机场与跑道任务、地面滑行与滑跑 | Alpha，进入二拐跑道对正等待 |
| takeoff | 起飞 / TAKEOFF | 待接入：机场与跑道任务、地面滑行与滑跑、起飞控制 | Alpha，二拐跑道起飞，离地后爬升三千米 |
| abort_takeoff | 中断起飞 / REJECT TAKEOFF | 待接入：地面滑行与滑跑、起飞控制 | Alpha，中断起飞 |
| approach | 进近 / APPROACH | 待接入：机场与跑道任务、进近与着陆控制 | Alpha，加入二拐跑道进近 |
| land | 着陆 / LAND | 待接入：机场与跑道任务、进近与着陆控制 | Alpha，二拐跑道降落 |
| go_around | 复飞 / GO AROUND | 待接入：进近与着陆控制、起飞控制 | Alpha，复飞，爬升两千米 |
| gear | 收放起落架 | 待接入：起落架与襟翼控制 | Alpha，放起落架 |
| flaps | 设置襟翼 | 待接入：起落架与襟翼控制 | Alpha，襟翼设为着陆位 |

### 应急与报告

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| report_status | 报告本机状态 | 可执行 | Alpha，报告航向、高度和速度 |
| engine_power | 发动机模式 / BUSTER / GATE | 待接入：发动机模式管理 | Alpha，BUSTER，最大持续推力 |
| emergency_recover | 应急改出 | 待接入：任务管理、起落架与襟翼控制 | Alpha，终止当前机动，执行应急改出 |
| report_event | 通报事件 / FOX / BINGO / TALLY | 仅通报 | Alpha，FOX THREE |

### 模拟控制

| 意图 | 口令含义 | 当前能力 | 示例 |
| --- | --- | --- | --- |
| pause | 暂停模拟 | 可执行 | 指挥台，暂停模拟 |
| resume | 继续模拟 | 可执行 | 指挥台，继续模拟 |

## 语义边界与扩展

FOX等发射通报不等于发射命令；WEAPONS FREE 是交战规则而非立即开火。普通 DEFEND 不会由解释器擅自变成 NOTCH。先后与条件不能被删除；有额外未实现的机动限制时也不部分执行。

新增功能时需要同时注册能力、接入仿真执行器、补充参数校验和回归测试；只把 available 改成 true 不会让未实现意图获得执行能力。

## 公开资料依据

字母拼读参考 [NATO 字母表](https://www.nato.int/en/about-us/nato-history/history-by-theme/symbols-of-nato/nato-phonetic-alphabet)；三位航向逐位读法参考 [FAA 通话规则](https://www.faa.gov/air_traffic/publications/atpubs/fs_html/chap2_section_3.html)。

中文数字读法参考 [中国军网-人民武警来源的军语说明（新华网转载）](https://www.xinhuanet.com/mil/2016-03/21/c_128818839_3.htm)。仅据此采用公开数字读法，没有声称取得完整军事通信条令。

战术缩略语参考 [USAF Test Pilot School 公开通联词典](https://usaftps.github.io/flight-test-brevity/multiservice-codes-applicable-to-flight-test.html)；起降与通话术语参考 [FAA Pilot/Controller Glossary](https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/)。任务到游戏参数的映射属于本项目约定。

指挥台与飞行员闭环参考 [FAA AIM 4-4：ATC Clearances and Aircraft Separation](https://www.faa.gov/Air_traffic/publications/atpubs/aim_html/chap4_section_4.html)：以呼号确认接令、复诵关键高度/航向等信息，飞行员无法遵从时应报告并请求修改。项目采用这些公开通联原则组织游戏交互，航路逐点展示与分阶段装订是本项目的体验设计；该民航资料不等同于北约或解放军的完整军事指挥条令。
