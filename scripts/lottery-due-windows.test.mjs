import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATCH_UP_GRACE_MINUTES,
  DATA_POLL_SCHEDULES,
  duePollWindow,
} from './lottery-due-windows.mjs';

const loto7 = DATA_POLL_SCHEDULES.find((schedule) => schedule.gameId === 'loto7_jp');
const powerball = DATA_POLL_SCHEDULES.find((schedule) => schedule.gameId === 'powerball');

test('keeps Loto 7 due after GitHub misses all regular windows', () => {
  const poll = duePollWindow(new Date('2026-06-12T14:09:00Z'), loto7);

  assert.equal(poll?.targetDrawDate, '2026-06-12');
  assert.equal(poll?.offsetMinutes, 180);
  assert.equal(poll?.catchUp, true);
});

test('keeps Powerball due after a delayed scheduled run', () => {
  const poll = duePollWindow(new Date('2026-06-11T08:44:00Z'), powerball);

  assert.equal(poll?.targetDrawDate, '2026-06-10');
  assert.equal(poll?.catchUp, true);
});

test('stops catch-up after the bounded grace period', () => {
  const afterGrace = new Date(
    Date.parse('2026-06-12T13:45:00Z') + (CATCH_UP_GRACE_MINUTES + 1) * 60000,
  );

  assert.equal(duePollWindow(afterGrace, loto7), null);
});
