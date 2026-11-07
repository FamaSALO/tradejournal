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
  assert.equal(light.accent, '#0b7a5c');
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

test('every preset is unique and keeps readable contrast', function () {
  const { prefs } = loadPreferences();
  const presets = prefs.PRESETS;
  assert.ok(presets.length >= 8, 'expected at least 8 presets');

  const ids = presets.map(function (item) { return item.id; });
  assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');

  presets.forEach(function (item) {
    assert.ok(['dark', 'light'].includes(item.theme), 'bad theme in ' + item.id);
    assert.ok(item.label.trim().length > 0, 'missing label in ' + item.id);
    [item.accent, item.bg, item.panel].forEach(function (color) {
      assert.ok(prefs.parseHex(color), 'bad color ' + color + ' in ' + item.id);
    });
    // Text on the panel must stay readable: at least 4.5:1 contrast.
    const panelLum = prefs.luminance(item.panel);
    const textLum = prefs.luminance(prefs.contrastText(item.panel));
    const ratio = (Math.max(panelLum, textLum) + 0.05) / (Math.min(panelLum, textLum) + 0.05);
    assert.ok(ratio >= 4.5, 'poor panel contrast in ' + item.id + ': ' + ratio.toFixed(2));
    // Text drawn on the accent color must stay readable too.
    const accentLum = prefs.luminance(item.accent);
    const accentText = prefs.luminance(prefs.contrastText(item.accent));
    const accentRatio = (Math.max(accentLum, accentText) + 0.05) / (Math.min(accentLum, accentText) + 0.05);
    assert.ok(accentRatio >= 4.5, 'poor accent contrast in ' + item.id + ': ' + accentRatio.toFixed(2));
    // Accent must also stand out against the background, not blend into it.
    const bgLum = prefs.luminance(item.bg);
    const bgRatio = (Math.max(accentLum, bgLum) + 0.05) / (Math.min(accentLum, bgLum) + 0.05);
    assert.ok(bgRatio >= 3, 'accent blends with background in ' + item.id + ': ' + bgRatio.toFixed(2));
  });
});

test('applying a preset sets theme, colors and remembers the preset id', function () {
  const { prefs, doc, storage } = loadPreferences();
  const preset = prefs.findPreset('midnight');
  assert.ok(preset);

  const saved = prefs.usePreset('midnight');

  assert.equal(saved.theme, preset.theme);
  assert.equal(saved.accent, preset.accent);
  assert.equal(saved.bg, preset.bg);
  assert.equal(saved.panel, preset.panel);
  assert.equal(saved.preset, 'midnight');
  assert.equal(doc.documentElement.dataset.theme, preset.theme);
  assert.equal(doc.properties['--accent'], preset.accent);
  assert.equal(doc.properties['--bg'], preset.bg);
  assert.equal(JSON.parse(storage.getItem(prefs.KEY)).preset, 'midnight');
  assert.equal(prefs.usePreset('unknown').preset, 'midnight');
});

test('a manual color change drops the active preset', function () {
  const { prefs } = loadPreferences();
  prefs.usePreset('ocean');
  assert.equal(prefs.get().preset, 'ocean');

  const changed = prefs.save({ accent: '#ff00ff' });
  assert.equal(changed.preset, '');
  assert.equal(prefs.get().preset, '');

  const renamed = JSON.parse(JSON.stringify(prefs.get()));
  assert.equal(prefs.matchesPreset(Object.assign(renamed, { theme: 'dark', accent: '#38bdf8', bg: '#05131a', panel: '#0c1e28' })), true);
  assert.equal(prefs.matchesPreset(Object.assign(renamed, { accent: '#123456' })), false);
});

test('a stored preset id survives only while its colors still match', function () {
  const { prefs, storage } = loadPreferences();
  storage.setItem(prefs.KEY, JSON.stringify({
    theme: 'dark',
    accent: '#38bdf8',
    bg: '#05131a',
    panel: '#0c1e28',
    preset: 'ocean'
  }));
  assert.equal(prefs.get().preset, 'ocean');

  storage.setItem(prefs.KEY, JSON.stringify({
    theme: 'dark',
    accent: '#38bdf8',
    bg: '#05131a',
    panel: '#ff0000',
    preset: 'ocean'
  }));
  assert.equal(prefs.get().preset, '');
});

test('an unknown stored preset id is ignored', function () {
  const { prefs, storage } = loadPreferences();
  storage.setItem(prefs.KEY, JSON.stringify({ theme: 'dark', preset: 'neon-disco' }));
  assert.equal(prefs.get().preset, '');
});
