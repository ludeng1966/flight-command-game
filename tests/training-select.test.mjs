import test from 'node:test';
import assert from 'node:assert/strict';
import {levelCards, levelUrl, examUrl, radarTutorialCard, menuUrl} from '../game/training-select-model.js';

test('选关页：三关按顺序，带步骤数与入口类型', () => {
  const cards = levelCards();
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.number), [1, 2, 3]);
  assert.deepEqual(cards.map((c) => c.id), ['communications', 'departure', 'navigation']);
  for (const card of cards) {
    assert.ok(card.steps > 0);
    assert.equal(card.url, levelUrl(card.id));
    assert.match(card.url, /\?training=guided&level=/);
  }
  assert.equal(cards[2].entry, 'airborne');
  assert.equal(cards[0].entryLabel, '从机位开始');
  assert.equal(cards[2].entryLabel, '空中场景开始');
});

test('选关页：通过状态来自进度，不影响入口地址', () => {
  const cards = levelCards({departure: {passed: true}});
  assert.equal(cards[0].passed, false);
  assert.equal(cards[1].passed, true);
  assert.equal(cards[2].passed, false);
  assert.equal(cards[1].url, './?training=guided&level=departure');
});

test('选关页：雷达教程为第 4 关，可直接进入', () => {
  const card = radarTutorialCard();
  assert.equal(card.number, 4);
  assert.equal(card.title, '紧急起飞识别');
  assert.equal(card.disabled, false);
  assert.equal(card.url, './?tutorial=emergency');
});

test('选关页：综合考核与主菜单地址', () => {
  assert.equal(examUrl(), './?training=exam');
  assert.equal(menuUrl(), './menu.html');
});
