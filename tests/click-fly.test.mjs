import test from 'node:test';
import assert from 'node:assert/strict';
import {HEIGHT_BANDS,heightForMode,bandLabel,modalAltitudeText,orderSummary,etaSeconds,formatEta,formatPreviewDistance,previewLabel} from '../game/click-fly-model.js';

test('高度档：低/中/高与当前高度', () => {
  assert.deepEqual(HEIGHT_BANDS, {low: 1500, mid: 6000, high: 10000});
  assert.equal(heightForMode('low', 5000), 1500);
  assert.equal(heightForMode('mid', 5000), 6000);
  assert.equal(heightForMode('high', 5000), 10000);
  assert.equal(heightForMode('current', 5123.4), 5123.4);
  assert.equal(heightForMode('current', 0), 300);
});

test('高度档：非法模式回落到当前高度并带下限', () => {
  assert.equal(heightForMode('nope', 4000), 4000);
  assert.equal(heightForMode('nope', 100), 300);
});

test('文案与指令摘要', () => {
  assert.equal(bandLabel('low'), '低');
  assert.equal(bandLabel('current'), '当前');
  assert.equal(modalAltitudeText('mid', 0), '高度 6000 m');
  assert.equal(modalAltitudeText('current', 5344), '高度 5340 m');
  assert.equal(orderSummary(false, 1500), '覆盖航路 · 高度 1500 m');
  assert.equal(orderSummary(true, 10000), '追加航点 · 高度 10000 m');
});

test('悬停预览：距离/ETA/高度文案', () => {
  assert.equal(etaSeconds(8000, 200), 40);
  assert.equal(etaSeconds(8000, 0), Infinity);
  assert.equal(formatEta(40), '40 秒');
  assert.equal(formatEta(90), '1 分 30 秒');
  assert.equal(formatEta(120), '2 分');
  assert.equal(formatPreviewDistance(800), '800 m');
  assert.equal(formatPreviewDistance(8000), '8.0 km');
  assert.equal(previewLabel(8000, 200, 6500), '8.0 km · ETA 40 秒 · 6500 m');
  assert.equal(previewLabel(8000, 0, 6500), '8.0 km · ETA — · 6500 m');
});
