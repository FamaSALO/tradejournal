import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const { TJ } = loadTradeJournal();
const store = TJ.store;
const U = TJ.utils;

function trade(overrides) {
  return store.normalizeTrade(Object.assign({
    id: 'trade-1',
    date: '2026-01-05',
    time: '10:30',
    symbol: 'EURUSD',
    side: 'long',
    entry: 100,
    stop: 95,
    target: 110,
    qty: 10,
    multiplier: 1,
    fees: 0
  }, overrides || {}));
}

test('legacy exit migrates to a single canonical exit', function () {
  const normalized = trade({ exit: 110, fees: 5 });
  assert.equal(store.SCHEMA_VERSION, 4);
  assert.equal(normalized.exits.length, 1);
  assert.equal(normalized.exits[0].qty, 10);
  assert.equal(normalized.exits[0].price, 110);
  assert.equal(normalized.exits[0].fees, 5);
  assert.equal(normalized.exit, 110);
  assert.equal(store.tradeStatus(normalized), 'closed');
  assert.equal(store.tradePnl(normalized), 95);
});

test('legacy exit without quantity is preserved without inventing P&L', function () {
  const normalized = trade({ qty: undefined, exit: 110 });
  assert.equal(normalized.exits.length, 0);
  assert.equal(normalized.exit, 110);
  assert.equal(store.tradePnl(normalized), null);
  assert.equal(store.normalizeTrade(normalized).exit, 110);
});

test('partial exits stay open and keep the realized P&L', function () {
  const normalized = trade({
    qty: 10,
    fees: 7,
    exits: [
      { id: 'e1', qty: 4, price: 110, date: '2026-01-05' },
      { id: 'e2', qty: 3, price: 120, date: '2026-01-06' }
    ]
  });
  assert.equal(normalized.exit, null);
  assert.equal(store.remainingQty(normalized), 3);
  assert.equal(store.exitedQty(normalized), 7);
  assert.equal(store.isPartial(normalized), true);
  assert.equal(store.isClosed(normalized), false);
  assert.equal(store.tradeStatus(normalized), 'partial');
  assert.equal(store.weightedExit(normalized), 800 / 7);
  assert.equal(store.tradePnl(normalized), 93);
  assert.equal(store.tradeFees(normalized), 7);
  assert.equal(normalized.exits[0].fees, 4);
  assert.equal(normalized.exits[1].fees, 3);
});

test('fees are allocated proportionally and the last exit gets the remainder', function () {
  const normalized = trade({
    qty: 3,
    fees: 10,
    exits: [
      { qty: 1, price: 100 },
      { qty: 2, price: 100 }
    ]
  });
  assert.equal(normalized.exits[0].fees, 3.33333333);
  assert.equal(normalized.exits[1].fees, 6.66666667);
  assert.equal(store.tradeFees(normalized), 10);
});

test('open trades have no realized P&L and no exit price', function () {
  const normalized = trade({ qty: 10, exits: [] });
  assert.equal(normalized.exits.length, 0);
  assert.equal(normalized.exit, null);
  assert.equal(store.tradeStatus(normalized), 'open');
  assert.equal(store.tradePnl(normalized), null);
  assert.equal(store.hasRealized(normalized), false);
  assert.equal(store.remainingQty(normalized), 10);
  assert.equal(store.openRisk(normalized), 50);
});

test('contract multiplier scales P&L and risk', function () {
  const normalized = trade({
    qty: 2,
    multiplier: 10,
    stop: 95,
    exits: [{ qty: 2, price: 105 }]
  });
  assert.equal(normalized.multiplier, 10);
  assert.equal(store.tradePnl(normalized), 100);
  assert.equal(store.tradeRisk(normalized), 100);
  assert.equal(store.tradeR(normalized), 1);
});

test('multiplier is bounded and invalid values fall back to one', function () {
  assert.equal(store.normalizeMultiplier(0), 1);
  assert.equal(store.normalizeMultiplier(-4), 1);
  assert.equal(store.normalizeMultiplier('abc'), 1);
  assert.equal(store.normalizeMultiplier('2.5'), 2.5);
  assert.equal(store.normalizeMultiplier(1e12), store.MULTIPLIER_MAX);
});

test('trade normalization is idempotent', function () {
  const first = trade({
    qty: 10,
    fees: 4.5,
    exits: [
      { id: 'e1', qty: 4, price: 110, date: '2026-01-05' },
      { id: 'e2', qty: 6, price: 108, date: '2026-01-06' }
    ]
  });
  const second = store.normalizeTrade(first);
  assert.deepEqual(second, first);
});

test('analyzeImport reports every loss before the journal is replaced', function () {
  const raw = {
    accounts: [{
      trades: [
        {
          id: 'ok',
          date: '2026-01-05',
          symbol: 'EURUSD',
          side: 'long',
          entry: 1,
          qty: 1,
          screenshot: 'data:image/png;base64,AAAA'
        },
        {
          id: 'no-symbol',
          date: '2026-01-05',
          symbol: '',
          side: 'long',
          entry: 1,
          qty: 1
        },
        {
          id: 'bad-format',
          date: '2026-01-05',
          symbol: 'BTCUSD',
          side: 'long',
          entry: 1,
          qty: 1,
          screenshot: 'data:image/gif;base64,AAAA'
        },
        {
          id: 'too-large',
          date: '2026-01-05',
          symbol: 'ETHUSD',
          side: 'long',
          entry: 1,
          qty: 1,
          screenshot: 'data:image/png;base64,' + 'A'.repeat(3000000)
        }
      ],
      notes: [
        { id: 'n1', date: '2026-01-05', text: 'ok' },
        { id: 'n2', date: '2026-01-05', text: '' }
      ]
    }]
  };

  const stats = store.analyzeImport(raw);
  assert.equal(stats.trades, 4);
  assert.equal(stats.tradesAccepted, 3);
  assert.equal(stats.tradesDropped, 1);
  assert.equal(stats.missingSymbols, 1);
  assert.equal(stats.notes, 2);
  assert.equal(stats.notesAccepted, 1);
  assert.equal(stats.notesDropped, 1);
  assert.equal(stats.screenshots, 3);
  assert.equal(stats.screenshotsAccepted, 1);
  assert.equal(stats.screenshotsDropped, 2);
  assert.equal(stats.screenshotsInvalid, 1);
  assert.equal(stats.screenshotsTooLarge, 1);
});

test('metrics include realized partial trades and count partials separately', function () {
  const closed = trade({ id: 'closed', exit: 110, fees: 5 });
  const partial = trade({
    id: 'partial',
    qty: 10,
    fees: 7,
    exits: [
      { qty: 4, price: 110 },
      { qty: 3, price: 120 }
    ]
  });
  const open = trade({ id: 'open', qty: 10, exits: [] });

  const m = store.metrics([closed, partial, open], 1000);
  assert.equal(m.count, 2);
  assert.equal(m.partials, 1);
  assert.equal(m.closed.length, 1);
  assert.equal(m.net, 188);
  assert.equal(m.endBalance, 1188);
  assert.equal(m.rows.length, 2);
  assert.equal(m.fees, 12);
});

test('converts wall-clock time between UTC and IANA timezones', function () {
  assert.equal(U.zonedToUtc('2026-01-15', '14:30', 'Europe/Moscow'), '2026-01-15T11:30:00.000Z');
  const zoned = U.utcToZoned('2026-01-15T11:30:00.000Z', 'Europe/Moscow');
  assert.equal(zoned.date, '2026-01-15');
  assert.equal(zoned.time, '14:30');
  assert.equal(U.zonedToUtc('2026-07-15', '10:30', 'America/New_York'), '2026-07-15T14:30:00.000Z');
  assert.equal(U.zonedToUtc('2026-01-15', '10:30', 'America/New_York'), '2026-01-15T15:30:00.000Z');
  assert.equal(U.validTimeZone('Europe/Moscow'), true);
  assert.equal(U.validTimeZone('Not/AZone'), false);
});

test('trade time is stored in UTC and rendered in the account timezone', function () {
  const normalized = store.normalizeTrade({
    id: 'tz-1',
    date: '2026-01-15',
    time: '14:30',
    symbol: 'EURUSD',
    side: 'long',
    entry: 1,
    qty: 1
  }, { timeZone: 'Europe/Moscow' });

  assert.equal(normalized.timeUtc, '2026-01-15T11:30:00.000Z');
  assert.equal(normalized.date, '2026-01-15');
  assert.equal(normalized.time, '14:30');

  const shifted = store.normalizeTrade(normalized, { timeZone: 'America/New_York' });
  assert.equal(shifted.timeUtc, '2026-01-15T11:30:00.000Z');
  assert.equal(shifted.date, '2026-01-15');
  assert.equal(shifted.time, '06:30');
});

test('session boundaries are configurable and wrap around midnight', function () {
  assert.equal(U.sessionOf('08:59'), 'Азия');
  assert.equal(U.sessionOf('09:00'), 'Лондон');
  assert.equal(U.sessionOf('13:00'), 'Нью-Йорк');
  assert.equal(U.sessionOf('18:00'), 'Вечер');
  assert.equal(U.sessionOf(''), 'Без времени');

  const custom = [
    { key: 'asia', name: 'Азия', start: '01:00' },
    { key: 'london', name: 'Лондон', start: '08:00' },
    { key: 'newYork', name: 'Нью-Йорк', start: '14:00' },
    { key: 'evening', name: 'Вечер', start: '21:00' }
  ];
  assert.equal(U.sessionOf('00:30', custom), 'Вечер');
  assert.equal(U.sessionOf('01:00', custom), 'Азия');
  assert.equal(U.sessionOf('09:15', custom), 'Лондон');
  assert.equal(U.sessionNames(custom).join(','), 'Азия,Лондон,Нью-Йорк,Вечер');
});

test('import drops broken dates instead of replacing them with today', async function () {
  const raw = {
    accounts: [{
      settings: { timezone: 'Europe/Moscow' },
      trades: [
        { id: 'ok', date: '2026-01-15', time: '14:30', symbol: 'EURUSD', side: 'long', entry: 1, qty: 1 },
        { id: 'bad-date', date: '2026-02-31', time: '10:00', symbol: 'BTCUSD', side: 'long', entry: 1, qty: 1 },
        { id: 'no-symbol', date: '2026-01-15', symbol: '', side: 'long', entry: 1, qty: 1 },
        { id: 'ok-2', date: '2026-01-16', symbol: 'ETHUSD', side: 'short', entry: 2, qty: 2 }
      ],
      notes: []
    }]
  };

  const stats = store.analyzeImport(raw);
  assert.equal(stats.trades, 4);
  assert.equal(stats.tradesAccepted, 2);
  assert.equal(stats.tradesDropped, 2);
  assert.equal(stats.invalidDates, 1);
  assert.equal(stats.missingSymbols, 1);

  const { TJ: fresh } = loadTradeJournal();
  assert.equal(await fresh.store.replaceData(raw, { strictDate: true }), true);
  assert.equal(fresh.store.state.trades.length, 2);
  assert.equal(fresh.store.state.trades[0].timeUtc, '2026-01-15T11:30:00.000Z');
  assert.equal(fresh.store.state.trades[0].date, '2026-01-15');
});

test('schema v3 journal migrates to v4 with UTC time and keeps the timezone', async function () {
  const { TJ: fresh, storage } = loadTradeJournal();
  storage.setItem(fresh.store.KEY, JSON.stringify({
    version: 3,
    accounts: [{
      id: 'acc',
      name: 'Основной счёт',
      settings: { currency: '$', timezone: 'Europe/Moscow' },
      trades: [{
        id: 'legacy',
        date: '2026-01-15',
        time: '01:30',
        symbol: 'EURUSD',
        side: 'long',
        entry: 1,
        qty: 1
      }],
      notes: []
    }]
  }));

  assert.equal(await fresh.store.load(), true);
  assert.equal(fresh.store.state.version, 4);
  assert.equal(fresh.store.state.settings.timezone, 'Europe/Moscow');
  const migrated = fresh.store.state.trades[0];
  assert.equal(migrated.timeUtc, '2026-01-14T22:30:00.000Z');
  assert.equal(migrated.date, '2026-01-15');
  assert.equal(migrated.time, '01:30');

  fresh.store.state.settings = Object.assign({}, fresh.store.state.settings, {
    timezone: 'America/New_York'
  });
  assert.equal(migrated.date, '2026-01-14');
  assert.equal(migrated.time, '17:30');
});

test('v3 trade without a timezone keeps its wall-clock date and time after migration', async function () {
  const { TJ: fresh, storage } = loadTradeJournal();
  const systemZone = fresh.utils.systemTimeZone();
  storage.setItem(fresh.store.KEY, JSON.stringify({
    version: 3,
    accounts: [{
      id: 'acc',
      name: 'Основной счёт',
      settings: { currency: '$' },
      trades: [{
        id: 'legacy',
        date: '2026-01-15',
        time: '10:30',
        symbol: 'EURUSD',
        side: 'long',
        entry: 1,
        qty: 1
      }],
      notes: []
    }]
  }));
  assert.equal(await fresh.store.load(), true);
  const migrated = fresh.store.state.trades[0];
  assert.equal(migrated.date, '2026-01-15');
  assert.equal(migrated.time, '10:30');
  assert.equal(migrated.timeUtc, fresh.utils.zonedToUtc('2026-01-15', '10:30', systemZone));
});
