import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTradeJournal } from './helpers/load-tj.mjs';
import { fakeDocument } from './helpers/fake-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadI18n(language) {
  const document = fakeDocument();
  const storage = {
    values: new Map(),
    getItem: function (key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem: function (key, value) { this.values.set(key, String(value)); },
    removeItem: function (key) { this.values.delete(key); }
  };
  if (language === 'en') {
    storage.setItem('tradejournal.preferences.v1', JSON.stringify({ lang: 'en' }));
  }
  const loaded = loadTradeJournal(
    ['js/preferences.js', 'js/i18n-en.js', 'js/i18n.js'],
    {
      globals: {
        document: document,
        NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }
      },
      storage: storage
    }
  );
  return loaded;
}

const dictionary = loadTradeJournal(['js/i18n-en.js']).sandbox.TJ_I18N_EN;

test('English dictionary is complete and contains no untranslated interface text', function () {
  const keys = Object.keys(dictionary);
  assert.ok(keys.length >= 800, 'expected at least 800 entries, got ' + keys.length);
  keys.forEach(function (key) {
    assert.match(key, /[А-Яа-яЁё]/, 'source key must contain Cyrillic: ' + key);
    assert.equal(typeof dictionary[key], 'string');
    assert.ok(dictionary[key].trim().length > 0, 'empty translation for: ' + key);
    assert.doesNotMatch(dictionary[key], /[А-Яа-яЁё]/, 'translation still contains Cyrillic: ' + key);
  });
});

test('critical interface strings are translated', function () {
  const expected = {
    'Настройки': 'Settings',
    'Сделки': 'Trades',
    'Обзор': 'Overview',
    'Календарь': 'Calendar',
    'Аналитика': 'Analytics',
    'Журнал': 'Journal',
    'Калькулятор': 'Calculator',
    'Светлая': 'Light',
    'Тёмная': 'Dark',
    'Язык интерфейса': 'Interface language',
    'Тема оформления': 'Interface theme',
    'Сбросить оформление': 'Reset appearance',
    'Редактировать сделку': 'Edit trade',
    'Сохранить сделку': 'Save trade',
    'Сохранить изменения': 'Save changes',
    'Удалить сделку?': 'Delete trade?',
    'Закрыта': 'Closed',
    'Количество выхода': 'Exit quantity',
    'Вход': 'Entry',
    'вход': 'entry',
    'Загрузить': 'Upload',
    'Скриншот графика': 'Chart screenshot',
    'Вт': 'Tue',
    'Обновить': 'Update',
    'Расчёт': 'Calculation',
    'от пика счёта': 'from account peak',
    'Транзакция IndexedDB отменена.': 'IndexedDB transaction aborted.'
  };
  Object.keys(expected).forEach(function (key) {
    assert.equal(dictionary[key], expected[key]);
  });
});

test('default language stays Russian', function () {
  const { TJ } = loadI18n();
  assert.equal(TJ.i18n.lang(), 'ru');
  assert.equal(TJ.i18n.locale(), 'ru-RU');
  assert.equal(TJ.i18n.t('Настройки'), 'Настройки');
  assert.equal(TJ.i18n.t('Сделки 79'), 'Сделки 79');
});

test('English mode translates exact strings, phrases and whitespace', function () {
  const { TJ } = loadI18n('en');
  assert.equal(TJ.i18n.lang(), 'en');
  assert.equal(TJ.i18n.locale(), 'en-US');
  assert.equal(TJ.i18n.t('Настройки'), 'Settings');
  assert.equal(TJ.i18n.t('  Настройки  '), '  Settings  ');
  assert.equal(TJ.i18n.t('Сделки 79'), 'Trades 79');
  assert.equal(TJ.i18n.t('Все сделки →'), 'All trades →');
  assert.equal(TJ.i18n.t(''), '');
  assert.equal(TJ.i18n.t(null), '');
});

test('English mode does not translate unknown text or partial words', function () {
  const { TJ } = loadI18n('en');
  assert.equal(TJ.i18n.t('Неизвестная строка'), 'Неизвестная строка');
  assert.equal(TJ.i18n.t('Сделкинг'), 'Сделкинг');
});

test('every Russian interface string in index.html has an English translation', function () {
  const { TJ } = loadI18n('en');
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const CYRILLIC = /[А-Яа-яЁё]/;
  const keys = Object.keys(dictionary).sort(function (a, b) { return b.length - a.length; });

  function covered(text) {
    if (dictionary[text]) return true;
    let index = 0;
    while (index < text.length) {
      if (!CYRILLIC.test(text.charAt(index))) {
        index++;
        continue;
      }
      const key = keys.find(function (candidate) { return text.startsWith(candidate, index); });
      if (!key) return false;
      index += key.length;
    }
    return true;
  }

  const samples = [];
  let depth = 0;
  let buffer = '';
  html.split(/(<[^>]+>)/).forEach(function (token) {
    if (token.charAt(0) === '<') {
      if (buffer.trim()) samples.push(buffer.replace(/\s+/g, ' ').trim());
      buffer = '';
      const name = (token.match(/^<\/?([a-zA-Z0-9-]+)/) || [])[1] || '';
      if (/^(textarea|pre|code)$/i.test(name)) depth += token.charAt(1) === '/' ? -1 : 1;
      return;
    }
    if (depth <= 0) buffer += ' ' + token;
  });
  if (buffer.trim()) samples.push(buffer.replace(/\s+/g, ' ').trim());

  const missing = samples.filter(function (text) {
    return CYRILLIC.test(text) && !covered(text);
  });
  assert.deepEqual(missing, [], 'untranslated interface strings: ' + JSON.stringify(missing));

  const untranslatedAttrs = [];
  for (const attrMatch of html.matchAll(/\b(?:aria-label|title|placeholder)="([^"]*?[А-Яа-яЁё][^"]*?)"/g)) {
    const out = TJ.i18n.t(attrMatch[1]);
    if (CYRILLIC.test(out)) untranslatedAttrs.push(attrMatch[1] + ' -> ' + out);
  }
  assert.deepEqual(untranslatedAttrs, [], 'untranslated attributes: ' + JSON.stringify(untranslatedAttrs));
});

test('switching language persists the preference', function () {
  const { TJ, storage } = loadI18n();
  assert.equal(TJ.i18n.setLanguage('en', { reload: false }), 'en');
  assert.equal(TJ.i18n.lang(), 'en');
  assert.equal(TJ.i18n.t('Настройки'), 'Settings');
  assert.equal(JSON.parse(storage.getItem('tradejournal.preferences.v1')).lang, 'en');

  assert.equal(TJ.i18n.setLanguage('ru', { reload: false }), 'ru');
  assert.equal(TJ.i18n.t('Настройки'), 'Настройки');
  assert.equal(JSON.parse(storage.getItem('tradejournal.preferences.v1')).lang, 'ru');
});

test('all T()/tr() message keys in JS modules exist and contain no Cyrillic after translation', function () {
  const { TJ } = loadI18n('en');
  const files = ['js/app.js', 'js/csv.js', 'js/zip.js', 'js/store.js', 'js/utils.js', 'js/desktop-bridge.js'];
  const missing = [];
  const untranslated = [];
  files.forEach(function (file) {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const re = /\b(?:T|tr)\(\s*(['"])((?:\\.|(?!\1).)*[А-Яа-яЁё](?:\\.|(?!\1).)*)\1\s*\)/g;
    let match;
    while ((match = re.exec(src))) {
      const key = match[2];
      if (!Object.prototype.hasOwnProperty.call(dictionary, key)) missing.push(file + ': ' + key);
      const translated = TJ.i18n.t(key);
      if (/[А-Яа-яЁё]/.test(translated)) untranslated.push(file + ': ' + key + ' -> ' + translated);
    }
  });
  assert.deepEqual(missing, [], 'missing dictionary keys: ' + JSON.stringify(missing));
  assert.deepEqual(untranslated, [], 'untranslated keys: ' + JSON.stringify(untranslated));
});

test('utils, csv, zip and desktop-bridge return English messages in EN mode', async function () {
  const document = fakeDocument();
  const storage = {
    values: new Map([['tradejournal.preferences.v1', JSON.stringify({ lang: 'en' })]]),
    getItem: function (key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem: function (key, value) { this.values.set(key, String(value)); },
    removeItem: function (key) { this.values.delete(key); }
  };
  let nextInvokeError = 'Не удалось прочитать файл журнала: Permission denied';
  const { TJ, sandbox } = loadTradeJournal(
    ['js/preferences.js', 'js/i18n-en.js', 'js/i18n.js', 'js/utils.js', 'js/desktop-bridge.js', 'js/csv.js', 'js/zip.js'],
    {
      globals: {
        document: document,
        NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
        __TAURI__: {
          core: {
            invoke: function () { return Promise.reject(new Error(nextInvokeError)); }
          }
        }
      },
      storage: storage
    }
  );

  assert.deepEqual(Array.from(TJ.utils.weekdayLabels()), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.match(TJ.utils.bytes(2048), /KB$/);

  const emptyCsv = TJ.csv.analyze('', []);
  assert.ok(emptyCsv.errors.length > 0);
  assert.doesNotMatch(emptyCsv.errors.join(' '), /[А-Яа-яЁё]/);

  const badRows = TJ.csv.analyze('date;symbol;side;entry;qty\n2026-01-10;;long;100;1\nbad-date;AAPL;flat;0;-5', []);
  assert.ok(badRows.errors.length > 0);
  assert.doesNotMatch(badRows.errors.join(' '), /[А-Яа-яЁё]/);

  await assert.rejects(
    function () { return TJ.zip.readJournal(new Uint8Array([1, 2, 3, 4]).buffer); },
    function (err) {
      assert.ok(err && err.message);
      assert.doesNotMatch(err.message, /[А-Яа-яЁё]/);
      return true;
    }
  );

  await assert.rejects(
    function () { return sandbox.tradeJournalDesktop.load(); },
    function (err) {
      assert.match(err.message, /Failed to read journal file: Permission denied/);
      assert.doesNotMatch(err.message, /[А-Яа-яЁё]/);
      return true;
    }
  );

  nextInvokeError = 'Файл journal-bad.json повреждён. Очистка отменена, чтобы не удалить нужные скриншоты.';
  await assert.rejects(
    function () { return sandbox.tradeJournalDesktop.storageHealth(); },
    function (err) {
      assert.match(err.message, /journal-bad\.json is corrupted/);
      assert.doesNotMatch(err.message, /[А-Яа-яЁё]/);
      return true;
    }
  );
});
