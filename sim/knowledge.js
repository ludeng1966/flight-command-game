// 战争迷雾：把雷达/目视观测汇总成"玩家阵营知道什么"。
// 状态：visual（目视/近距确认，可显示真实模型）→ radar（雷达接触，只显示符号）
//       → ghost（最后已知位置残影，带年龄）→ 遗忘（不出现）。
export const KNOWLEDGE_VISUAL_RANGE_M = 8000;
export const KNOWLEDGE_GHOST_SEC = 30;
export const KNOWLEDGE_STATES = Object.freeze(['visual', 'identified', 'radar', 'ghost']);

const teamOf = (u) => u?.team ?? u?.faction ?? 'blue';

export function updateKnowledge(world, {side = 'blue', now = world.time} = {}) {
  const previous = new Map((world.knowledge ?? []).map((k) => [k.id, k]));
  const seen = new Map();
  for (const own of world.units) {
    if (own.alive === false || teamOf(own) !== side) continue;
    const radar = own.radar;
    if (!radar) continue;
    const freshWindow = radar.config.sweepSec + 1;
    for (const contact of radar.contacts) {
      if (now - contact.observedAt > freshWindow) continue;
      const current = seen.get(contact.id);
      if (!current || contact.observedAt >= current.observedAt) {
        seen.set(contact.id, {...contact, observerId: own.id});
      }
    }
  }
  const known = [];
  const candidates = [...(world.radarTargets ?? []), ...world.units.filter((u) => u.alive !== false && teamOf(u) !== side)];
  for (const target of candidates) {
    if (target.alive === false) continue;
    const contact = seen.get(target.id);
    const visual = world.units.some((own) => {
      if (own.alive === false || teamOf(own) !== side) return false;
      return Math.hypot(...own.position.map((v, i) => v - target.position[i])) <= KNOWLEDGE_VISUAL_RANGE_M;
    });
    if (visual) {
      known.push({id: target.id, state: 'visual', callsign: target.callsign ?? target.id, position: [...target.position], observedAt: now, ageSec: 0, source: 'visual'});
    } else if (contact) {
      const identification = contact.identification ?? null;
      known.push({id: target.id, state: identification ? 'identified' : 'radar', callsign: contact.callsign ?? target.id,
        identification, rcs: contact.rcs ?? null, position: [...contact.position], velocity: [...(contact.velocity ?? target.velocity ?? [0, 0, 0])],
        observedAt: contact.observedAt, ageSec: Math.max(0, now - contact.observedAt), source: 'radar'});
    } else {
      const old = previous.get(target.id);
      if (old && now - old.observedAt <= KNOWLEDGE_GHOST_SEC) {
        known.push({...old, state: 'ghost', callsign: old.callsign ?? target.id, ageSec: Math.max(0, now - old.observedAt)});
      }
    }
  }
  return known;
}

export function knowledgeFor(world) { return world.knowledge ?? []; }

export function stateLabel(state) { return ({visual:'目视确认', identified:'已识别', radar:'雷达接触', ghost:'最后已知'})[state] ?? state; }
