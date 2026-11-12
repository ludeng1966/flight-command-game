import test from 'node:test';
import assert from 'node:assert/strict';
import {createRwr} from '../sim/rwr.js';

test('RWR 数字化三档：高/中/低可用，非法档位报错', () => {
  for (const level of ['high', 'mid', 'low']) assert.equal(createRwr('f16', {digitalLevel: level}).config.digitalLevel, level);
  assert.throws(() => createRwr('f16', {digitalLevel: 'ultra'}), /数字化档位无效/);
  assert.equal(createRwr('f16').config.digitalLevel, 'high');
});
