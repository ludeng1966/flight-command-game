// 机场调度板纯数据模型：只读汇总跑道/队列/许可/机位，不改 ATC 规则。
const ACTIVE_CLEARANCE = new Set(['issued', 'delivered', 'active']);
const ACTIVE_REQUEST = new Set(['pending', 'waiting', 'cleared']);
const KIND_LABEL = {departure: '离场', arrival: '进场', taxi: '滑行', line_up: '进跑道', takeoff: '起飞', land: '落地'};

export function airportBoardModel(world) {
  const ops = world?.airportOps;
  const airport = ops?.airport;
  if (!airport) return null;
  const traffic = ops.traffic?.state ?? {};
  const units = world?.units ?? [];
  const callsign = id => units.find(u => u.id === id)?.callsign ?? id ?? '—';
  const runways = (airport.runways ?? []).map(r => ({
    designator: r.designator,
    stripId: r.stripId,
    ownerId: ops.leases?.[r.stripId] ?? null,
    owner: ops.leases?.[r.stripId] ? callsign(ops.leases[r.stripId]) : null,
    lastUseSec: Number.isFinite(traffic.lastUse?.[r.stripId]?.at) ? Math.max(0, (airport.clock ?? 0) - traffic.lastUse[r.stripId].at) : null,
    closed: airport.closed?.includes(r.designator) || airport.closed?.includes(r.stripId) || false
  }));
  const queue = (traffic.requests ?? []).filter(q => ACTIVE_REQUEST.has(q.status)).map(q => ({
    id: q.id,
    unitId: q.unitId,
    callsign: callsign(q.unitId),
    kind: q.kind,
    kindLabel: KIND_LABEL[q.kind] ?? q.kind,
    status: q.status,
    runway: q.runway ?? null,
    reason: q.reason ?? null,
    etaSec: Number.isFinite(q.etaSec) ? q.etaSec : null,
    priority: q.priority ?? 0
  }));
  const clearances = (traffic.clearances ?? []).filter(c => ACTIVE_CLEARANCE.has(c.status)).map(c => ({
    id: c.id,
    unitId: c.unitId,
    callsign: callsign(c.unitId),
    type: c.type,
    typeLabel: KIND_LABEL[c.type] ?? c.type,
    status: c.status,
    runway: c.parameters?.runway ?? null
  }));
  const stands = (airport.stands ?? []).map(id => {
    const unit = units.find(u => u.surface?.node === id);
    return {id, unitId: unit?.id ?? null, callsign: unit?.callsign ?? null};
  });
  return {
    airportId: airport.id ?? 'BAY',
    airportName: airport.name ?? 'BAY',
    runways,
    queue,
    clearances,
    stands,
    freeStands: stands.filter(s => !s.unitId).length,
    weather: airport.weather ? {qnhHpa: airport.weather.qnhHpa ?? null, wind: airport.weather.wind ?? null} : null
  };
}
