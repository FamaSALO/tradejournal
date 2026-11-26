import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';
import { fakeDocument } from './helpers/fake-dom.mjs';

function makeMockContext(calls) {
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    shadowColor: '',
    shadowBlur: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    setTransform: function () {},
    clearRect: function () { calls.clears += 1; },
    fillRect: function (x, y, w, h) { calls.rects.push({ x: x, y: y, w: w, h: h, fillStyle: ctx.fillStyle }); },
    fillText: function (text) { calls.texts.push(String(text)); },
    beginPath: function () {},
    moveTo: function () {},
    lineTo: function () {},
    quadraticCurveTo: function () {},
    arc: function (cx, cy, r, start, end) { calls.arcs.push({ start: start, end: end, strokeStyle: ctx.strokeStyle, lineCap: ctx.lineCap }); },
    closePath: function () {},
    fill: function () {},
    stroke: function () {},
    setLineDash: function () {},
    createLinearGradient: function () {
      return { addColorStop: function () {} };
    }
  };
  return ctx;
}

function makeCanvas(width, height, withTooltip) {
  const calls = { clears: 0, rects: [], texts: [], arcs: [] };
  const listeners = new Map();
  const classes = new Set();
  const tooltip = withTooltip ? {
    innerHTML: '',
    offsetWidth: 140,
    offsetHeight: 54,
    style: { left: '', top: '' },
    classList: {
      add: function (name) { classes.add(name); },
      remove: function (name) { classes.delete(name); },
      contains: function (name) { return classes.has(name); }
    }
  } : null;

  const canvas = {
    width: 0,
    height: 0,
    parentElement: {
      querySelector: function (sel) {
        return sel === '.chart-tooltip' ? tooltip : null;
      }
    },
    getBoundingClientRect: function () {
      return { left: 0, top: 0, width: width, height: height };
    },
    getContext: function () {
      return makeMockContext(calls);
    },
    addEventListener: function (type, handler) {
      listeners.set(type, handler);
    }
  };

  return { canvas: canvas, calls: calls, listeners: listeners, tooltip: tooltip, classes: classes };
}

function loadCharts(withPointer) {
  const doc = fakeDocument();
  const globals = {
    document: doc,
    getComputedStyle: function () {
      return {
        getPropertyValue: function (name) {
          const map = {
            '--border': 'rgba(148, 178, 212, 0.13)',
            '--border-strong': 'rgba(148, 178, 212, 0.22)',
            '--muted-2': '#7c8fa6',
            '--green': '#31e3aa',
            '--red': '#ff6b81',
            '--hover-bg': 'rgba(255, 255, 255, 0.035)'
          };
          return map[name] || '';
        }
      };
    }
  };
  if (withPointer) {
    globals.PointerEvent = function () {};
  }
  const { TJ } = loadTradeJournal(
    ['js/preferences.js', 'js/i18n-en.js', 'js/i18n.js', 'js/utils.js', 'js/charts.js'],
    { globals: globals }
  );
  return TJ.charts;
}

test('computeDonutArcs renders full circle for single category and preserves small slices (UX-02 / TEST-01)', function () {
  const charts = loadCharts(false);

  assert.deepEqual(Array.from(charts._computeDonutArcs([{ value: 0, color: '#111' }])), []);

  const single = charts._computeDonutArcs([
    { value: 12, color: '#31e3aa' },
    { value: 0, color: '#ff6b81' },
    { value: 0, color: '#7c8fa6' }
  ]);
  assert.equal(single.length, 1);
  assert.equal(single[0].full, true);
  assert.ok(Math.abs((single[0].end - single[0].start) - Math.PI * 2) < 1e-12);

  const tiny = charts._computeDonutArcs([
    { value: 999, color: '#31e3aa' },
    { value: 1, color: '#7c8fa6' }
  ]);
  assert.equal(tiny.length, 2);
  assert.ok(tiny[1].end > tiny[1].start, '1:1000 slice must keep strictly positive visible arc');
  assert.ok(tiny[0].end > tiny[0].start);
});

test('bars chart draws zero axis and bars when all values are zero, and pointer tooltip toggles on pointerdown/pointerleave (TEST-01)', function () {
  const charts = loadCharts(true);
  const mock = makeCanvas(400, 200, true);

  charts.bars(mock.canvas, [
    { label: '2026-01-05', value: 0, meta: '1 сделка' },
    { label: '2026-01-06', value: 0, meta: '2 сделки' }
  ], { emptyText: 'EMPTY_FALLBACK' });

  assert.equal(mock.calls.texts.includes('EMPTY_FALLBACK'), false, 'zero values should still render chart instead of empty fallback');
  assert.ok(mock.calls.rects.length >= 2, 'zero-value bars should draw visible zero markers');

  assert.ok(mock.listeners.has('pointerdown'), 'pointerdown should be bound when PointerEvent exists');
  assert.ok(mock.listeners.has('pointerleave'), 'pointerleave should be bound');

  mock.listeners.get('pointerdown')({ clientX: 180, clientY: 100 });
  assert.equal(mock.classes.has('show'), true);
  assert.match(mock.tooltip.innerHTML, /\$0/);

  mock.listeners.get('pointerleave')();
  assert.equal(mock.classes.has('show'), false);
});

test('equity chart draws points and mouse fallback tooltips when PointerEvent is unavailable (TEST-01)', function () {
  const charts = loadCharts(false);
  const mock = makeCanvas(500, 220, true);

  charts.equity(mock.canvas, [
    { label: 'Старт', value: 10000, meta: 'Начало периода' },
    { label: '2026-01-05', value: 10250, meta: 'EURUSD · +$250' },
    { label: '2026-01-06', value: 10100, meta: 'GBPUSD · -$150' }
  ]);

  assert.ok(mock.listeners.has('mousemove'));
  assert.ok(mock.listeners.has('touchstart'));
  mock.listeners.get('touchstart')({ touches: [{ clientX: 250, clientY: 80 }] });
  assert.equal(mock.classes.has('show'), true);
  assert.match(mock.tooltip.innerHTML, /10/);
  mock.listeners.get('touchend')();
  assert.equal(mock.classes.has('show'), false);
});

test('drawdown chart renders negative curve and duration tooltip (FEAT-03)', function () {
  const charts = loadCharts(true);
  const mock = makeCanvas(500, 220, true);

  charts.drawdown(mock.canvas, [
    { label: '2026-01-01', value: 0, dd: 0, ddPct: 0, durationDays: 0, durationTrades: 0, symbol: '' },
    { label: '2026-01-02', value: -4.5, dd: 450, ddPct: 4.5, durationDays: 3, durationTrades: 1, symbol: 'BTCUSD' },
    { label: '2026-01-05', value: -8.2, dd: 820, ddPct: 8.2, durationDays: 6, durationTrades: 2, symbol: 'ETHUSD' }
  ]);

  assert.equal(mock.calls.texts.includes('0%'), true);
  assert.ok(mock.listeners.has('pointerdown'));
  mock.listeners.get('pointerdown')({ clientX: 480, clientY: 120 });
  assert.equal(mock.classes.has('show'), true);
  assert.match(mock.tooltip.innerHTML, /-8[.,]2%/);
  assert.match(mock.tooltip.innerHTML, /6 дн/);
});
