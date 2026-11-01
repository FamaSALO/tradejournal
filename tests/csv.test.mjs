import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const { TJ } = loadTradeJournal();
const csv = TJ.csv;
const store = TJ.store;

const RUSSIAN_CSV = [
  '\uFEFFДата;Время;Инструмент;Направление;Вход;Выход;Стоп;Тейк;Количество;Множитель;Комиссия;Выходы;Сетап;Эмоция;Теги;Заметка',
  '05.01.2026;10:30;eurusd;Long;1,0850;1,0900;1,0800;1,0950;10000;1;2;4000@1,0880|6000@1,0900;Ретест;Спокоен;план,лондон;Тестовая сделка'
].join('\r\n');

test('detects semicolon, comma and tab delimiters', function () {
  assert.equal(csv.detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(csv.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(csv.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('parses quoted fields, BOM and embedded newlines', function () {
  const parsed = csv.parse('\uFEFFДата,Заметка\r\n2026-01-05,"строка, с запятой"\r\n2026-01-06,"первая\nвторая"\r\n');
  assert.equal(parsed.delimiter, ',');
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[1][1], 'строка, с запятой');
  assert.equal(parsed.rows[2][1], 'первая\nвторая');
});

test('normalizes numbers and dates', function () {
  assert.equal(csv.number('1 234,56'), 1234.56);
  assert.equal(csv.number('$1,234.56'), 1234.56);
  assert.equal(csv.number('(12,5)'), -12.5);
  assert.equal(csv.number('—'), null);
  assert.equal(csv.date('05.01.2026'), '2026-01-05');
  assert.equal(csv.date('2026-01-05'), '2026-01-05');
  assert.equal(csv.date('01/05/2026'), '2026-05-01');
  assert.equal(csv.date('01.13.2026'), '2026-01-13');
  assert.equal(csv.time('9:05'), '09:05');
  assert.equal(csv.time('25:00'), '');
});

test('analyzes a Russian broker CSV with partial exits', function () {
  const result = csv.analyze(RUSSIAN_CSV, []);
  assert.equal(result.errors.length, 0, result.errors.join(' '));
  assert.equal(result.trades.length, 1);
  assert.equal(result.stats.exits, 2);
  assert.equal(result.duplicates, 0);

  const trade = result.trades[0];
  assert.equal(trade.date, '2026-01-05');
  assert.equal(trade.time, '10:30');
  assert.equal(trade.symbol, 'EURUSD');
  assert.equal(trade.side, 'long');
  assert.equal(trade.entry, 1.085);
  assert.equal(trade.qty, 10000);
  assert.equal(trade.multiplier, 1);
  assert.equal(trade.fees, 2);
  assert.equal(trade.exits.length, 2);
  assert.equal(trade.exits[0].qty, 4000);
  assert.equal(trade.exits[0].price, 1.088);
  assert.equal(trade.emotion, 'calm');
  assert.deepEqual(Array.from(trade.tags), ['план', 'лондон']);
});

test('deduplicates against existing trades and inside the file', function () {
  const first = csv.analyze(RUSSIAN_CSV, []);
  const existing = first.trades.map(function (item) { return store.normalizeTrade(item); });
  const second = csv.analyze(RUSSIAN_CSV, existing);
  assert.equal(second.trades.length, 0);
  assert.equal(second.duplicates, 1);

  const doubled = RUSSIAN_CSV + '\r\n' + RUSSIAN_CSV.split('\r\n')[1];
  const third = csv.analyze(doubled, []);
  assert.equal(third.trades.length, 1);
  assert.equal(third.duplicates, 1);
});

test('reports invalid rows and oversized exits', function () {
  const text = [
    'Date,Symbol,Side,Entry,Qty,Exits',
    '2026-01-05,EURUSD,Long,1.085,100,60@1.09|60@1.10',
    '2026-01-06,,Long,1.085,100,',
    '2026-01-07,GBPUSD,Both,1.27,100,'
  ].join('\n');
  const result = csv.analyze(text, []);
  assert.equal(result.trades.length, 0);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.some(function (line) { return line.indexOf('больше количества') !== -1; }));
  assert.ok(result.errors.some(function (line) { return line.indexOf('не указан инструмент') !== -1; }));
  assert.ok(result.errors.some(function (line) { return line.indexOf('направление') !== -1; }));
});

test('parses exits with their own dates', function () {
  const parsed = csv.parseExits('2@110@2026-01-06|3@120', '2026-01-05');
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.exits[0].date, '2026-01-06');
  assert.equal(parsed.exits[1].date, '2026-01-05');
});
