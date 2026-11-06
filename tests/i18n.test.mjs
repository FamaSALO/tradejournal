import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';
import { fakeDocument } from './helpers/fake-dom.mjs';

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
    'Сбросить оформление': 'Reset appearance'
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
