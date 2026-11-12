// 导航面板纯数据模型：只做显示计算，不修改世界。
const toDeg = (rad) => ((rad * 180 / Math.PI) + 360) % 360;
const clampSpeed = (speed) => Number.isFinite(speed) && speed > 30 ? speed : 250;

export function navDistanceM(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
export function navBearingDeg(from, to) {
  if (!from || !to) return null;
  return toDeg(Math.atan2(to[0] - from[0], to[1] - from[1]));
}
export function formatNavDistance(m) {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
export function formatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
export function navPanelModel(unit, world) {
  if (!unit) return null;
  const speed = clampSpeed(unit.speed ?? unit.targetSpeed);
  const waypoints = unit.waypoints ?? [];
  let previous = unit.position;
  let cumulative = 0;
  const route = waypoints.map((w, i) => {
    const legM = navDistanceM(previous, w);
    const cumulativeM = cumulative + legM;
    const item = {
      number: w.number ?? (unit.completedWaypoints ?? 0) + i + 1,
      index: i,
      legM,
      cumulativeM,
      etaSec: cumulativeM / speed,
      altitudeM: w[2]
    };
    previous = w; cumulative = cumulativeM;
    return item;
  });
  const next = route[0] ?? null;
  const bullseye = world?.bullseye?.position
    ? {
        name: world.bullseye.name ?? 'BULLSEYE',
        bearingDeg: navBearingDeg(world.bullseye.position, unit.position),
        rangeM: navDistanceM(world.bullseye.position, unit.position)
      }
    : null;
  const airspace = world?.airspaceContext?.(unit.id) ?? null;
  return {
    id: unit.id,
    callsign: unit.callsign ?? unit.id,
    speedMps: speed,
    next,
    route,
    routeTotalM: cumulative,
    completed: unit.completedWaypoints ?? 0,
    blocked: unit.navigationBlocked ?? null,
    bullseye,
    airspace
  };
}
export function navPanelText(model) {
  if (!model) return '未选择飞机';
  if (!model.route.length) return '无航路';
  return `下一航点 #${model.next.number} · ${formatNavDistance(model.next.legM)} · ETA ${formatEta(model.next.etaSec)}`;
}
