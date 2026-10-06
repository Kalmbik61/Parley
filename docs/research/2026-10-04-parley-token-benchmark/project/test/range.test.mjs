import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sumRange } from '../src/range.js';

test('sumRange включает обе границы', () => {
  assert.equal(sumRange(1, 4), 10);
  assert.equal(sumRange(3, 3), 3);
});
