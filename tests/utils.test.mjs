import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const { TJ } = loadTradeJournal();
const U = TJ.utils;

function roundTrip(date, time, zone) {
  const utc = U.zonedToUtc(date, time, zone);
  const back = utc ? U.utcToZoned(utc, zone) : null;
  return { utc: utc, back: back };
}

test('Berlin DST gap resolves deterministically and close to the requested time', function () {
  const first = roundTrip('2026-03-29', '02:30', 'Europe/Berlin');
  const second = roundTrip('2026-03-29', '02:30', 'Europe/Berlin');

  assert.equal(first.utc, '2026-03-29T01:30:00.000Z');
  assert.equal(second.utc, first.utc);
  assert.equal(first.back.date, '2026-03-29');
  assert.equal(first.back.time, '03:30');
});

test('Berlin ambiguous time always selects the same occurrence', function () {
  const first = roundTrip('2026-10-25', '02:30', 'Europe/Berlin');
  const second = roundTrip('2026-10-25', '02:30', 'Europe/Berlin');

  // The later occurrence (CET, UTC+1) is selected.
  assert.equal(first.utc, '2026-10-25T01:30:00.000Z');
  assert.equal(second.utc, first.utc);
  assert.equal(first.back.date, '2026-10-25');
  assert.equal(first.back.time, '02:30');
});

test('New York DST gap resolves deterministically and close to the requested time', function () {
  const first = roundTrip('2026-03-08', '02:30', 'America/New_York');
  const second = roundTrip('2026-03-08', '02:30', 'America/New_York');

  assert.equal(first.utc, '2026-03-08T06:30:00.000Z');
  assert.equal(second.utc, first.utc);
  assert.equal(first.back.date, '2026-03-08');
  assert.equal(first.back.time, '01:30');
});

test('New York ambiguous time always selects the same occurrence', function () {
  const first = roundTrip('2026-11-01', '01:30', 'America/New_York');
  const second = roundTrip('2026-11-01', '01:30', 'America/New_York');

  // The earlier occurrence (EDT, UTC-4) is selected.
  assert.equal(first.utc, '2026-11-01T05:30:00.000Z');
  assert.equal(second.utc, first.utc);
  assert.equal(first.back.date, '2026-11-01');
  assert.equal(first.back.time, '01:30');
});

test('ordinary wall-clock times round-trip through UTC', function () {
  const cases = [
    ['2026-01-15', '14:30', 'Europe/Berlin'],
    ['2026-07-15', '14:30', 'Europe/Berlin'],
    ['2026-01-15', '10:30', 'America/New_York'],
    ['2026-07-15', '10:30', 'America/New_York']
  ];

  cases.forEach(function (item) {
    const result = roundTrip(item[0], item[1], item[2]);
    assert.equal(result.back.date, item[0]);
    assert.equal(result.back.time, item[1]);
  });
});

test('Moscow and Almaty do not observe DST', function () {
  const moscowWinter = roundTrip('2026-01-15', '12:00', 'Europe/Moscow');
  const moscowSummer = roundTrip('2026-07-15', '12:00', 'Europe/Moscow');
  const almatyWinter = roundTrip('2026-01-15', '12:00', 'Asia/Almaty');
  const almatySummer = roundTrip('2026-07-15', '12:00', 'Asia/Almaty');

  assert.equal(moscowWinter.utc, '2026-01-15T09:00:00.000Z');
  assert.equal(moscowSummer.utc, '2026-07-15T09:00:00.000Z');
  assert.equal(moscowWinter.back.time, '12:00');
  assert.equal(moscowSummer.back.time, '12:00');

  assert.equal(almatyWinter.utc, '2026-01-15T07:00:00.000Z');
  assert.equal(almatySummer.utc, '2026-07-15T07:00:00.000Z');
  assert.equal(almatyWinter.back.time, '12:00');
  assert.equal(almatySummer.back.time, '12:00');
});
