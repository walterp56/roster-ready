import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstOverlappingPair, shiftTimesOverlap } from './shift-times.ts';

const buy = { name: 'Buy', startTime: '20:53', endTime: '22:53' };
const cook = { name: 'Cook', startTime: '20:56', endTime: '21:57' };
const close = { name: 'Close', startTime: '22:53', endTime: '23:30' };
const prepare = { name: 'Prepare', startTime: '18:00', endTime: '19:00' };

test('shift overlap is symmetric and includes containment and identical times', () => {
  assert.equal(shiftTimesOverlap(buy, cook), true);
  assert.equal(shiftTimesOverlap(cook, buy), true);
  assert.equal(shiftTimesOverlap(buy, { ...buy }), true);
});

test('back-to-back shifts and shifts separated by a gap do not overlap', () => {
  assert.equal(shiftTimesOverlap(buy, close), false);
  assert.equal(shiftTimesOverlap(close, buy), false);
  assert.equal(shiftTimesOverlap(prepare, buy), false);
});

test('finds an overlap in unsorted input without changing the original order', () => {
  const originalOrder = [close, cook, prepare, buy];
  const shifts = Object.freeze([...originalOrder]);
  assert.deepEqual(firstOverlappingPair(shifts), [buy, cook]);
  assert.deepEqual(shifts, originalOrder);
  assert.equal(firstOverlappingPair([close, prepare, buy]), undefined);
  assert.equal(firstOverlappingPair([buy]), undefined);
  assert.equal(firstOverlappingPair([]), undefined);
});
