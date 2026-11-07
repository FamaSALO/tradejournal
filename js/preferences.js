(function () {
  'use strict';
  const NS = (window.TJ = window.TJ || {});
  const KEY = 'tradejournal.preferences.v1';

  const ACCENTS = [
    { color: '#31e3aa', label: 'Мята' },
    { color: '#4d9fff', label: 'Синий' },
    { color: '#9d7bff', label: 'Фиолетовый' },
    { color: '#f5b544', label: 'Янтарь' },
    { color: '#ff6b9d', label: 'Розовый' },
    { color: '#5dd6ff', label: 'Голубой' }
  ];

  const DARK = {
    accent: '#31e3aa',
    bg: '#070a0f',
    panel: '#101822'
  };

  const LIGHT = {
    accent: '#0b7a5c',
    bg: '#f4f7fb',
    panel: '#ffffff'
  };

  // Curated presets: every one keeps readable text contrast and keeps
  // profit/loss colors untouched.
  const PRESETS = [
    { id: 'mint', label: 'Мята', theme: 'dark', accent: '#31e3aa', bg: '#070a0f', panel: '#101822' },
    { id: 'graphite', label: 'Графит', theme: 'dark', accent: '#9db4d4', bg: '#0c0f13', panel: '#171c23' },
    { id: 'midnight', label: 'Полночь', theme: 'dark', accent: '#b9a3ff', bg: '#0a0813', panel: '#15112a' },
    { id: 'ocean', label: 'Океан', theme: 'dark', accent: '#38bdf8', bg: '#05131a', panel: '#0c1e28' },
    { id: 'sunset', label: 'Закат', theme: 'dark', accent: '#f5a524', bg: '#150e0b', panel: '#221714' },
    { id: 'daylight', label: 'Утро', theme: 'light', accent: '#0b7a5c', bg: '#f4f7fb', panel: '#ffffff' },
    { id: 'cream', label: 'Крем', theme: 'light', accent: '#a16207', bg: '#faf6ee', panel: '#fffdf7' },
    { id: 'steel', label: 'Сталь', theme: 'light', accent: '#2563eb', bg: '#eef2f7', panel: '#ffffff' }
  ];

  function defaultsFor(theme) {
    return theme === 'light' ? LIGHT : DARK;
  }

  function parseHex(value) {
    const text = String(value || '').trim();
    if (!/^#[0-9a-f]{6}$/i.test(text)) return null;
    return {
      r: parseInt(text.slice(1, 3), 16),
      g: parseInt(text.slice(3, 5), 16),
      b: parseInt(text.slice(5, 7), 16)
    };
  }

  function toHex(rgb) {
    const part = function (value) {
      const clamped = Math.max(0, Math.min(255, Math.round(value)));
      return clamped.toString(16).padStart(2, '0');
    };
    return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
  }

  function mix(a, b, amount) {
    const left = parseHex(a);
    const right = parseHex(b);
    if (!left || !right) return a;
    return toHex({
      r: left.r + (right.r - left.r) * amount,
      g: left.g + (right.g - left.g) * amount,
      b: left.b + (right.b - left.b) * amount
    });
  }

  function shade(hex, amount) {
    return amount >= 0 ? mix(hex, '#ffffff', amount) : mix(hex, '#000000', -amount);
  }

  function rgba(hex, alpha) {
    const rgb = parseHex(hex);
    if (!rgb) return hex;
    return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + alpha + ')';
  }

  function luminance(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return 0;
    const channel = function (value) {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrastText(hex) {
    return luminance(hex) > 0.42 ? '#07130f' : '#ffffff';
  }

  function validColor(value) {
    return parseHex(value) ? String(value).toLowerCase() : '';
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const known = PRESETS.filter(function (item) { return item.id === source.preset; })[0];
    // The preset id is only meaningful while theme and colors still match it.
    const preset = known &&
      known.theme === (source.theme === 'light' ? 'light' : 'dark') &&
      known.accent === validColor(source.accent) &&
      known.bg === validColor(source.bg) &&
      known.panel === validColor(source.panel)
      ? known.id
      : '';
    return {
      theme: source.theme === 'light' ? 'light' : 'dark',
      lang: source.lang === 'en' ? 'en' : 'ru',
      accent: validColor(source.accent),
      bg: validColor(source.bg),
      panel: validColor(source.panel),
      preset: preset
    };
  }

  function findPreset(id) {
    return PRESETS.filter(function (item) { return item.id === id; })[0] || null;
  }

  // A preset replaces theme and all three colors at once.
  function usePreset(id) {
    const preset = findPreset(id);
    if (!preset) return read();
    return save({
      theme: preset.theme,
      accent: preset.accent,
      bg: preset.bg,
      panel: preset.panel,
      preset: preset.id
    });
  }

  // Any manual color or theme change stops the interface from claiming a preset.
  function matchesPreset(state) {
    return PRESETS.some(function (item) {
      return item.theme === state.theme &&
        item.accent.toLowerCase() === state.accent.toLowerCase() &&
        item.bg.toLowerCase() === state.bg.toLowerCase() &&
        item.panel.toLowerCase() === state.panel.toLowerCase();
    });
  }

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      return normalize(raw ? JSON.parse(raw) : {});
    } catch (err) {
      return normalize({});
    }
  }

  function apply(prefs) {
    const state = normalize(prefs);
    const base = defaultsFor(state.theme);
    const root = document.documentElement;
    const accent = state.accent || base.accent;
    const bg = state.bg || base.bg;
    const panel = state.panel || base.panel;
    const lightBg = luminance(bg) > 0.5;
    const lightPanel = luminance(panel) > 0.5;
    const text = lightBg ? '#1a2633' : '#e9eff7';
    const muted = lightBg ? '#5d6d80' : '#8b9bb0';
    const muted2 = lightBg ? '#7b8a9c' : '#617185';
    const panelText = lightPanel ? '#1a2633' : '#e9eff7';
    const panelMuted = lightPanel ? '#5d6d80' : '#8b9bb0';

    root.dataset.theme = state.theme;
    root.dataset.accent = state.accent ? 'custom' : 'default';
    root.dataset.background = state.bg ? 'custom' : 'default';
    root.dataset.panel = state.panel ? 'custom' : 'default';
    root.lang = state.lang;

    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-2', shade(accent, -0.18));
    root.style.setProperty('--accent-3', shade(accent, 0.18));
    root.style.setProperty('--accent-soft', rgba(accent, 0.12));
    root.style.setProperty('--accent-softer', rgba(accent, 0.06));
    root.style.setProperty('--accent-border', rgba(accent, 0.28));
    root.style.setProperty('--accent-ring', rgba(accent, 0.55));
    root.style.setProperty('--accent-contrast', contrastText(accent));

    root.style.setProperty('--bg', bg);
    root.style.setProperty('--bg-soft', shade(bg, lightBg ? -0.03 : 0.035));
    root.style.setProperty('--panel', panel);
    root.style.setProperty('--panel-2', shade(panel, lightPanel ? -0.03 : -0.04));
    root.style.setProperty('--text', text);
    root.style.setProperty('--text-strong', lightBg ? '#243040' : '#cfdae8');
    root.style.setProperty('--text-soft', lightBg ? '#41566d' : '#aebdd0');
    root.style.setProperty('--muted', muted);
    root.style.setProperty('--muted-2', muted2);
    root.style.setProperty('--border', rgba(lightBg ? '#1a2633' : '#94b2d4', 0.16));
    root.style.setProperty('--border-strong', rgba(lightBg ? '#1a2633' : '#94b2d4', 0.28));
    root.style.setProperty('--panel-text', panelText);
    root.style.setProperty('--panel-muted', panelMuted);
    root.style.setProperty('--panel-2-text', lightPanel ? '#243040' : '#dbe6f3');
    root.style.setProperty('--shadow', state.theme === 'light'
      ? '0 22px 60px rgba(23, 43, 77, 0.12)'
      : '0 24px 70px rgba(0, 0, 0, 0.45)');
    root.style.setProperty('--topbar-bg', rgba(shade(bg, lightBg ? -0.04 : 0.02), 0.82));
    root.style.setProperty('--sidebar-bg', shade(bg, lightBg ? -0.025 : 0.02));
    root.style.setProperty('--card-bg-a', shade(panel, lightPanel ? -0.012 : 0.03));
    root.style.setProperty('--card-bg-b', shade(panel, lightPanel ? -0.03 : -0.02));
    root.style.setProperty('--input-bg', shade(panel, lightPanel ? -0.02 : -0.055));
    root.style.setProperty('--hover-bg', rgba(lightBg ? '#1a2633' : '#ffffff', lightBg ? 0.055 : 0.035));
    root.style.setProperty('--hover-bg-strong', rgba(lightBg ? '#1a2633' : '#ffffff', lightBg ? 0.09 : 0.06));

    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', state.theme === 'light' ? 'light' : 'dark');
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', bg);
    return state;
  }

  function save(patch) {
    const next = normalize(Object.assign(read(), patch));
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (err) { /* storage can be unavailable */ }
    apply(next);
    return next;
  }

  function reset(options) {
    const current = read();
    const keepLanguage = !!(options && options.keepLanguage);
    const next = normalize(keepLanguage ? { lang: current.lang } : {});
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (err) { /* ignore */ }
    apply(next);
    return next;
  }

  NS.prefs = {
    KEY: KEY,
    ACCENTS: ACCENTS,
    PRESETS: PRESETS,
    usePreset: usePreset,
    findPreset: findPreset,
    matchesPreset: matchesPreset,
    defaultsFor: defaultsFor,
    get: read,
    save: save,
    apply: apply,
    reset: reset,
    normalize: normalize,
    luminance: luminance,
    contrastText: contrastText,
    shade: shade,
    rgba: rgba,
    parseHex: parseHex
  };

  apply(read());
})();
