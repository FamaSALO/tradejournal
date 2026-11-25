import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';
import { fakeDocument } from './helpers/fake-dom.mjs';

function loadApp(extraElements) {
  const doc = fakeDocument();
  doc.readyState = 'loading';
  const elements = Object.assign({}, extraElements || {});
  const baseQuery = doc.querySelector;
  doc.querySelector = function (selector) {
    if (Object.prototype.hasOwnProperty.call(elements, selector)) {
      return elements[selector];
    }
    return baseQuery.call(doc, selector);
  };
  return loadTradeJournal(['js/app.js'], {
    globals: { document: doc }
  });
}

test('buildInsights reports the weakest weekday when >= 2 weekdays have >= 2 trades', function () {
  const { TJ } = loadApp();
  const store = TJ.store;
  // 2026-01-05 is Monday, 2026-01-06 is Tuesday
  const trades = [
    store.normalizeTrade({
      id: 'm1', date: '2026-01-05', symbol: 'EURUSD', side: 'long',
      entry: 100, stop: 95, qty: 1, exits: [{ qty: 1, price: 80, date: '2026-01-05' }]
    }),
    store.normalizeTrade({
      id: 'm2', date: '2026-01-05', symbol: 'EURUSD', side: 'long',
      entry: 100, stop: 95, qty: 1, exits: [{ qty: 1, price: 90, date: '2026-01-05' }]
    }),
    store.normalizeTrade({
      id: 't1', date: '2026-01-06', symbol: 'GBPUSD', side: 'long',
      entry: 100, stop: 95, qty: 1, exits: [{ qty: 1, price: 115, date: '2026-01-06' }]
    }),
    store.normalizeTrade({
      id: 't2', date: '2026-01-06', symbol: 'GBPUSD', side: 'long',
      entry: 100, stop: 95, qty: 1, exits: [{ qty: 1, price: 105, date: '2026-01-06' }]
    })
  ];

  const m = store.metrics(trades, 10000);
  const insights = TJ.app.buildInsights(m);
  const weakest = insights.find(function (item) {
    return item.text.indexOf('Самый слабый день') !== -1;
  });
  assert.ok(weakest, 'expected weakest weekday insight to be present');
  assert.match(weakest.text, /<b>Пн<\/b>/);
  assert.match(weakest.text, /30[,.]00/);
});

test('renderDiscipline flags daily loss limit even when todayTrades is empty, and ignores future dates', function () {
  const disciplineBody = { innerHTML: '' };
  const { TJ } = loadApp({ '#disciplineBody': disciplineBody });
  const store = TJ.store;
  const tz = store.state.settings.timezone;
  const today = TJ.utils.todayISO(tz);
  const yesterday = TJ.utils.addDaysISO(today, -1);
  const tomorrow = TJ.utils.addDaysISO(today, 1);

  store.state.settings = Object.assign({}, store.state.settings, {
    startBalance: 10000,
    dailyLossLimit: 3,
    maxTradesPerDay: 3
  });
  store.state.trades = [
    store.normalizeTrade({
      id: 'yesterday-closed-today',
      date: yesterday,
      symbol: 'EURUSD',
      side: 'long',
      entry: 100,
      qty: 10,
      exits: [{ qty: 10, price: 65, date: today }]
    }),
    store.normalizeTrade({
      id: 'future-trade',
      date: tomorrow,
      symbol: 'EURUSD',
      side: 'long',
      entry: 100,
      qty: 10,
      exits: [{ qty: 10, price: 600, date: tomorrow }]
    })
  ];

  const snap = TJ.app.disciplineSnapshot();
  assert.equal(snap.todayTrades.length, 0);
  assert.equal(snap.startOfDayBalance, 10000);
  assert.equal(snap.lossLimit, 300);
  assert.equal(snap.dayPnl, -350);

  TJ.app.renderDiscipline();
  assert.match(disciplineBody.innerHTML, /class="rule-status bad"/);
  assert.match(disciplineBody.innerHTML, /Дневной лимит убытка достигнут/);
});
