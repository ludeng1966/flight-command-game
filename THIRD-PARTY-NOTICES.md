# 第三方组件与数据

本项目代码以 MIT 发布。下面是用到的第三方组件与数据源，各自保留原许可。

## 前端运行时

| 组件 | 用途 | 许可 |
|---|---|---|
| [three.js](https://threejs.org/) r186（`vendor/three/`） | WebGL 渲染 | MIT，Copyright 2010-2026 Three.js Authors |
| [fzstd](https://github.com/101arrowz/fzstd) 0.1.1（`web/vendor/`） | 浏览器内 zstd 解压 | MIT |

## Python 工具

| 组件 | 用途 | 许可 |
|---|---|---|
| NumPy | 数值与轨迹处理 | BSD-3-Clause |
| lz4 | ECS 控制码解压 | BSD-3-Clause |
| zstandard | 回放包解压 | BSD-3-Clause |

## 数据

- **回放数据**：`mission-data.js` 是示例对局（已匿名化：玩家名、账号 ID、战队标签均为合成值），由 `tools/build_ace_mission.py` 从 `.wrpl` 解码产物生成。
- **地形与掩膜**：由 [WT-MAP-ANALYZE](https://github.com/ShioUmiusi/WT-MAP-ANALYZE) 从玩家本机安装的游戏文件解析得到；仓库只保留少量样例，完整数据在该仓库的数据集里。
- **载具表**：`tables/vehicle_names.json`、`tables/vehicle_categories.json` 由社区数据整理（War-Thunder-Datamine 等），仅保留显示名与类别。
- **机场目录**：`terrain/airfields.json` 由 [wrpl-acmi](https://github.com/3794432/wrpl-acmi)（dev 分支，AGPL-3.0）的 `airfields_all.json` 整理而来，只保留地图 → 任务 → 跑道线段；该文件按 AGPL-3.0 分发，生成脚本为 `tools/build_airfields_catalogue.py`。
- **格式参考**：[wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector)（AGPL-3.0）用于理解回放容器与包结构；只作参考，没有复制其代码。

## 航空术语参考

- [FAA Pilot/Controller Glossary](https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/index.html)：本次源网页标注Effective 7/9/26、Change 3。参考条目简化为项目中文释义，保留FAA与ICAO语境及来源链接。
- [ALSSA Brevity，25 April 2025](https://www.alssa.mil/Portals/9/Documents/mttps/brevity_2025.pdf)：公开发布的多军种简语和战术聊天缩写表。项目仅整理词义与语境，不把定义当作作战授权或已实现的游戏功能。
- `data/aviation/`和14、15号中文速查是项目整理的游戏参考摘要，不是上述机构的官方中文译本。部分常见词另外标注本游戏的单位、坐标与执行约束，参见`docs/aviation-terms.txt`。

## 游戏素材

### 飞行性能参考数据

- [OpenAP](https://github.com/TUDelft-CNS-ATM/openap)：A320、747-8的机体参数、阻力极线和选用发动机记录保留于 `data/aircraft-sources/openap/`，按其 GPL-3.0 数据许可保留。离线推力公式适配参考 OpenAP（代码 LGPL-3.0）和 [Sun 等人的论文](https://doi.org/10.3390/aerospace7080104)，源代码许可另存为 `CODE-LICENSE`。
- F-16、J-11、Su-27 参数由玩家本机战雷 FM 提取、映射，保留来源 SHA-256；并未复制原气动求解器。直接字段与工程近似分别列在 `docs/aircraft-physics.txt` 及各机型 `provenance` 中。

### 公开飞机外观模型

`assets/aircraft/` 的简化网格派生自以下公开模型，分别保留原许可；原 AC3D 源文件、许可全文、作者说明、下载 URL 和 Git blob SHA-1 收录于 `assets/aircraft/sources/`。转换工具及尺寸说明见 `docs/aircraft-models.txt`。

| 模型 | 来源 / 作者 | 许可 |
|---|---|---|
| F-16 | [NikolaiVChr/f16](https://github.com/NikolaiVChr/f16)，Erik Hofman 及 `authors.txt` 贡献者 | GPL-2.0-or-later |
| Su-27 / J-11 基础外形 | [xcvb85/Su-27](https://github.com/xcvb85/Su-27)，Yanes Bechir、FGUK 及项目贡献者 | GPL-3.0 |
| Boeing 747-8I | [JMaverick16/747-8](https://github.com/JMaverick16/747-8)，John Williams、Grupo FGBr、Gijs de Rooy 等 | GPL-2.0 |
| Airbus A320-200 | [legoboyvdlp/A320-family](https://github.com/legoboyvdlp/A320-family)，Josh Davidson、Jonathan Redpath、merspieler、Matthew Maring、Thorsten Herrmann、Semir Gebran | GPL-2.0 |

本项目对这些模型进行了外形提取、减面、米制尺寸校准和材质重设；J-11 共用 Su-27 网格并改变配色。构建工具使用 [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.3.0（MIT）和 [earcut](https://github.com/mapbox/earcut) 3.2.4（ISC），均不加入浏览器运行时。

《战争雷霆》（War Thunder）及其素材版权归 Gaijin Entertainment 所有，本项目与 Gaijin 无关。仓库不包含游戏原始文件（`.wrpl`、关卡、贴图、模型）；示例数据是由玩家自己的回放与地形派生的结果。
