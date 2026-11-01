import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const { TJ } = loadTradeJournal();
const store = TJ.store;

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
  assert.equal(store.SCHEMA_VERSION, 3);
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
