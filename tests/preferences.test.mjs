import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';
import { fakeDocument } from './helpers/fake-dom.mjs';

function loadPreferences() {
  const document = fakeDocument();
  const loaded = loadTradeJournal(['js/preferences.js'], { globals: { document: document } });
  return { prefs: loaded.TJ.prefs, doc: document, storage: loaded.storage };
}

function assertPrefs(actual, expected) {
  ['theme', 'lang', 'accent', 'bg', 'panel'].forEach(function (key) {
    assert.equal(actual[key], expected[key], 'preference ' + key);
  });
}

test('preferences default to dark theme, Russian language and default colors', function () {
  const { prefs } = loadPreferences();
  assertPrefs(prefs.get(), {
    theme: 'dark',
    lang: 'ru',
    accent: '',
    bg: '',
    panel: ''
  });
  const dark = prefs.defaultsFor('dark');
  assert.equal(dark.accent, '#31e3aa');
  assert.equal(dark.bg, '#070a0f');
  assert.equal(dark.panel, '#101822');
  const light = prefs.defaultsFor('light');
  assert.equal(light.accent, '#0f9d76');
  assert.equal(light.bg, '#f4f7fb');
  assert.equal(light.panel, '#ffffff');
});

test('preferences normalize unsupported values and colors', function () {
  const { prefs } = loadPreferences();
  const saved = prefs.save({
    theme: 'blue',
    lang: 'de',
    accent: 'red',
    bg: '#12345',
    panel: 42
  });
  assertPrefs(saved, {
    theme: 'dark',
    lang: 'ru',
    accent: '',
    bg: '',
    panel: ''
  });
  assert.equal(prefs.save({ accent: '#AABBCC' }).accent, '#aabbcc');
});

test('light theme applies light CSS variables and persists the choice', function () {
  const { prefs, doc, storage } = loadPreferences();
  prefs.save({ theme: 'light' });

  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(doc.properties['--bg'], '#f4f7fb');
  assert.equal(doc.properties['--panel'], '#ffffff');
  assert.equal(doc.properties['--text'], '#1a2633');
  assert.equal(doc.documentElement.lang, 'ru');

  const stored = JSON.parse(storage.getItem(prefs.KEY));
  assert.equal(stored.theme, 'light');
  assert.equal(prefs.get().theme, 'light');
});

test('custom accent drives interface colors without touching profit and loss colors', function () {
  const { prefs, doc } = loadPreferences();
  prefs.save({ accent: '#4d9fff' });

  assert.equal(doc.documentElement.dataset.accent, 'custom');
  assert.equal(doc.properties['--accent'], '#4d9fff');
  assert.equal(doc.properties['--accent-soft'], 'rgba(77, 159, 255, 0.12)');
  assert.equal(doc.properties['--accent-contrast'], '#ffffff');
  assert.equal(doc.properties['--green'], undefined);
  assert.equal(doc.properties['--red'], undefined);

  prefs.save({ accent: '#f5b544' });
  assert.equal(doc.properties['--accent-contrast'], '#07130f');
});

test('custom background and panel colors apply matching text tones', function () {
  const { prefs, doc } = loadPreferences();
  prefs.save({ bg: '#f4f7fb', panel: '#ffffff' });

  assert.equal(doc.documentElement.dataset.background, 'custom');
  assert.equal(doc.documentElement.dataset.panel, 'custom');
  assert.equal(doc.properties['--bg'], '#f4f7fb');
  assert.equal(doc.properties['--panel'], '#ffffff');
  assert.equal(doc.properties['--text'], '#1a2633');
  assert.equal(doc.properties['--panel-text'], '#1a2633');
});

test('resetting appearance keeps the active language', function () {
  const { prefs, doc, storage } = loadPreferences();
  prefs.save({ lang: 'en', theme: 'light', accent: '#ff8800', bg: '#101020', panel: '#1c1c34' });

  const reset = prefs.reset({ keepLanguage: true });

  assertPrefs(reset, {
    theme: 'dark',
    lang: 'en',
    accent: '',
    bg: '',
    panel: ''
  });
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(doc.properties['--accent'], '#31e3aa');
  assert.equal(doc.properties['--bg'], '#070a0f');
  assert.equal(JSON.parse(storage.getItem(prefs.KEY)).lang, 'en');
});

test('a full reset returns language and appearance to defaults', function () {
  const { prefs, doc } = loadPreferences();
  prefs.save({ lang: 'en', theme: 'light', accent: '#ff8800' });

  const reset = prefs.reset();

  assert.equal(reset.lang, 'ru');
  assert.equal(reset.theme, 'dark');
  assert.equal(doc.documentElement.lang, 'ru');
  assert.equal(doc.properties['--accent'], '#31e3aa');
});
