(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const desktop = window.tradeJournalDesktop || null;

  // The storage key is intentionally kept as v1: existing web journals must be
  // discovered and migrated in place instead of being replaced with demo data.
  const KEY = 'tradejournal.v1';
  const SCHEMA_VERSION = 2;
  const DEFAULT_ACCOUNT_NAME = 'Основной счёт';
  // Desktop exports can embed screenshots up to 7.2M chars (see app.js), so the
  // import limit must be at least that high or restoring a backup silently
  // drops screenshots. Web keeps a lower limit because localStorage is small.
  const MAX_SCREENSHOT_LENGTH = desktop ? 8000000 : 3000000;
  const SAFE_SCREENSHOT_RE = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;
  const SAFE_SCREENSHOT_FILE_RE = /^file:screenshots\/[a-z0-9_-]{1,80}\.(?:jpe?g|png|webp)$/i;
  const MAX_AVATAR_LENGTH = 2000000;
  const SAFE_AVATAR_RE = SAFE_SCREENSHOT_RE;
  const DEFAULT_SETTINGS = {
    currency: '$',
    startBalance: 10000,
    riskPercent: 1,
    dailyLossLimit: 3,
    maxTradesPerDay: 3
  };

  let root = blankRoot();
  let loadError = null;
  let pendingMigration = false;

  const state = {};
  Object.defineProperties(state, {
    version: {
      enumerable: true,
      get: function () { return root.version; }
    },
    profile: {
      enumerable: true,
      get: function () { return root.profile; },
      set: function (value) { root.profile = normalizeProfile(value); }
    },
    accounts: {
      enumerable: true,
      get: function () { return root.accounts; },
      set: function (value) { root.accounts = Array.isArray(value) ? value : []; }
    },
    activeAccountId: {
      enumerable: true,
      get: function () { return root.activeAccountId; },
      set: function (value) { root.activeAccountId = String(value || ''); }
    },
    demo: {
      get: function () { const account = activeAccount(); return !!(account && account.demo); },
      set: function (value) { const account = activeAccount(); if (account) account.demo = !!value; }
    },
    settings: {
      get: function () { const account = activeAccount(); return account ? account.settings : DEFAULT_SETTINGS; },
      set: function (value) { const account = activeAccount(); if (account) account.settings = normalizeSettings(value); }
    },
    trades: {
      get: function () { const account = activeAccount(); return account ? account.trades : []; },
      set: function (value) { const account = activeAccount(); if (account) account.trades = Array.isArray(value) ? value : []; }
    },
    notes: {
      get: function () { const account = activeAccount(); return account ? account.notes : []; },
      set: function (value) { const account = activeAccount(); if (account) account.notes = Array.isArray(value) ? value : []; }
    }
  });

  function activeAccount() {
    if (!root || !Array.isArray(root.accounts) || !root.accounts.length) return null;
    let account = root.accounts.find(function (item) { return item.id === root.activeAccountId; });
    if (!account) {
      account = root.accounts[0];
      root.activeAccountId = account.id;
    }
    return account;
  }

  function accountName(value, index) {
    const text = String(value || '').trim().slice(0, 40);
    if (text) return text;
    return index === 0 ? DEFAULT_ACCOUNT_NAME : 'Счёт ' + (index + 1);
  }

  function createAccount(name, settings, index) {
    return {
      id: U.uid(),
      name: accountName(name, index || 0),
      createdAt: new Date().toISOString(),
      demo: false,
      settings: normalizeSettings(settings),
      trades: [],
      notes: []
    };
  }

  function blankRoot() {
    const account = createAccount(DEFAULT_ACCOUNT_NAME, DEFAULT_SETTINGS, 0);
    return {
      version: SCHEMA_VERSION,
      profile: { name: '', avatar: '' },
      activeAccountId: account.id,
      accounts: [account]
    };
  }

  function hasStored() {
    if (desktop) {
      return Promise.resolve().then(function () {
        return desktop.hasData();
      }).catch(function (err) {
        // If the file cannot be checked, report that data may exist so the app
        // does not silently replace it with demo data.
        console.warn('TradeJournal: не удалось проверить файл журнала', err);
        return true;
      });
    }
    try { return Promise.resolve(localStorage.getItem(KEY) !== null); } catch (err) { return Promise.resolve(false); }
  }

  function parseTags(value) {
    if (Array.isArray(value)) {
      return value.map(function (tag) { return String(tag).trim(); }).filter(Boolean).slice(0, 12);
    }
    if (typeof value === 'string') {
      return value.split(',').map(function (tag) { return tag.trim(); }).filter(Boolean).slice(0, 12);
    }
    return [];
  }

  function normalizeTrade(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date.slice(0, 10))
      ? raw.date.slice(0, 10)
      : U.todayISO();
    const symbol = String(raw.symbol || '').trim().toUpperCase();
    if (!symbol) return null;
    const side = raw.side === 'short' ? 'short' : 'long';
    const discipline = U.clamp(Math.round(U.parseNum(raw.discipline) || 0), 0, 5);
    const time = typeof raw.time === 'string' && /^\d{2}:\d{2}/.test(raw.time) ? raw.time.slice(0, 5) : '';
    let shot = '';
    if (typeof raw.screenshot === 'string') {
      if (SAFE_SCREENSHOT_FILE_RE.test(raw.screenshot)) {
        shot = raw.screenshot;
      } else if (raw.screenshot.length <= MAX_SCREENSHOT_LENGTH && SAFE_SCREENSHOT_RE.test(raw.screenshot)) {
        shot = raw.screenshot;
      }
    }
    return {
      id: raw.id ? String(raw.id) : U.uid(),
      date: date,
      time: time,
      symbol: symbol,
      side: side,
      entry: U.parseNum(raw.entry),
      exit: U.parseNum(raw.exit),
      stop: U.parseNum(raw.stop),
      currentStop: U.parseNum(raw.currentStop),
      target: U.parseNum(raw.target),
      qty: U.parseNum(raw.qty),
      fees: U.parseNum(raw.fees) || 0,
      setup: String(raw.setup || '').trim(),
      emotion: String(raw.emotion || '').trim(),
      discipline: discipline,
      tags: parseTags(raw.tags),
      notes: String(raw.notes || ''),
      screenshot: shot
    };
  }

  function normalizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date.slice(0, 10))
      ? raw.date.slice(0, 10)
      : U.todayISO();
    const text = String(raw.text || '').trim();
    if (!text) return null;
    const mood = NS.MOODS[raw.mood] ? raw.mood : 'neutral';
    return {
      id: raw.id ? String(raw.id) : U.uid(),
      date: date,
      mood: mood,
      title: String(raw.title || '').trim(),
      text: text,
      tags: parseTags(raw.tags),
      createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString()
    };
  }

  function normalizeSettings(raw) {
    raw = raw || {};
    const currency = String(raw.currency || '$').slice(0, 3);
    const startBalance = U.parseNum(raw.startBalance);
    const risk = U.parseNum(raw.riskPercent);
    const daily = U.parseNum(raw.dailyLossLimit);
    const maxTrades = U.parseNum(raw.maxTradesPerDay);
    return {
      currency: currency || '$',
      startBalance: startBalance !== null && startBalance >= 0 ? startBalance : 10000,
      riskPercent: risk !== null && risk >= 0 ? U.clamp(risk, 0, 100) : 1,
      dailyLossLimit: daily !== null && daily >= 0 ? U.clamp(daily, 0, 100) : 3,
      maxTradesPerDay: maxTrades !== null && maxTrades >= 0 ? U.clamp(Math.round(maxTrades), 0, 100) : 3
    };
  }

  function normalizeProfile(raw, legacyName) {
    raw = raw || {};
    const name = String(raw.name !== undefined ? raw.name : (legacyName || '')).trim().slice(0, 40);
    let avatar = typeof raw.avatar === 'string' ? raw.avatar : '';
    if (avatar && (avatar.length > MAX_AVATAR_LENGTH || !SAFE_AVATAR_RE.test(avatar))) avatar = '';
    return { name: name, avatar: avatar };
  }

  function normalizeAccount(raw, index, legacy) {
    raw = raw || {};
    legacy = legacy || {};
    const settingsSource = raw.settings !== undefined ? raw.settings : legacy.settings;
    const tradesSource = raw.trades !== undefined ? raw.trades : legacy.trades;
    const notesSource = raw.notes !== undefined ? raw.notes : legacy.notes;

    const seenTradeIds = new Set();
    const trades = (Array.isArray(tradesSource) ? tradesSource : []).map(normalizeTrade).filter(Boolean).map(function (trade) {
      if (seenTradeIds.has(trade.id)) trade.id = U.uid();
      seenTradeIds.add(trade.id);
      return trade;
    });

    const seenNoteIds = new Set();
    const notes = (Array.isArray(notesSource) ? notesSource : []).map(normalizeNote).filter(Boolean).map(function (note) {
      if (seenNoteIds.has(note.id)) note.id = U.uid();
      seenNoteIds.add(note.id);
      return note;
    });

    return {
      id: raw.id ? String(raw.id) : U.uid(),
      name: accountName(raw.name, index),
      createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
      demo: raw.demo !== undefined ? !!raw.demo : !!legacy.demo,
      settings: normalizeSettings(settingsSource),
      trades: trades,
      notes: notes
    };
  }

  function isJournalData(raw) {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw)
      && (Array.isArray(raw.accounts) || (Array.isArray(raw.trades) && Array.isArray(raw.notes)));
  }

  function analyzeImport(raw) {
    const stats = {
      accounts: 0,
      trades: 0,
      tradesAccepted: 0,
      notes: 0,
      notesAccepted: 0,
      screenshots: 0,
      screenshotsAccepted: 0,
      screenshotsDropped: 0,
      fileScreenshots: 0,
      invalidDates: 0,
      missingSymbols: 0
    };
    if (!isJournalData(raw)) return stats;

    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts
      : [{ trades: raw.trades, notes: raw.notes }];

    accounts.forEach(function (account) {
      stats.accounts++;
      const trades = account && Array.isArray(account.trades) ? account.trades : [];
      trades.forEach(function (trade) {
        if (!trade || typeof trade !== 'object') return;
        stats.trades++;
        if (!String(trade.symbol || '').trim()) stats.missingSymbols++;
        if (!(typeof trade.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(trade.date.slice(0, 10)))) {
          stats.invalidDates++;
        }
        if (!normalizeTrade(trade)) return;
        stats.tradesAccepted++;

        const shot = typeof trade.screenshot === 'string' ? trade.screenshot : '';
        if (!shot) return;
        stats.screenshots++;
        if (SAFE_SCREENSHOT_FILE_RE.test(shot)) {
          stats.fileScreenshots++;
          stats.screenshotsAccepted++;
        } else if (shot.length <= MAX_SCREENSHOT_LENGTH && SAFE_SCREENSHOT_RE.test(shot)) {
          stats.screenshotsAccepted++;
        } else {
          stats.screenshotsDropped++;
        }
      });

      const notes = account && Array.isArray(account.notes) ? account.notes : [];
      notes.forEach(function (note) {
        if (!note || typeof note !== 'object') return;
        stats.notes++;
        if (normalizeNote(note)) stats.notesAccepted++;
      });
    });

    return stats;
  }

  function normalizeData(raw) {
    raw = raw || {};
    const isV2 = Array.isArray(raw.accounts);
    let accounts = [];

    if (isV2) {
      accounts = raw.accounts.map(function (account, index) {
        return normalizeAccount(account, index);
      });
    } else {
      accounts = [normalizeAccount({}, 0, {
        settings: raw.settings,
        trades: raw.trades,
        notes: raw.notes,
        demo: raw.demo
      })];
    }

    if (!accounts.length) {
      accounts = [createAccount(DEFAULT_ACCOUNT_NAME, raw.settings, 0)];
    }

    const seenAccountIds = new Set();
    accounts.forEach(function (account) {
      if (seenAccountIds.has(account.id)) account.id = U.uid();
      seenAccountIds.add(account.id);
    });

    const profile = normalizeProfile(raw.profile, raw.settings && raw.settings.name);
    let activeAccountId = raw.activeAccountId ? String(raw.activeAccountId) : '';
    if (!accounts.some(function (account) { return account.id === activeAccountId; })) {
      activeAccountId = accounts[0].id;
    }

    return {
      version: SCHEMA_VERSION,
      profile: profile,
      activeAccountId: activeAccountId,
      accounts: accounts
    };
  }

  function load() {
    const read = desktop
      ? Promise.resolve().then(function () { return desktop.load(); })
      : Promise.resolve().then(function () { return localStorage.getItem(KEY); });

    return read.then(function (raw) {
      if (raw === null || raw === undefined) return false;
      const parsed = JSON.parse(raw);
      if (!isJournalData(parsed)) throw new Error('Неожиданная структура журнала');
      root = normalizeData(parsed);
      pendingMigration = !(parsed.version === SCHEMA_VERSION && Array.isArray(parsed.accounts));
      loadError = null;
      return true;
    }).catch(function (err) {
      loadError = err;
      console.warn('TradeJournal: не удалось прочитать данные', err);
      return false;
    });
  }

  function getRaw() {
    if (desktop) {
      return Promise.resolve().then(function () { return desktop.load(); }).catch(function () { return null; });
    }
    try { return Promise.resolve(localStorage.getItem(KEY)); } catch (err) { return Promise.resolve(null); }
  }

  function clearRaw() {
    if (desktop) {
      return Promise.resolve().then(function () { return desktop.clear(); }).then(function () {
        return true;
      }).catch(function () {
        return false;
      });
    }
    try { localStorage.removeItem(KEY); return Promise.resolve(true); } catch (err) { return Promise.resolve(false); }
  }

  function save() {
    const raw = JSON.stringify(root);
    if (desktop) {
      return Promise.resolve().then(function () { return desktop.save(raw); }).then(function () {
        pendingMigration = false;
        return true;
      }).catch(function (err) {
        console.warn('TradeJournal: не удалось сохранить данные', err);
        return false;
      });
    }
    try {
      localStorage.setItem(KEY, raw);
      pendingMigration = false;
      return Promise.resolve(true);
    } catch (err) {
      console.warn('TradeJournal: не удалось сохранить данные', err);
      return Promise.resolve(false);
    }
  }

  function replaceData(raw) {
    if (!isJournalData(raw)) return false;
    root = normalizeData(raw);
    return save();
  }

  function setDemo(data) {
    const normalized = normalizeData(data);
    const source = normalized.accounts[0];
    const account = activeAccount();
    if (!source || !account) return Promise.resolve(false);
    account.settings = normalizeSettings(source.settings);
    account.trades = source.trades;
    account.notes = source.notes;
    account.demo = true;
    return save();
  }

  function resetData(keepSettings) {
    const account = activeAccount();
    if (!account) return Promise.resolve(false);
    account.trades = [];
    account.notes = [];
    account.demo = false;
    if (!keepSettings) account.settings = normalizeSettings(DEFAULT_SETTINGS);
    return save();
  }

  function setActiveAccount(id) {
    const next = String(id || '');
    if (!root.accounts.some(function (account) { return account.id === next; })) return false;
    root.activeAccountId = next;
    return true;
  }

  function accountById(id) {
    return root.accounts.find(function (account) { return account.id === id; }) || null;
  }

  function addAccount(name) {
    const current = activeAccount();
    const settings = Object.assign({}, DEFAULT_SETTINGS, current ? { currency: current.settings.currency } : {});
    const account = createAccount(name, settings, root.accounts.length);
    root.accounts.push(account);
    root.activeAccountId = account.id;
    return account;
  }

  function renameAccount(id, name) {
    const account = accountById(id);
    const next = String(name || '').trim().slice(0, 40);
    if (!account || !next) return false;
    account.name = next;
    return true;
  }

  function deleteAccount(id) {
    if (root.accounts.length <= 1) return false;
    const index = root.accounts.findIndex(function (account) { return account.id === id; });
    if (index === -1) return false;
    root.accounts.splice(index, 1);
    if (root.activeAccountId === id) {
      const next = root.accounts[Math.min(index, root.accounts.length - 1)];
      root.activeAccountId = next.id;
    }
    return true;
  }

  function saveScreenshotData(dataUrl) {
    if (!desktop) return Promise.resolve(dataUrl);
    if (!SAFE_SCREENSHOT_RE.test(String(dataUrl || ''))) {
      return Promise.reject(new Error('Некорректное изображение скриншота.'));
    }
    return desktop.saveScreenshot(U.uid(), dataUrl).then(function (result) {
      if (result && result.reference) return result.reference;
      if (typeof result === 'string') return result;
      throw new Error('Не удалось сохранить скриншот.');
    });
  }

  function screenshotSource(value) {
    if (!value) return Promise.resolve('');
    if (SAFE_SCREENSHOT_RE.test(value)) return Promise.resolve(value);
    if (desktop && SAFE_SCREENSHOT_FILE_RE.test(value)) {
      return Promise.resolve().then(function () {
        return desktop.loadScreenshot(value);
      }).catch(function (err) {
        console.warn('TradeJournal: не удалось загрузить скриншот', err);
        return '';
      });
    }
    return Promise.resolve('');
  }

  async function migrateScreenshots() {
    if (!desktop) return 0;
    let changed = 0;
    for (const account of root.accounts) {
      for (const trade of account.trades) {
        if (!SAFE_SCREENSHOT_RE.test(trade.screenshot || '')) continue;
        try {
          const result = await desktop.saveScreenshot(U.uid(), trade.screenshot);
          const reference = result && result.reference ? result.reference : '';
          if (reference) {
            trade.screenshot = reference;
            changed++;
          }
        } catch (err) {
          console.warn('TradeJournal: не удалось вынести скриншот в файл', err);
        }
      }
    }
    if (changed) await save();
    return changed;
  }

  async function exportSnapshot() {
    const snapshot = JSON.parse(JSON.stringify(root));
    if (!desktop) return snapshot;
    for (const account of snapshot.accounts) {
      for (const trade of account.trades) {
        if (!SAFE_SCREENSHOT_FILE_RE.test(trade.screenshot || '')) continue;
        try {
          const dataUrl = await desktop.loadScreenshot(trade.screenshot);
          if (dataUrl) trade.screenshot = dataUrl;
        } catch (err) {
          console.warn('TradeJournal: не удалось вложить скриншот в экспорт', err);
        }
      }
    }
    return snapshot;
  }

  function isClosed(trade) {
    return !!trade && U.parseNum(trade.exit) !== null;
  }

  function tradePnl(trade) {
    if (!trade) return null;
    const entry = U.parseNum(trade.entry);
    const exit = U.parseNum(trade.exit);
    const quantity = U.parseNum(trade.qty);
    if (entry === null || exit === null || quantity === null) return null;
    const dir = trade.side === 'short' ? -1 : 1;
    const fees = U.parseNum(trade.fees) || 0;
    return (exit - entry) * quantity * dir - fees;
  }

  function tradeRisk(trade) {
    if (!trade) return null;
    const entry = U.parseNum(trade.entry);
    const stop = U.parseNum(trade.stop);
    const quantity = U.parseNum(trade.qty);
    if (entry === null || stop === null || quantity === null) return null;
    const risk = Math.abs(entry - stop) * quantity;
    return risk > 0 ? risk : null;
  }

  function tradeR(trade) {
    const pnl = tradePnl(trade);
    const risk = tradeRisk(trade);
    if (pnl === null || risk === null) return null;
    return pnl / risk;
  }

  function plannedRR(trade) {
    if (!trade) return null;
    const entry = U.parseNum(trade.entry);
    const stop = U.parseNum(trade.stop);
    const target = U.parseNum(trade.target);
    if (entry === null || stop === null || target === null) return null;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    return Math.abs(target - entry) / risk;
  }

  function sortKey(trade) {
    return (trade.date || '') + ' ' + (trade.time || '00:00');
  }

  function sortTrades(list, dir) {
    const factor = dir === 'asc' ? 1 : -1;
    return (list || []).slice().sort(function (a, b) {
      return sortKey(a).localeCompare(sortKey(b)) * factor;
    });
  }

  function metrics(trades, startBalance) {
    const closed = sortTrades((trades || []).filter(isClosed), 'asc');
    const rows = [];
    closed.forEach(function (trade) {
      const pnl = tradePnl(trade);
      if (pnl === null) return;
      rows.push({ trade: trade, pnl: pnl, r: tradeR(trade) });
    });

    let wins = 0, losses = 0, be = 0;
    let grossProfit = 0, grossLoss = 0, fees = 0;
    let rSum = 0, rCount = 0;
    let discSum = 0, discCount = 0;
    let best = null, worst = null;

    rows.forEach(function (row) {
      const pnl = row.pnl;
      if (pnl > 0.004) { wins++; grossProfit += pnl; }
      else if (pnl < -0.004) { losses++; grossLoss += pnl; }
      else be++;
      fees += U.parseNum(row.trade.fees) || 0;
      if (row.r !== null) { rSum += row.r; rCount++; }
      const disc = U.parseNum(row.trade.discipline);
      if (disc !== null && disc > 0) { discSum += disc; discCount++; }
      if (!best || pnl > best.pnl) best = row;
      if (!worst || pnl < worst.pnl) worst = row;
    });

    const count = rows.length;
    const net = grossProfit + grossLoss;
    const base = U.parseNum(startBalance) || 0;

    let equity = 0, peak = 0, maxDD = 0, maxDDPct = 0;
    rows.forEach(function (row) {
      equity += row.pnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) {
        maxDD = dd;
        const peakBalance = base + peak;
        maxDDPct = peakBalance > 0 ? (dd / peakBalance) * 100 : 0;
      }
    });

    let maxWinStreak = 0, maxLossStreak = 0;
    let currentType = null, currentLen = 0;
    rows.forEach(function (row) {
      const type = row.pnl > 0.004 ? 'win' : (row.pnl < -0.004 ? 'loss' : 'be');
      if (type === 'be') { currentType = null; currentLen = 0; return; }
      if (type === currentType) currentLen++;
      else { currentType = type; currentLen = 1; }
      if (type === 'win') maxWinStreak = Math.max(maxWinStreak, currentLen);
      else maxLossStreak = Math.max(maxLossStreak, currentLen);
    });

    return {
      rows: rows,
      closed: closed,
      count: count,
      wins: wins,
      losses: losses,
      be: be,
      winRate: count ? (wins / count) * 100 : 0,
      net: net,
      grossProfit: grossProfit,
      grossLoss: grossLoss,
      avgWin: wins ? grossProfit / wins : 0,
      avgLoss: losses ? Math.abs(grossLoss) / losses : 0,
      profitFactor: grossLoss < -0.0001 ? grossProfit / Math.abs(grossLoss) : (grossProfit > 0.0001 ? Infinity : 0),
      expectancy: count ? net / count : 0,
      avgR: rCount ? rSum / rCount : 0,
      totalR: rSum,
      rCount: rCount,
      fees: fees,
      maxDD: maxDD,
      maxDDPct: maxDDPct,
      maxWinStreak: maxWinStreak,
      maxLossStreak: maxLossStreak,
      currentStreak: currentType ? { type: currentType, n: currentLen } : null,
      best: best,
      worst: worst,
      avgDiscipline: discCount ? discSum / discCount : 0,
      startBalance: base,
      endBalance: base + net
    };
  }

  function groupRows(rows, keyFn) {
    const map = new Map();
    rows.forEach(function (row) {
      const rawKey = keyFn(row.trade);
      const key = (rawKey === null || rawKey === undefined || rawKey === '') ? '—' : String(rawKey);
      let group = map.get(key);
      if (!group) {
        group = { key: key, count: 0, pnl: 0, wins: 0, losses: 0, be: 0, grossProfit: 0, grossLoss: 0, rSum: 0, rCount: 0 };
        map.set(key, group);
      }
      group.count++;
      group.pnl += row.pnl;
      if (row.pnl > 0.004) { group.wins++; group.grossProfit += row.pnl; }
      else if (row.pnl < -0.004) { group.losses++; group.grossLoss += row.pnl; }
      else group.be++;
      if (row.r !== null) { group.rSum += row.r; group.rCount++; }
    });
    return Array.from(map.values()).map(function (group) {
      return {
        key: group.key,
        count: group.count,
        pnl: group.pnl,
        wins: group.wins,
        losses: group.losses,
        be: group.be,
        winRate: group.count ? (group.wins / group.count) * 100 : 0,
        avgR: group.rCount ? group.rSum / group.rCount : 0,
        rCount: group.rCount,
        grossProfit: group.grossProfit,
        grossLoss: group.grossLoss,
        profitFactor: group.grossLoss < -0.0001 ? group.grossProfit / Math.abs(group.grossLoss) : (group.grossProfit > 0.0001 ? Infinity : 0)
      };
    });
  }

  function balanceAll() {
    let net = 0;
    state.trades.filter(isClosed).forEach(function (trade) {
      const pnl = tradePnl(trade);
      if (pnl !== null) net += pnl;
    });
    return (U.parseNum(state.settings.startBalance) || 0) + net;
  }

  function storageSize() {
    try { return new Blob([JSON.stringify(root)]).size; } catch (err) { return 0; }
  }

  NS.store = {
    KEY: KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_ACCOUNT_NAME: DEFAULT_ACCOUNT_NAME,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    get state() { return state; },
    get loadError() { return loadError; },
    get needsMigration() { return pendingMigration; },
    hasStored: hasStored,
    isJournalData: isJournalData,
    analyzeImport: analyzeImport,
    load: load,
    getRaw: getRaw,
    clearRaw: clearRaw,
    save: save,
    replaceData: replaceData,
    setDemo: setDemo,
    resetData: resetData,
    activeAccount: activeAccount,
    accountById: accountById,
    setActiveAccount: setActiveAccount,
    addAccount: addAccount,
    renameAccount: renameAccount,
    deleteAccount: deleteAccount,
    saveScreenshot: saveScreenshotData,
    screenshotSource: screenshotSource,
    migrateScreenshots: migrateScreenshots,
    exportSnapshot: exportSnapshot,
    isClosed: isClosed,
    tradePnl: tradePnl,
    tradeRisk: tradeRisk,
    tradeR: tradeR,
    plannedRR: plannedRR,
    sortTrades: sortTrades,
    metrics: metrics,
    groupRows: groupRows,
    balanceAll: balanceAll,
    storageSize: storageSize,
    normalizeTrade: normalizeTrade
  };
})();
