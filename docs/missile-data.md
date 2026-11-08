# 当前导弹数据范围

当前仅整理 AIM-120、AIM-7P、AIM-9M、PL-12、PL-5EII。范围由 `data/missile-scope.json` 固定，重新导入不会扩大到其他导弹；AIM-7 系列只保留 P 型。

| 家族 | 本地配置包含的改型 | 默认查看配置 |
| --- | --- | --- |
| AIM-120 | A、B、C-5、C-7、D | `us_aim_120b` |
| AIM-7P | 仅 P，源文件为 F/A-18 配置及其 default 变体 | `us_aim7p_sparrow_fa_18` |
| AIM-9M | M | `us_aim9m_sidewinder` |
| PL-12 | PL-12，排除 PL-12A | `cn_pl12` |
| PL-5EII | 本地标识为 `pl_5e2` / `su_pl5e2` | `su_pl5e2` |

共有 9 个源弹名、24 个配置变体。默认挂载、BOL 挂架、不同载机变体保留独立记录，不能因弹名相同就覆盖参数。

## 文件和接口

- `data/flight-research/catalog.json`：限定范围、变体索引和来源归档 SHA256。
- `data/flight-research/missiles/<id>.json`：单个变体的标准化数据和完整 `rawRocket` 原字段。
- `data/flight-research/missiles.csv`：全部 24 个配置的质量、尺寸、主要系数、飞控上限、推力阶段汇总。
- `GET /api/flight-data/catalog`：目录。
- `GET /api/flight-data/missile?id=us_aim9m_sidewinder`：单个变体。目录外型号返回 404。
- 本地页面：`http://127.0.0.1:8000/game/flight-data.html`。

## 字段用途与限制

质量 kg、尺寸 m、推力 N、时间 s 使用显式单位字段。发动机 `motorStages` 保留每段推力、燃烧时长、初末质量；编号阶段暂按连续燃烧解释，并在来源字段注明该假设。质量、推力的原始字段同时保留，后续求解器可以独立校正阶段解释。

`aerodynamics` 保留 `dragCx`、`CxK`、`wingAreaMult`、`finsAoaHor/Ver`、`finsLatAccel` 和质心到稳定面的距离。`frontalAreaM2` 仅由弹径推导，不能直接声称它是原求解器采用的参考面积。没有把未知含义的系数相乘后宣称为真实阻力极曲线，也没有生成不存在的马赫数/迎角极曲线或惯性矩。

`flightControl` 保留源自动驾驶仪参数；实际请求过载上限单列为 `simulationLimits.autopilotMaxG`。`statCard` 的射程、马赫数、过载属于面板信息，不作为恒速飞行、必达射程或自动驾驶仪限制。原始射程表不解释为不可逃逸区。

这些文件是本地战雷游戏配置，不是已验证的实弹工程数据。现已接入实时飞行积分、三类导引头、分段发动机和近炸引信，并提供武器面板、明确发射指令和弹道显示。物理映射及限制见[实时导弹与引导](missile-simulation.md)，不能将项目简化模型称为原引擎复现或真实实弹性能。

## 重新导入

在项目根目录运行以下命令，路径按本机提取位置调整。导入过程只读取战雷源文件；清理仅针对先前目录中登记的本项目生成记录。

```powershell
node tools/import_wt_flight_data.mjs --weapons F:/mygame/wt_flight_research/local_weapons/aces.vromfs.bin_u/gamedata/weapons/rocketguns --aircraft-root F:/mygame/wt_flight_research/local_aces/aces.vromfs.bin_u/gamedata/flightmodels --archive 'D:/steam/steamapps/common/War Thunder/aces.vromfs.bin' --out data/flight-research
```
