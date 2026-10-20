(function () {
  'use strict';
  const NS = (window.TJ = window.TJ || {});

  const moneyFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const intFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

  const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const WEEKDAYS_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  const MOODS = {
    great: { label: 'Отлично', emoji: '🚀', score: 5, color: '#31e3aa' },
    good: { label: 'Хорошо', emoji: '🙂', score: 4, color: '#7ed9a0' },
    neutral: { label: 'Нейтрально', emoji: '😐', score: 3, color: '#93a3b8' },
    bad: { label: 'Плохо', emoji: '😕', score: 2, color: '#f5b544' },
    awful: { label: 'Ужасно', emoji: '😖', score: 1, color: '#ff6b81' }
  };

  const EMOTIONS = [
    { key: 'calm', label: 'Спокоен', emoji: '😌' },
    { key: 'confident', label: 'Уверен', emoji: '😎' },
    { key: 'neutral', label: 'Нейтрально', emoji: '😐' },
    { key: 'fomo', label: 'FOMO', emoji: '😬' },
    { key: 'fear', label: 'Страх', emoji: '😰' },
    { key: 'greed', label: 'Жадность', emoji: '🤑' },
    { key: 'revenge', label: 'Месть', emoji: '😤' },
    { key: 'boredom', label: 'Скука', emoji: '😑' },
    { key: 'euphoria', label: 'Эйфория', emoji: '🤩' }
  ];

  const SETUPS = [
    'Пробой уровня',
    'Откат к уровню',
    'Ретест',
    'Тренд по старшему ТФ',
    'Контртренд',
    'Новости',
    'Скальпинг',
    'Пин-бар',
    'Двойное дно / вершина'
  ];

  const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  function symbol() {
    return (NS.config && NS.config.currency) || '$';
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function parseNum(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().replace(/\s|'/g, '').replace(',', '.');
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  function money(value, opts) {
    opts = opts || {};
    const num = parseNum(value);
    if (num === null) return '—';
    let sign = '';
    if (num < 0) sign = '−';
    else if (opts.sign && Math.abs(num) > 0.0000001) sign = '+';
    const body = opts.compact ? compactBody(Math.abs(num)) : moneyFmt.format(Math.abs(num));
    return sign + symbol() + body;
  }

  function compactBody(abs) {
    if (abs >= 1e9) return trim(abs / 1e9) + 'B';
    if (abs >= 1e6) return trim(abs / 1e6) + 'M';
    if (abs >= 100000) return Math.round(abs / 1000) + 'k';
    if (abs >= 1000) return trim(abs / 1000) + 'k';
    return intFmt.format(Math.round(abs));
  }

  function compactMoney(value, opts) {
    opts = opts || {};
    const num = parseNum(value);
    if (num === null) return '—';
    const sign = num < 0 ? '−' : (opts.sign && Math.abs(num) > 0.0000001 ? '+' : '');
    return sign + symbol() + compactBody(Math.abs(num));
  }

  function trim(num) {
    return Number(num.toFixed(1)).toString().replace('.', ',');
  }

  function percent(value, digits) {
    const num = parseNum(value);
    if (num === null) return '—';
    const d = digits === undefined ? 1 : digits;
    return num.toFixed(d).replace('.', ',').replace('-', '−') + '%';
  }

  function rfmt(value, opts) {
    opts = opts || {};
    const num = parseNum(value);
    if (num === null) return '—';
    const sign = num > 0 && opts.sign ? '+' : (num < 0 ? '−' : '');
    return sign + Math.abs(num).toFixed(2).replace('.', ',') + 'R';
  }

  function price(value) {
    const num = parseNum(value);
    if (num === null) return '—';
    const abs = Math.abs(num);
    let digits = 2;
    if (abs > 0 && abs < 1) digits = 6;
    else if (abs < 10) digits = 4;
    else if (abs < 1000) digits = 2;
    const rounded = Number(num.toFixed(digits));
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(rounded);
  }

  function qty(value) {
    const num = parseNum(value);
    if (num === null) return '—';
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(num);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function isoOf(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function todayISO() { return isoOf(new Date()); }

  function parseISO(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const parts = iso.slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function addDaysISO(iso, days) {
    const d = parseISO(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + days);
    return isoOf(d);
  }

  function formatDate(iso, mode) {
    const d = parseISO(iso);
    if (!d) return '—';
    const day = d.getDate();
    const month = d.getMonth();
    const year = d.getFullYear();
    if (mode === 'short') return pad(day) + '.' + pad(month + 1);
    if (mode === 'med') return day + ' ' + MONTHS_SHORT[month];
    if (mode === 'full') return day + ' ' + MONTHS_GEN[month] + ' ' + year + ', ' + WEEKDAYS_SHORT[(d.getDay() + 6) % 7];
    if (mode === 'weekday') return WEEKDAYS_SHORT[(d.getDay() + 6) % 7];
    if (mode === 'weekday-full') return WEEKDAYS_FULL[(d.getDay() + 6) % 7];
    if (mode === 'month') return MONTHS_NOM[month] + ' ' + year;
    return day + ' ' + MONTHS_GEN[month] + ' ' + year;
  }

  function weekdayIndex(iso) {
    const d = parseISO(iso);
    if (!d) return 0;
    return (d.getDay() + 6) % 7;
  }

  function monthTitle(year, month) {
    return MONTHS_NOM[month] + ' ' + year;
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  function nowTime() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function uid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (err) { /* ignore */ }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function plural(n, forms) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  function sessionOf(time) {
    if (!time || typeof time !== 'string') return 'Без времени';
    const hour = Number(time.slice(0, 2));
    if (isNaN(hour)) return 'Без времени';
    if (hour < 9) return 'Азия';
    if (hour < 13) return 'Лондон';
    if (hour < 18) return 'Нью-Йорк';
    return 'Вечер';
  }

  function emotionMeta(key) {
    return EMOTIONS.find(function (e) { return e.key === key; }) || { key: key || '', label: key || '—', emoji: '•' };
  }

  function moodMeta(key) {
    return MOODS[key] || MOODS.neutral;
  }

  function sum(list, fn) {
    return (list || []).reduce(function (acc, item) {
      const v = fn ? fn(item) : item;
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      const ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bytes(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(2).replace('.', ',') + ' МБ';
    if (value >= 1024) return Math.round(value / 1024) + ' КБ';
    return Math.round(value) + ' Б';
  }

  function truncate(str, length) {
    const text = String(str || '');
    return text.length > length ? text.slice(0, length - 1).trim() + '…' : text;
  }

  NS.utils = {
    escapeHtml: escapeHtml,
    parseNum: parseNum,
    money: money,
    compactMoney: compactMoney,
    percent: percent,
    rfmt: rfmt,
    price: price,
    qty: qty,
    todayISO: todayISO,
    isoOf: isoOf,
    parseISO: parseISO,
    addDaysISO: addDaysISO,
    formatDate: formatDate,
    weekdayIndex: weekdayIndex,
    monthTitle: monthTitle,
    capitalize: capitalize,
    nowTime: nowTime,
    uid: uid,
    plural: plural,
    sessionOf: sessionOf,
    emotionMeta: emotionMeta,
    moodMeta: moodMeta,
    sum: sum,
    clamp: clamp,
    debounce: debounce,
    download: download,
    bytes: bytes,
    truncate: truncate
  };

  NS.MOODS = MOODS;
  NS.EMOTIONS = EMOTIONS;
  NS.SETUPS = SETUPS;
  NS.WEEKDAY_LABELS = WEEKDAY_LABELS;
  NS.config = { currency: '$' };
})();
