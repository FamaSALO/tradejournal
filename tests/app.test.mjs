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

test('getFilteredTrades sorts partial trades by weighted exit price and keeps open trades last', function () {
  const { TJ } = loadApp();
  const store = TJ.store;
  const open = store.normalizeTrade({
    id: 'open', date: '2026-01-05', symbol: 'EURUSD', side: 'long', entry: 100, qty: 10, exits: []
  });
  const closedLow = store.normalizeTrade({
    id: 'closed-low', date: '2026-01-05', symbol: 'EURUSD', side: 'long', entry: 100, qty: 10,
    exits: [{ qty: 10, price: 105 }]
  });
  const partialMid = store.normalizeTrade({
    id: 'partial-mid', date: '2026-01-05', symbol: 'EURUSD', side: 'long', entry: 100, qty: 10,
    exits: [{ qty: 2, price: 110 }, { qty: 2, price: 120 }]
  }); // weighted = 115
  const closedHigh = store.normalizeTrade({
    id: 'closed-high', date: '2026-01-05', symbol: 'EURUSD', side: 'long', entry: 100, qty: 10,
    exits: [{ qty: 10, price: 130 }]
  });

  store.state.trades = [open, closedHigh, closedLow, partialMid];
  TJ.app.state.sort = { key: 'exit', dir: 'asc' };
  assert.deepEqual(
    TJ.app.getFilteredTrades().map(function (t) { return t.id; }),
    ['closed-low', 'partial-mid', 'closed-high', 'open']
  );

  TJ.app.state.sort = { key: 'exit', dir: 'desc' };
  assert.deepEqual(
    TJ.app.getFilteredTrades().map(function (t) { return t.id; }),
    ['closed-high', 'partial-mid', 'closed-low', 'open']
  );
});

test('collectExitRows skips empty exit rows even when date is prefilled and validates half-filled rows', function () {
  const { TJ } = loadApp();
  TJ.app.state.tradeExits = [
    { id: 'empty', qty: '', price: '', date: '2026-01-05' },
    { id: 'valid', qty: '5', price: '110', date: '2026-01-06' }
  ];
  const ok = TJ.app.collectExitRows('2026-01-05');
  assert.equal(ok.error, undefined);
  assert.equal(ok.exits.length, 1);
  assert.equal(ok.exits[0].qty, 5);

  TJ.app.state.tradeExits = [{ id: 'only-qty', qty: '5', price: '', date: '2026-01-05' }];
  const missingPrice = TJ.app.collectExitRows('2026-01-05');
  assert.match(missingPrice.error, /цену выхода/);

  TJ.app.state.tradeExits = [{ id: 'only-price', qty: '', price: '110', date: '2026-01-05' }];
  const missingQty = TJ.app.collectExitRows('2026-01-05');
  assert.match(missingQty.error, /количество/);
});

test('calcUpdate validates negative risk, non-positive entry, same-side target and scales notional by pointValue', function () {
  const els = {
    '#calcBalance': { value: '10000' },
    '#calcRisk': { value: '1' },
    '#calcEntry': { value: '100' },
    '#calcStop': { value: '95' },
    '#calcTarget': { value: '110' },
    '#calcPointValue': { value: '2' },
    '#calcQtyValue': { textContent: '' },
    '#calcNotional': { textContent: '' },
    '#calcRiskAmount': { textContent: '' },
    '#calcLoss': { textContent: '' },
    '#calcProfit': { textContent: '' },
    '#calcRR': { textContent: '' },
    '#calcError': { hidden: true, textContent: '' },
    '#rrVisual': { hidden: true },
    '#rrRisk': { style: { flexBasis: '' } },
    '#rrReward': { style: { flexBasis: '' } },
    '#rrRisk span': { textContent: '' },
    '#rrReward span': { textContent: '' },
    '#calcHint': { textContent: '', style: { display: '' } }
  };
  const { TJ } = loadApp(els);

  TJ.app.calcUpdate();
  assert.equal(els['#calcError'].hidden, true);
  assert.equal(els['#calcQtyValue'].textContent, '10');
  assert.match(els['#calcNotional'].textContent, /2[\s\u00a0]?000/);
  assert.equal(els['#rrVisual'].hidden, false);

  els['#calcRisk'].value = '-1';
  TJ.app.calcUpdate();
  assert.equal(els['#calcError'].hidden, false);
  assert.equal(els['#calcQtyValue'].textContent, '—');
  assert.equal(els['#calcLoss'].textContent, '—');
  assert.equal(els['#calcRR'].textContent, '—');
  assert.equal(els['#rrVisual'].hidden, true);

  els['#calcRisk'].value = '1';
  els['#calcTarget'].value = '90';
  TJ.app.calcUpdate();
  assert.equal(els['#calcError'].hidden, false);
  assert.equal(els['#calcQtyValue'].textContent, '—');
  assert.equal(els['#calcProfit'].textContent, '—');
  assert.equal(els['#calcRR'].textContent, '—');
  assert.equal(els['#rrVisual'].hidden, true);

  els['#calcTarget'].value = '110';
  els['#calcEntry'].value = '0';
  TJ.app.calcUpdate();
  assert.equal(els['#calcError'].hidden, false);
  assert.equal(els['#calcQtyValue'].textContent, '—');
});

test('openModal/closeModal preserves nested focus stack and traps Tab inside top modal', function () {
  const triggerBtn = {
    id: 'newTradeBtn',
    focused: false,
    focus: function () { this.focused = true; doc.activeElement = this; },
    closest: function () { return null; }
  };
  const saveBtn = {
    id: 'saveTradeBtn',
    focused: false,
    focus: function () { this.focused = true; doc.activeElement = this; },
    closest: function () { return null; }
  };
  const cancelBtn = {
    id: 'confirmCancel',
    focused: false,
    focus: function () { this.focused = true; doc.activeElement = this; },
    closest: function () { return null; }
  };
  const okBtn = {
    id: 'confirmOk',
    focused: false,
    focus: function () { this.focused = true; doc.activeElement = this; },
    closest: function () { return null; }
  };
  const confirmPanel = {
    querySelectorAll: function () { return [cancelBtn, okBtn]; },
    contains: function (el) { return el === cancelBtn || el === okBtn; }
  };
  const tradePanel = {
    querySelectorAll: function () { return [saveBtn]; },
    contains: function (el) { return el === saveBtn; }
  };
  const tradeModal = {
    id: 'tradeModal',
    hidden: true,
    querySelector: function (sel) { return sel === '.modal-panel' ? tradePanel : null; }
  };
  const confirmModal = {
    id: 'confirmModal',
    hidden: true,
    querySelector: function (sel) { return sel === '.modal-panel' ? confirmPanel : null; }
  };

  const doc = fakeDocument();
  doc.readyState = 'loading';
  doc.body = { classList: { toggle: function () {} } };
  doc.activeElement = triggerBtn;
  doc.contains = function () { return true; };
  doc.getElementById = function (id) {
    if (id === 'tradeModal') return tradeModal;
    if (id === 'confirmModal') return confirmModal;
    return null;
  };
  doc.querySelectorAll = function (sel) {
    if (sel === '.modal') return [tradeModal, confirmModal];
    return [];
  };
  const origQuery = doc.querySelector;
  doc.querySelector = function (sel, root) {
    if (sel === '.modal-panel' && root) return root.querySelector('.modal-panel');
    return origQuery.call(doc, sel);
  };

  const { TJ } = loadTradeJournal(['js/app.js'], { globals: { document: doc } });

  TJ.app.openModal('tradeModal');
  saveBtn.focus();
  TJ.app.openModal('confirmModal');
  okBtn.focus();

  let prevented = false;
  TJ.app.handleKeydown({
    key: 'Tab',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: okBtn,
    preventDefault: function () { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.equal(doc.activeElement, cancelBtn);

  TJ.app.closeModal('confirmModal');
  assert.equal(doc.activeElement, saveBtn);

  TJ.app.closeModal('tradeModal');
  assert.equal(doc.activeElement, triggerBtn);
});
