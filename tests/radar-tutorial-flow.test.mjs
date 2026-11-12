import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars} from '../sim/radar.js';
import {stepRwr} from '../sim/rwr.js';
import {createRadarTutorialState,enterRadarTutorialStep,tickRadarTutorial,advanceRadarTutorial,answerRadarTutorial,currentRadarTutorialStep} from '../sim/radar-tutorial.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
const scenario = {
  units: [{
    id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', position: [0, 0, 6500], heading: 0, speed: 250,
    radar: {warmupSec: 1, nctr: true, nctrSec: 4, nctrRangeM: 35000, nctrConfidence: .8}
  }]
};
function createTutorialWorld() {
  const w = new World(scenario, profiles);
  const own = w.units[0];
  const first = w.addRadarPracticeTarget(own.id); first.rcs = 5;
  const second = w.addRadarPracticeTarget(own.id); second.position[0] += 2600; second.position[2] += 150; second.rcs = 12;
  return w;
}
const fresh = (unit, time) => unit.radar.contacts.filter((c) => time - c.observedAt <= unit.radar.config.sweepSec + .25).sort((a, b) => a.rangeM - b.rangeM);

test('第 4 关雷达教程：用真实雷达状态可以把 12 步完整打通', () => {
  const w = createTutorialWorld(), unit = w.units[0];
  const state = createRadarTutorialState();
  enterRadarTutorialStep(state, unit, w);
  const visited = [currentRadarTutorialStep(state)?.id];
  let guard = 0;
  while (state.phase !== 'done' && guard++ < 12000) {
    const step = currentRadarTutorialStep(state);
    if (!step) break;
    const radar = unit.radar;
    // 自动玩家：按当前步骤做最小正确操作
    if (step.goal === 'search' && radar.mode === 'off') w.radarCommand(unit.id, {operation: 'mode', mode: 'pd', targetId: null});
    if (step.goal === 'lock' || step.goal === 'lost' || step.goal === 'relock') {
      if (step.goal === 'relock' && radar.mode !== 'pd') w.radarCommand(unit.id, {operation: 'mode', mode: 'pd', targetId: null});
      if (!radar.targetId) {
        const list = fresh(unit, w.time);
        if (list.length) { try { w.radarCommand(unit.id, {operation: 'lock', mode: null, targetId: list[0].id}); } catch {} }
      }
    }
    if (step.goal === 'mode' && radar.mode !== 'pulse') w.radarCommand(unit.id, {operation: 'mode', mode: 'pulse', targetId: null});
    if (step.goal === 'silence' && !radar.silent) w.radarSilence(unit.id, true);
    if (step.kind === 'quiz') {
      answerRadarTutorial(state, 'gate');
    } else {
      w.time += .05;
      stepRadars(w, .05);
      stepRwr(w, .05);
      tickRadarTutorial(state, unit, w);
    }
    if (state.phase === 'success' && !advanceRadarTutorial(state, unit, w) && state.phase !== 'done') break;
    const id = currentRadarTutorialStep(state)?.id;
    if (id && visited.at(-1) !== id) visited.push(id);
  }
  assert.equal(state.phase, 'done', `教程未在 ${guard} 步内完成，停在 ${visited.at(-1)}`);
  assert.deepEqual(visited, ['ready', 'search', 'contact', 'multi', 'lock', 'lost', 'mode', 'relock', 'rcs', 'rwr', 'silence', 'quiz', 'undefined'].slice(0, -1));
  assert.equal(unit.radar.silent, true);
});
