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

  // Session boundaries are stored as start times in the account's timezone.
  // The last session wraps around midnight and lasts until the first one.
  const DEFAULT_SESSIONS = [
    { key: 'asia', name: 'Азия', start: '00:00' },
    { key: 'london', name: 'Лондон', start: '09:00' },
    { key: 'newYork', name: 'Нью-Йорк', start: '13:00' },
    { key: 'evening', name: 'Вечер', start: '18:00' }
  ];

  const zoneValidity = new Map();
  const zoneFormatters = new Map();
  let sessionCacheKey = '';
  let sessionCache = null;

  function systemTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (err) {
      return 'UTC';
    }
  }

  function validTimeZone(value) {
    if (!value || typeof value !== 'string') return false;
    const name = value.trim();
    if (!name) return false;
    if (zoneValidity.has(name)) return zoneValidity.get(name);
    let valid;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: name }).format(new Date());
      valid = true;
    } catch (err) {
      valid = false;
    }
    zoneValidity.set(name, valid);
    return valid;
  }

  function zoneFormatter(timeZone) {
    const zone = validTimeZone(timeZone) ? timeZone : systemTimeZone();
    if (!zoneFormatters.has(zone)) {
      zoneFormatters.set(zone, new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }));
    }
    return zoneFormatters.get(zone);
  }

  function zonedParts(epochMs, timeZone) {
    const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs));
    const values = {};
    parts.forEach(function (part) {
      if (part.type !== 'literal') values[part.type] = part.value;
    });
    let hour = Number(values.hour);
    if (hour === 24) hour = 0;
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: hour,
      minute: Number(values.minute),
      second: Number(values.second || 0)
    };
  }

  function utcToZoned(iso, timeZone) {
    if (typeof iso !== 'string' || !iso) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const parts = zonedParts(ms, timeZone);
    return {
      date: parts.year + '-' + pad(parts.month) + '-' + pad(parts.day),
      time: pad(parts.hour) + ':' + pad(parts.minute)
    };
  }

  function validDateISO(value) {
    if (typeof value !== 'string') return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return match[0].slice(0, 10);
  }

  function validTimeHM(value) {
    if (typeof value !== 'string') return '';
    const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
    if (!match) return '';
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
    return pad(hours) + ':' + pad(minutes);
  }

  function normalizeUtc(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  // Converts a wall-clock date/time in the selected IANA timezone to a UTC
  // instant. Two passes cover DST offsets; a third settles unusual zones.
  function zonedToUtc(dateISO, timeHM, timeZone) {
    const date = validDateISO(dateISO);
    const time = validTimeHM(timeHM);
    if (!date || !time) return null;
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const hours = Number(time.slice(0, 2));
    const minutes = Number(time.slice(3, 5));
    const desired = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
    let guess = desired;
    for (let i = 0; i < 4; i++) {
      const parts = zonedParts(guess, timeZone);
      const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
      const diff = desired - actual;
      if (diff === 0) break;
      guess += diff;
    }
    return new Date(guess).toISOString();
  }

  function sessionList(sessions) {
    const source = Array.isArray(sessions) ? sessions : [];
    const key = JSON.stringify(source);
    if (sessionCache && key === sessionCacheKey) return sessionCache;
    const byKey = {};
    source.forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      const fallback = DEFAULT_SESSIONS[index];
      const keyName = DEFAULT_SESSIONS.some(function (session) { return session.key === item.key; })
        ? item.key
        : (fallback ? fallback.key : '');
      if (!keyName) return;
      const definition = DEFAULT_SESSIONS.find(function (session) { return session.key === keyName; });
      byKey[keyName] = {
        key: keyName,
        name: String(item.name || '').trim().slice(0, 24) || definition.name,
        start: validTimeHM(item.start) || definition.start
      };
    });
    const list = DEFAULT_SESSIONS.map(function (definition) {
      return byKey[definition.key] || { key: definition.key, name: definition.name, start: definition.start };
    });
    list.sort(function (a, b) {
      return a.start.localeCompare(b.start) || DEFAULT_SESSIONS.findIndex(function (s) { return s.key === a.key; })
        - DEFAULT_SESSIONS.findIndex(function (s) { return s.key === b.key; });
    });
    sessionCacheKey = key;
    sessionCache = list;
    return list;
  }

  function normalizeSessions(sessions) {
    return sessionList(sessions).map(function (session) {
      return { key: session.key, name: session.name, start: session.start };
    });
  }

  function sessionStartMinutes(session) {
    return Number(session.start.slice(0, 2)) * 60 + Number(session.start.slice(3, 5));
  }

  function sessionOf(time, sessions) {
    if (!time || typeof time !== 'string') return 'Без времени';
    const value = validTimeHM(time);
    if (!value) return 'Без времени';
    const minutes = Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    const list = sessionList(sessions);
    let current = list[list.length - 1];
    list.forEach(function (session) {
      if (minutes >= sessionStartMinutes(session)) current = session;
    });
    return current.name;
  }

  function sessionNames(sessions) {
    return sessionList(sessions).map(function (session) { return session.name; });
  }

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

  function todayISO(timeZone) {
    if (timeZone) {
      const zoned = utcToZoned(new Date().toISOString(), timeZone);
      if (zoned) return zoned.date;
    }
    return isoOf(new Date());
  }

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

  function nowTime(timeZone) {
    if (timeZone) {
      const zoned = utcToZoned(new Date().toISOString(), timeZone);
      if (zoned) return zoned.time;
    }
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

  function saveWebBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function download(filename, content, mime) {
    const desktop = window.tradeJournalDesktop;
    if (desktop && typeof desktop.saveDownload === 'function') {
      desktop.saveDownload(filename, String(content), mime || '').catch(function (err) {
        const message = err && err.message ? err.message : String(err || 'Не удалось сохранить файл.');
        window.dispatchEvent(new CustomEvent('tj:download-error', { detail: message }));
      });
      return;
    }

    saveWebBlob(filename, new Blob([content], { type: mime || 'text/plain;charset=utf-8' }));
  }

  function bytesToBase64(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < data.length; i += chunk) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function downloadBytes(filename, bytes, mime) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const desktop = window.tradeJournalDesktop;
    if (desktop && typeof desktop.saveDownloadBytes === 'function') {
      let encoded;
      try {
        encoded = bytesToBase64(data);
      } catch (err) {
        window.dispatchEvent(new CustomEvent('tj:download-error', { detail: 'Не удалось подготовить файл для сохранения.' }));
        return;
      }
      desktop.saveDownloadBytes(filename, encoded, mime || '').catch(function (err) {
        const message = err && err.message ? err.message : String(err || 'Не удалось сохранить файл.');
        window.dispatchEvent(new CustomEvent('tj:download-error', { detail: message }));
      });
      return;
    }
    saveWebBlob(filename, new Blob([data], { type: mime || 'application/octet-stream' }));
  }

  function bytes(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(2).replace('.', ',') + ' МБ';
    if (value >= 1024) return Math.round(value / 1024) + ' КБ';
    return Math.round(value) + ' Б';
  }

  const BACKUP_REMIND_MS = 7 * 24 * 60 * 60 * 1000;

  function shouldRemindBackup(meta, nowMs, tradesCount) {
    const count = Number(tradesCount);
    if (!Number.isFinite(count) || count <= 0) return false;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const remindLater = Date.parse(meta && meta.remindLaterUntil);
    if (Number.isFinite(remindLater) && remindLater > now) return false;
    const lastExport = Date.parse(meta && meta.lastExportAt);
    if (!Number.isFinite(lastExport)) return true;
    return now - lastExport >= BACKUP_REMIND_MS;
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
    sessionNames: sessionNames,
    normalizeSessions: normalizeSessions,
    systemTimeZone: systemTimeZone,
    validTimeZone: validTimeZone,
    validDateISO: validDateISO,
    validTimeHM: validTimeHM,
    normalizeUtc: normalizeUtc,
    utcToZoned: utcToZoned,
    zonedToUtc: zonedToUtc,
    emotionMeta: emotionMeta,
    moodMeta: moodMeta,
    sum: sum,
    clamp: clamp,
    debounce: debounce,
    download: download,
    downloadBytes: downloadBytes,
    bytesToBase64: bytesToBase64,
    bytes: bytes,
    shouldRemindBackup: shouldRemindBackup,
    BACKUP_REMIND_MS: BACKUP_REMIND_MS,
    truncate: truncate
  };

  NS.MOODS = MOODS;
  NS.EMOTIONS = EMOTIONS;
  NS.SETUPS = SETUPS;
  NS.WEEKDAY_LABELS = WEEKDAY_LABELS;
  NS.DEFAULT_SESSIONS = DEFAULT_SESSIONS;
  NS.config = { currency: '$' };
})();
