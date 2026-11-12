import test from 'node:test';
import assert from 'node:assert/strict';
import {createRadarTutorialState,enterRadarTutorialStep,tickRadarTutorial,advanceRadarTutorial,answerRadarTutorial,currentRadarTutorialStep,RADAR_TUTORIAL_STEPS} from '../sim/radar-tutorial.js';

const stepId = (state) => currentRadarTutorialStep(state)?.id;
function fakeWorld() {
  return {time: 0, radarTargets: [], aspects: [], setRadarPracticeAspect(own, id, aspect) { this.aspects.push([own, id, aspect]); }};
}
function fakeUnit() {
  const radar = {
    available: true, mode: 'off', phase: 'off', targetId: null, silent: false,
    config: {sweepSec: 2}, contacts: [], lastLostSequence: 0
  };
  return {id: 'blue-1', radar};
}
function run(state, unit, world, seconds = 5, stepSeconds = .05) {
  for (let t = 0; t < seconds; t += stepSeconds) { world.time += stepSeconds; tickRadarTutorial(state, unit, world); }
}

test('教程步骤表：共 12 步，最后是判断题', () => {
  assert.equal(RADAR_TUTORIAL_STEPS.length, 12);
  assert.equal(RADAR_TUTORIAL_STEPS[0].id, 'ready');
  assert.equal(stepId(createRadarTutorialState()), 'ready');
  assert.equal(RADAR_TUTORIAL_STEPS.at(-1).kind, 'quiz');
});

test('第 1 步自动过，开机后第 2 步过', () => {
  const world = fakeWorld(), unit = fakeUnit(), state = createRadarTutorialState();
  enterRadarTutorialStep(state, unit, world);
  run(state, unit, world, 2);
  assert.equal(state.phase, 'success');
  assert(advanceRadarTutorial(state, unit, world));
  assert.equal(stepId(state), 'search');
  unit.radar.mode = 'pd'; unit.radar.phase = 'search';
  run(state, unit, world, .3);
  assert.equal(state.phase, 'success');
});

test('发现航迹 / 两条航迹 / 锁定 2 秒', () => {
  const world = fakeWorld(), unit = fakeUnit(), state = createRadarTutorialState();
  state.index = 2; enterRadarTutorialStep(state, unit, world); // contact
  const contact = {id: 'tgt-1', observedAt: 0};
  unit.radar.contacts = [contact];
  world.time = 1; tickRadarTutorial(state, unit, world);
  assert.equal(state.phase, 'success');
  assert(advanceRadarTutorial(state, unit, world));
  assert.equal(stepId(state), 'multi');
  unit.radar.contacts = [contact, {id: 'tgt-2', observedAt: 1}];
  world.time = 2; tickRadarTutorial(state, unit, world);
  assert.equal(state.phase, 'success');
  assert(advanceRadarTutorial(state, unit, world));
  assert.equal(stepId(state), 'lock');
  unit.radar.phase = 'locked'; unit.radar.targetId = 'tgt-1';
  run(state, unit, world, 2.2);
  assert.equal(state.phase, 'success');
  assert(advanceRadarTutorial(state, unit, world));
  assert.equal(stepId(state), 'lost');
});

test('横切丢锁步骤会设置靶机横切，并在 coasting 时通过', () => {
  const world = fakeWorld(), unit = fakeUnit(), state = createRadarTutorialState();
  state.index = 5; unit.radar.targetId = 'tgt-1'; world.radarTargets = [{id: 'tgt-1', alive: true}];
  enterRadarTutorialStep(state, unit, world);
  assert.deepEqual(world.aspects.at(-1), ['blue-1', 'tgt-1', 'crossing']);
  unit.radar.phase = 'coasting';
  world.time = 1; tickRadarTutorial(state, unit, world);
  assert.equal(state.phase, 'success');
});

test('RWR 步骤生成跟踪演练源，收到告警才通过', () => {
  const world = fakeWorld(), unit = fakeUnit(), state = createRadarTutorialState();
  world.addRwrPracticeEmitter = (id, mode) => { world.emitter = { id, mode }; };
  unit.rwr = { contacts: [] };
  state.index = 9; enterRadarTutorialStep(state, unit, world);
  assert.deepEqual(world.emitter, { id: 'blue-1', mode: 'track' });
  unit.rwr.contacts = [{ observedAt: 0, level: 'track', bearingDeg: 45 }];
  world.time = 1; tickRadarTutorial(state, unit, world);
  assert.equal(state.phase, 'success');
});
test('静默步骤 + 判断题答案', () => {
  const world = fakeWorld(), unit = fakeUnit(), state = createRadarTutorialState();
  state.index = 10; enterRadarTutorialStep(state, unit, world);
  unit.radar.silent = true; world.time = 1; tickRadarTutorial(state, unit, world);
  assert.equal(state.phase, 'success');
  assert(advanceRadarTutorial(state, unit, world));
  assert.equal(stepId(state), 'quiz');
  assert.equal(answerRadarTutorial(state, 'range'), false);
  assert.match(state.feedback, /距离/);
  assert.equal(answerRadarTutorial(state, 'gate'), true);
  assert.equal(state.phase, 'success');
  assert.equal(advanceRadarTutorial(state, unit, world), false);
  assert.equal(state.phase, 'done');
});
