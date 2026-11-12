// 点哪飞哪：纯计算部分（不依赖 three.js / DOM），便于测试。
export const HEIGHT_BANDS = Object.freeze({low:1500, mid:6000, high:10000});

export function heightForMode(mode, currentAltitude) {
  if (mode === 'current') return Math.max(300, Number(currentAltitude) || 0);
  const band = HEIGHT_BANDS[mode];
  return Number.isFinite(band) ? band : Math.max(300, Number(currentAltitude) || 0);
}

export function bandLabel(mode) {
  return ({current:'当前','low':'低','mid':'中','high':'高'})[mode] ?? '当前';
}

export function modalAltitudeText(mode, currentAltitude) {
  const altitude = heightForMode(mode, currentAltitude);
  return `高度 ${Math.round(altitude / 10) * 10} m`;
}

export function orderSummary(append, altitude) {
  return `${append ? '追加航点' : '覆盖航路'} · 高度 ${Math.round(altitude / 10) * 10} m`;
}

// 巡逻：绕点击点画一个四边形环路（起点在点击点附近），返回 4 个航点。
export function patrolPoints(center, heading, altitude, radius = 4000) {
  const points = [];
  for (const offset of [45, 135, 225, 315]) {
    const angle = heading + offset * Math.PI / 180;
    points.push([center[0] + Math.sin(angle) * radius, center[1] + Math.cos(angle) * radius, altitude]);
  }
  return points;
}

export const COMMAND_MODES = Object.freeze([
  {id: 'move', label: '移动', hint: '飞向点，保持当前任务'},
  {id: 'attack_move', label: '攻击移动', hint: '移动中保持攻击任务与雷达'},
  {id: 'patrol', label: '巡逻', hint: '在点击区域按环形航线巡逻'},
  {id: 'rtb', label: '返场', hint: '请求加入机场进近'}
]);

export function commandModeLabel(id) { return COMMAND_MODES.find((m) => m.id === id)?.label ?? '移动'; }

export function etaSeconds(distanceM, speedMps) {
  if (!Number.isFinite(distanceM) || distanceM < 0 || !Number.isFinite(speedMps) || speedMps <= 0) return Infinity;
  return distanceM / Math.max(1, speedMps);
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`;
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

export function formatPreviewDistance(distanceM) {
  if (!Number.isFinite(distanceM)) return '—';
  return distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${Math.round(distanceM)} m`;
}

export function previewLabel(distanceM, speedMps, altitudeM) {
  return `${formatPreviewDistance(distanceM)} · ETA ${formatEta(etaSeconds(distanceM, speedMps))} · ${Math.round(altitudeM / 10) * 10} m`;
}
