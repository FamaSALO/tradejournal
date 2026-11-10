(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const desktop = window.tradeJournalDesktop || null;

  // The storage key is intentionally kept as v1: existing web journals must be
  // discovered and migrated in place instead of being replaced with demo data.
  const KEY = 'tradejournal.v1';
  const META_KEY = 'tradejournal.meta';
  const SCHEMA_VERSION = 4;
  const DEFAULT_ACCOUNT_NAME = 'Основной счёт';
  const MAX_EXITS = 50;
  const MULTIPLIER_MIN = 0.000000001;
  const MULTIPLIER_MAX = 1000000000;
  const QTY_EPSILON = 1e-9;
  // Desktop exports can embed screenshots up to 7.2M chars (see app.js), so the
  // import limit must be at least that high or restoring a backup silently
  // drops screenshots. Web keeps a lower limit because localStorage is small.
  const MAX_SCREENSHOT_LENGTH = desktop ? 8000000 : 3000000;
  const SAFE_SCREENSHOT_RE = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;
  const SAFE_SCREENSHOT_FILE_RE = /^file:screenshots\/[a-z0-9_-]{1,80}\.(?:jpe?g|png|webp)$/i;
  const IDB_SCREENSHOT_RE = /^idb:screenshots\/[a-z0-9-]{1,80}$/i;
  // Refs used earlier in this session stay protected so that undo can restore
  // a deleted or replaced screenshot. They are collected on the next launch.
  const sessionScreenshotRefs = new Set();
  const MAX_AVATAR_LENGTH = 2000000;
  const SAFE_AVATAR_RE = SAFE_SCREENSHOT_RE;
  const DEFAULT_SETTINGS = {
    currency: '$',
    startBalance: 10000,
    riskPercent: 1,
    dailyLossLimit: 3,
    maxTradesPerDay: 3,
    timezone: U.systemTimeZone(),
    sessions: U.normalizeSessions()
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
      set: function (value) {
        const account = activeAccount();
        if (!account) return;
        account.settings = normalizeSettings(value);
        retimeAccountTrades(account);
      }
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

  function localizedDefaultName() {
    return NS.i18n && typeof NS.i18n.t === 'function' ? NS.i18n.t(DEFAULT_ACCOUNT_NAME) : DEFAULT_ACCOUNT_NAME;
  }

  function accountName(value, index) {
    const text = String(value || '').trim().slice(0, 40);
    if (text) return text;
    if (index === 0) return localizedDefaultName();
    return (NS.i18n && typeof NS.i18n.t === 'function' ? NS.i18n.t('Счёт') : 'Счёт') + ' ' + (index + 1);
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
    const account = createAccount(localizedDefaultName(), DEFAULT_SETTINGS, 0);
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

  function normalizeMultiplier(value) {
    const parsed = U.parseNum(value);
    if (parsed === null || !isFinite(parsed) || parsed <= 0) return 1;
    return U.clamp(parsed, MULTIPLIER_MIN, MULTIPLIER_MAX);
  }

  function normalizeExitDate(value, fallback) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))
      ? value.slice(0, 10)
      : fallback;
  }

  function normalizeExit(raw, fallbackDate) {
    if (!raw || typeof raw !== 'object') return null;
    const qty = U.parseNum(raw.qty);
    let price = U.parseNum(raw.price);
    if (price === null && raw.price === undefined) price = U.parseNum(raw.exit);
    if (qty === null || qty <= 0 || price === null) return null;
    return {
      id: raw.id ? String(raw.id) : U.uid(),
      qty: qty,
      price: price,
      date: normalizeExitDate(raw.date, fallbackDate),
      fees: Math.max(0, U.parseNum(raw.fees) || 0)
    };
  }

  function allocateExitFees(exits, totalFees, positionQty) {
    if (!exits.length) return;
    const total = Math.max(0, totalFees || 0);
    const qtySum = exits.reduce(function (sum, exit) { return sum + exit.qty; }, 0);
    if (qtySum <= QTY_EPSILON) {
      exits.forEach(function (exit) { exit.fees = 0; });
      return;
    }
    const quantity = U.parseNum(positionQty);
    const position = quantity !== null && quantity > 0 ? quantity : qtySum;
    const fullyClosed = qtySum >= position - QTY_EPSILON;
    // Over-closing is normalised by the actual exits sum. A partial position
    // keeps the uncharged fee share until another exit is added.
    const denominator = Math.max(position, qtySum);
    let assigned = 0;
    exits.forEach(function (exit, index) {
      if (fullyClosed && index === exits.length - 1) {
        exit.fees = Math.round(Math.max(0, total - assigned) * 1e8) / 1e8;
        return;
      }
      const share = Math.round((total * exit.qty / denominator) * 1e8) / 1e8;
      exit.fees = share;
      assigned += share;
    });
  }

  function sumExitQty(exits) {
    return (exits || []).reduce(function (sum, exit) {
      const qty = U.parseNum(exit && exit.qty);
      return sum + (qty !== null && qty > 0 ? qty : 0);
    }, 0);
  }

  function weightedExitFromExits(exits) {
    const list = exits || [];
    let qtySum = 0;
    let value = 0;
    list.forEach(function (exit) {
      const qty = U.parseNum(exit && exit.qty);
      const price = U.parseNum(exit && exit.price);
      if (qty === null || qty <= 0 || price === null) return;
      qtySum += qty;
      value += qty * price;
    });
    return qtySum > QTY_EPSILON ? value / qtySum : null;
  }

  function normalizeExits(raw, trade) {
    const exits = [];
    const seenIds = new Set();
    const source = Array.isArray(raw.exits) ? raw.exits.slice(0, MAX_EXITS) : [];
    source.forEach(function (item) {
      const exit = normalizeExit(item, trade.date);
      if (!exit) return;
      if (seenIds.has(exit.id)) exit.id = U.uid();
      seenIds.add(exit.id);
      exits.push(exit);
    });

    const quantity = U.parseNum(raw.qty);
    if (!exits.length && quantity !== null && quantity > 0) {
      const legacyPrice = U.parseNum(raw.exit);
      if (legacyPrice !== null) {
        exits.push({
          id: U.uid(),
          qty: quantity,
          price: legacyPrice,
          date: trade.date,
          fees: 0
        });
      }
    }

    allocateExitFees(exits, trade.fees, trade.qty);
    return exits;
  }

  function normalizeTrade(raw, options) {
    if (!raw || typeof raw !== 'object') return null;
    options = options || {};
    const timeZone = U.validTimeZone(options.timeZone) ? options.timeZone : U.systemTimeZone();
    const rawDate = U.validDateISO(raw.date);
    const rawTime = U.validTimeHM(raw.time);
    let timeUtc = U.normalizeUtc(raw.timeUtc);
    let date = rawDate;
    let time = rawTime;

    if (timeUtc) {
      const zoned = U.utcToZoned(timeUtc, timeZone);
      if (zoned) {
        date = zoned.date;
        time = zoned.time;
      } else {
        timeUtc = null;
      }
    }

    if (!date) {
      // A broken date is data loss on import, so strict mode drops the trade
      // instead of silently moving it to today.
      if (options.strictDate) return null;
      date = U.todayISO(timeZone);
    }
    if (!timeUtc && date && time) timeUtc = U.zonedToUtc(date, time, timeZone);

    const symbol = String(raw.symbol || '').trim().toUpperCase();
    if (!symbol) return null;
    const side = raw.side === 'short' ? 'short' : 'long';
    const discipline = U.clamp(Math.round(U.parseNum(raw.discipline) || 0), 0, 5);
    let shot = '';
    if (typeof raw.screenshot === 'string') {
      if (SAFE_SCREENSHOT_FILE_RE.test(raw.screenshot)) {
        shot = raw.screenshot;
      } else if (!desktop && IDB_SCREENSHOT_RE.test(raw.screenshot)) {
        shot = raw.screenshot;
      } else if (raw.screenshot.length <= MAX_SCREENSHOT_LENGTH && SAFE_SCREENSHOT_RE.test(raw.screenshot)) {
        shot = raw.screenshot;
      }
    }
    const qty = U.parseNum(raw.qty);
    let fees = U.parseNum(raw.fees);
    if (fees === null) {
      fees = (Array.isArray(raw.exits) ? raw.exits : []).reduce(function (sum, exit) {
        return sum + Math.max(0, U.parseNum(exit && exit.fees) || 0);
      }, 0);
    }
    fees = Math.max(0, fees || 0);
    const multiplier = normalizeMultiplier(raw.multiplier);
    const exits = normalizeExits(raw, { date: date, qty: qty, fees: fees });
    const fullyClosed = qty !== null && qty > 0 && sumExitQty(exits) >= qty - QTY_EPSILON;
    // A malformed legacy trade may have an exit price but no quantity. Keep the
    // original exit value instead of dropping data that cannot become a canonical exit.
    const legacyExit = U.parseNum(raw.exit);
    const keepLegacyExit = !exits.length && legacyExit !== null && (qty === null || qty <= 0);
    return {
      id: raw.id ? String(raw.id) : U.uid(),
      date: date,
      time: time,
      timeUtc: timeUtc,
      symbol: symbol,
      side: side,
      entry: U.parseNum(raw.entry),
      exit: fullyClosed ? weightedExitFromExits(exits) : (keepLegacyExit ? legacyExit : null),
      stop: U.parseNum(raw.stop),
      currentStop: U.parseNum(raw.currentStop),
      target: U.parseNum(raw.target),
      qty: qty,
      multiplier: multiplier,
      fees: fees,
      exits: exits,
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

  function retimeAccountTrades(account) {
    if (!account || !account.settings || !Array.isArray(account.trades)) return;
    const timeZone = account.settings.timezone;
    account.trades.forEach(function (trade) {
      if (!trade || !trade.timeUtc) return;
      const zoned = U.utcToZoned(trade.timeUtc, timeZone);
      if (!zoned) return;
      trade.date = zoned.date;
      trade.time = zoned.time;
    });
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
      maxTradesPerDay: maxTrades !== null && maxTrades >= 0 ? U.clamp(Math.round(maxTrades), 0, 100) : 3,
      timezone: U.validTimeZone(raw.timezone) ? raw.timezone : U.systemTimeZone(),
      sessions: U.normalizeSessions(raw.sessions)
    };
  }

  function normalizeProfile(raw, legacyName) {
    raw = raw || {};
    const name = String(raw.name !== undefined ? raw.name : (legacyName || '')).trim().slice(0, 40);
    let avatar = typeof raw.avatar === 'string' ? raw.avatar : '';
    if (avatar && (avatar.length > MAX_AVATAR_LENGTH || !SAFE_AVATAR_RE.test(avatar))) avatar = '';
    return { name: name, avatar: avatar };
  }

  function normalizeAccount(raw, index, legacy, options) {
    raw = raw || {};
    legacy = legacy || {};
    const settingsSource = raw.settings !== undefined ? raw.settings : legacy.settings;
    const tradesSource = raw.trades !== undefined ? raw.trades : legacy.trades;
    const notesSource = raw.notes !== undefined ? raw.notes : legacy.notes;
    const settings = normalizeSettings(settingsSource);
    const tradeOptions = {
      timeZone: settings.timezone,
      strictDate: !!(options && options.strictDate)
    };

    const seenTradeIds = new Set();
    const trades = (Array.isArray(tradesSource) ? tradesSource : []).map(function (rawTrade) {
      return normalizeTrade(rawTrade, tradeOptions);
    }).filter(Boolean).map(function (trade) {
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
      settings: settings,
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
      screenshotsTooLarge: 0,
      screenshotsInvalid: 0,
      fileScreenshots: 0,
      idbScreenshots: 0,
      invalidDates: 0,
      missingSymbols: 0,
      tradesDropped: 0,
      notesDropped: 0,
      closedTrades: 0,
      partialTrades: 0,
      openTrades: 0,
      exitRecords: 0,
      multiplierTrades: 0,
      invalidExits: 0
    };
    if (!isJournalData(raw)) return stats;

    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts
      : [{ trades: raw.trades, notes: raw.notes }];

    accounts.forEach(function (account) {
      stats.accounts++;
      const settings = normalizeSettings(
        account && account.settings !== undefined ? account.settings : raw.settings
      );
      const trades = account && Array.isArray(account.trades) ? account.trades : [];
      trades.forEach(function (trade) {
        if (!trade || typeof trade !== 'object') return;
        stats.trades++;
        const symbol = String(trade.symbol || '').trim();
        const hasDate = !!U.validDateISO(trade.date);
        const hasUtc = !!U.normalizeUtc(trade.timeUtc);
        if (!symbol) stats.missingSymbols++;
        else if (!hasDate && !hasUtc) stats.invalidDates++;

        const normalized = normalizeTrade(trade, {
          timeZone: settings.timezone,
          strictDate: true
        });
        if (!normalized) return;
        stats.tradesAccepted++;
        stats.exitRecords += normalized.exits.length;
        if (normalized.multiplier !== 1) stats.multiplierTrades++;
        if (isClosed(normalized)) stats.closedTrades++;
        else if (isPartial(normalized)) stats.partialTrades++;
        else stats.openTrades++;

        const rawExits = Array.isArray(trade.exits) ? trade.exits : [];
        if (rawExits.length) {
          const validExits = rawExits.filter(function (exit) {
            return !!normalizeExit(exit, normalized.date);
          }).length;
          stats.invalidExits += Math.max(0, rawExits.length - validExits);
        }

        const shot = typeof trade.screenshot === 'string' ? trade.screenshot : '';
        if (!shot) return;
        stats.screenshots++;
        if (SAFE_SCREENSHOT_FILE_RE.test(shot)) {
          stats.fileScreenshots++;
          stats.screenshotsAccepted++;
        } else if (!desktop && IDB_SCREENSHOT_RE.test(shot)) {
          stats.idbScreenshots++;
          stats.screenshotsAccepted++;
        } else if (shot.length <= MAX_SCREENSHOT_LENGTH && SAFE_SCREENSHOT_RE.test(shot)) {
          stats.screenshotsAccepted++;
        } else {
          stats.screenshotsDropped++;
          if (shot.length > MAX_SCREENSHOT_LENGTH) stats.screenshotsTooLarge++;
          else stats.screenshotsInvalid++;
        }
      });

      const notes = account && Array.isArray(account.notes) ? account.notes : [];
      notes.forEach(function (note) {
        if (!note || typeof note !== 'object') return;
        stats.notes++;
        if (normalizeNote(note)) stats.notesAccepted++;
      });
    });

    stats.tradesDropped = stats.missingSymbols + stats.invalidDates;
    stats.notesDropped = stats.notes - stats.notesAccepted;
    return stats;
  }

  function normalizeData(raw, options) {
    raw = raw || {};
    const isV2 = Array.isArray(raw.accounts);
    let accounts;

    if (isV2) {
      accounts = raw.accounts.map(function (account, index) {
        return normalizeAccount(account, index, null, options);
      });
    } else {
      accounts = [normalizeAccount({}, 0, {
        settings: raw.settings,
        trades: raw.trades,
        notes: raw.notes,
        demo: raw.demo
      }, options)];
    }

    if (!accounts.length) {
      accounts = [createAccount(localizedDefaultName(), raw.settings, 0)];
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
      return gcScreenshots().then(function () {
        return true;
      }, function () {
        return true;
      });
    } catch (err) {
      console.warn('TradeJournal: не удалось сохранить данные', err);
      return Promise.resolve(false);
    }
  }

  async function replaceData(raw, options) {
    if (!isJournalData(raw)) return false;
    root = normalizeData(raw, options);
    // Move embedded screenshots out of the journal before the first save so a
    // large import does not hit the localStorage quota.
    if (!desktop) await migrateScreenshotData();
    return save();
  }

  function setDemo(data) {
    const account = activeAccount();
    const source = data && Array.isArray(data.accounts) ? data.accounts[0] : data;
    if (!account || !source || typeof source !== 'object') return Promise.resolve(false);
    // Demo values may change risk settings, but the account timezone and
    // session boundaries stay under the user's control.
    const settings = normalizeSettings(Object.assign({}, source.settings || {}, {
      timezone: account.settings.timezone,
      sessions: account.settings.sessions
    }));
    account.settings = settings;
    account.trades = (Array.isArray(source.trades) ? source.trades : [])
      .map(function (raw) { return normalizeTrade(raw, { timeZone: settings.timezone }); })
      .filter(Boolean);
    account.notes = (Array.isArray(source.notes) ? source.notes : []).map(normalizeNote).filter(Boolean);
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
    const settings = Object.assign({}, DEFAULT_SETTINGS, current ? current.settings : {});
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

  function getBlobStore() {
    if (desktop || !NS.blobStore || typeof NS.blobStore.getDefault !== 'function') return null;
    return NS.blobStore.getDefault();
  }

  function saveScreenshotData(dataUrl) {
    const value = String(dataUrl || '');
    if (!SAFE_SCREENSHOT_RE.test(value)) {
      return Promise.reject(new Error('Некорректное изображение скриншота.'));
    }
    if (desktop) {
      return desktop.saveScreenshot(U.uid(), value).then(function (result) {
        if (result && result.reference) return result.reference;
        if (typeof result === 'string') return result;
        throw new Error('Не удалось сохранить скриншот.');
      });
    }
    const blobs = getBlobStore();
    if (!blobs) return Promise.resolve(value);
    return blobs.save(value).then(function (ref) {
      // The browser prompt is only useful after a screenshot has actually
      // landed in IndexedDB, so startup and migrations stay silent.
      requestPersistentStorageOnce();
      return ref;
    }, function (err) {
      // Keep the journal usable when IndexedDB is unavailable (for example in
      // a private window); the caller stores the data URL as before.
      console.warn('TradeJournal: не удалось сохранить скриншот в IndexedDB', err);
      return value;
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
    if (!desktop && IDB_SCREENSHOT_RE.test(value)) {
      const blobs = getBlobStore();
      if (!blobs) return Promise.resolve('');
      return blobs.load(value);
    }
    return Promise.resolve('');
  }

  async function migrateScreenshotData() {
    let changed = 0;
    if (desktop) {
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
      return changed;
    }

    const blobs = getBlobStore();
    if (!blobs) return 0;
    for (const account of root.accounts) {
      for (const trade of account.trades) {
        if (!SAFE_SCREENSHOT_RE.test(trade.screenshot || '')) continue;
        try {
          // Persist to IndexedDB first, verify the value round-trips, and
          // only then replace the inline reference and save the journal.
          // Any failure leaves the original inline data URL intact.
          var ref = await blobs.save(trade.screenshot);
          var roundtrip = await blobs.load(ref);
          if (!roundtrip) throw new Error('Round-trip check failed');
          trade.screenshot = ref;
          changed++;
        } catch (err) {
          console.warn('TradeJournal: не удалось перенести скриншот в IndexedDB', err);
        }
      }
    }
    return changed;
  }

  async function migrateScreenshots() {
    const changed = await migrateScreenshotData();
    if (changed) await save();
    return changed;
  }

  function screenshotRefs() {
    const refs = [];
    root.accounts.forEach(function (account) {
      account.trades.forEach(function (trade) {
        if (trade && IDB_SCREENSHOT_RE.test(trade.screenshot || '')) refs.push(trade.screenshot);
      });
    });
    return refs;
  }

  async function gcScreenshots() {
    const blobs = getBlobStore();
    if (!blobs) return { deleted: 0, bytes: 0 };
    const refs = screenshotRefs();
    refs.forEach(function (ref) { sessionScreenshotRefs.add(ref); });
    return blobs.gc(Array.from(sessionScreenshotRefs));
  }

  function requestPersistentStorage() {
    const blobs = getBlobStore();
    return blobs ? blobs.persist() : Promise.resolve(false);
  }

  let persistRequest = null;

  function readPersistMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function markPersistAsked() {
    const meta = Object.assign({}, readPersistMeta(), { persistAsked: true });
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (err) {
      // The flag only prevents repeated prompts; failing to store it leaves
      // the journal itself untouched.
    }
  }

  function supportsPersistentStorage() {
    const blobs = getBlobStore();
    return !!(blobs && typeof blobs.supportsPersistence === 'function' && blobs.supportsPersistence());
  }

  function isStoragePersisted() {
    const blobs = getBlobStore();
    if (!blobs || typeof blobs.persisted !== 'function') return Promise.resolve(null);
    return blobs.persisted();
  }

  function requestPersistentStorageOnce() {
    if (desktop) return Promise.resolve(false);
    if (persistRequest) return persistRequest;
    const blobs = getBlobStore();
    if (!blobs || typeof blobs.supportsPersistence !== 'function' || !blobs.supportsPersistence()) {
      return Promise.resolve(false);
    }
    persistRequest = blobs.persisted().then(function (persisted) {
      const meta = readPersistMeta();
      if (!U.shouldRequestPersistentStorage(meta, true, persisted)) return false;
      markPersistAsked();
      return blobs.persist().then(function (granted) {
        return !!granted;
      });
    }).catch(function () {
      return false;
    });
    return persistRequest;
  }

  function storageEstimate() {
    const blobs = getBlobStore();
    return blobs ? blobs.estimate() : Promise.resolve(null);
  }

  async function exportSnapshot() {
    const snapshot = JSON.parse(JSON.stringify(root));
    if (desktop) {
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

    const blobs = getBlobStore();
    if (!blobs) return snapshot;
    for (const account of snapshot.accounts) {
      for (const trade of account.trades) {
        if (!IDB_SCREENSHOT_RE.test(trade.screenshot || '')) continue;
        const dataUrl = await blobs.load(trade.screenshot);
        if (dataUrl) trade.screenshot = dataUrl;
      }
    }
    return snapshot;
  }

  function tradeExits(trade) {
    if (!trade) return [];
    if (Array.isArray(trade.exits) && trade.exits.length) return trade.exits;
    const price = U.parseNum(trade.exit);
    const quantity = U.parseNum(trade.qty);
    if (price === null || quantity === null || quantity <= 0) return [];
    return [{
      id: 'legacy',
      qty: quantity,
      price: price,
      date: trade.date || '',
      fees: Math.max(0, U.parseNum(trade.fees) || 0)
    }];
  }

  function exitedQty(trade) {
    return sumExitQty(tradeExits(trade));
  }

  function remainingQty(trade) {
    const quantity = U.parseNum(trade && trade.qty);
    if (quantity === null) return null;
    if (quantity <= 0) return 0;
    return Math.max(0, quantity - exitedQty(trade));
  }

  function isClosed(trade) {
    if (!trade) return false;
    const exits = tradeExits(trade);
    if (!exits.length) return false;
    const quantity = U.parseNum(trade.qty);
    if (quantity === null || quantity <= 0) return true;
    return remainingQty(trade) <= QTY_EPSILON;
  }

  function isPartial(trade) {
    if (!trade) return false;
    const quantity = U.parseNum(trade.qty);
    const exits = tradeExits(trade);
    if (quantity === null || quantity <= 0 || !exits.length) return false;
    return remainingQty(trade) > QTY_EPSILON;
  }

  function weightedExit(trade) {
    return weightedExitFromExits(tradeExits(trade));
  }

  function tradePnl(trade) {
    if (!trade) return null;
    const entry = U.parseNum(trade.entry);
    const quantity = U.parseNum(trade.qty);
    const exits = tradeExits(trade);
    if (entry === null || quantity === null || !exits.length) return null;
    const dir = trade.side === 'short' ? -1 : 1;
    const multiplier = normalizeMultiplier(trade.multiplier);
    let pnl = 0;
    exits.forEach(function (exit) {
      const exitQty = U.parseNum(exit.qty);
      const exitPrice = U.parseNum(exit.price);
      if (exitQty === null || exitQty <= 0 || exitPrice === null) return;
      const fees = Math.max(0, U.parseNum(exit.fees) || 0);
      pnl += (exitPrice - entry) * exitQty * multiplier * dir - fees;
    });
    return pnl;
  }

  // Daily views are based on the day a position was exited. A trade can
  // contribute to several days when it is scaled out, while the sum of its
  // events always matches tradePnl().
  function tradePnlEvents(trade) {
    if (!trade) return [];
    const entry = U.parseNum(trade.entry);
    const quantity = U.parseNum(trade.qty);
    const exits = tradeExits(trade);
    if (entry === null || quantity === null || !exits.length) return [];
    const dir = trade.side === 'short' ? -1 : 1;
    const multiplier = normalizeMultiplier(trade.multiplier);
    const events = [];
    exits.forEach(function (exit) {
      const exitQty = U.parseNum(exit.qty);
      const exitPrice = U.parseNum(exit.price);
      if (exitQty === null || exitQty <= 0 || exitPrice === null) return;
      const fees = Math.max(0, U.parseNum(exit.fees) || 0);
      events.push({
        date: exit.date || trade.date || '',
        pnl: (exitPrice - entry) * exitQty * multiplier * dir - fees,
        exitId: exit.id ? String(exit.id) : ''
      });
    });
    return events;
  }

  // Counts distinct trades that were opened or exited on each day.
  function dayPnlMap(trades) {
    const map = new Map();
    (trades || []).forEach(function (trade) {
      if (!trade) return;
      const days = new Set();
      if (trade.date) days.add(trade.date);
      tradePnlEvents(trade).forEach(function (event) {
        if (!event.date) return;
        days.add(event.date);
        let item = map.get(event.date);
        if (!item) { item = { pnl: 0, count: 0 }; map.set(event.date, item); }
        item.pnl += event.pnl;
      });
      days.forEach(function (day) {
        let item = map.get(day);
        if (!item) { item = { pnl: 0, count: 0 }; map.set(day, item); }
        item.count++;
      });
    });
    return map;
  }

  // Returns the P&L realized on a specific day for each trade, including
  // trades that were both opened and exited on that day. The day panel uses
  // this map both to build its trade list and to show per-trade results.
  function dayEventPnlMap(trades, day) {
    const map = new Map();
    (trades || []).forEach(function (trade) {
      if (!trade) return;
      const events = tradePnlEvents(trade).filter(function (event) {
        return event.date === day;
      });
      if (!events.length) return;
      map.set(trade.id, events.reduce(function (sum, event) {
        return sum + event.pnl;
      }, 0));
    });
    return map;
  }

  // Stable exit-event order used by the equity curve and drawdown.
  function pnlEventRows(trades) {
    const rows = [];
    (trades || []).forEach(function (trade) {
      tradePnlEvents(trade).forEach(function (event, index) {
        rows.push({
          date: event.date || trade.date || '',
          time: trade.time || '00:00',
          tradeId: trade.id || '',
          exitId: event.exitId || '',
          index: index,
          pnl: event.pnl
        });
      });
    });
    rows.sort(function (a, b) {
      return (a.date || '').localeCompare(b.date || '') ||
        (a.time || '').localeCompare(b.time || '') ||
        (a.tradeId || '').localeCompare(b.tradeId || '') ||
        (a.exitId || '').localeCompare(b.exitId || '') ||
        a.index - b.index;
    });
    return rows;
  }

  function hasRealized(trade) {
    return tradePnl(trade) !== null;
  }

  function tradeFees(trade) {
    return tradeExits(trade).reduce(function (sum, exit) {
      return sum + Math.max(0, U.parseNum(exit && exit.fees) || 0);
    }, 0);
  }

  function tradeRisk(trade) {
    if (!trade) return null;
    const entry = U.parseNum(trade.entry);
    const stop = U.parseNum(trade.stop);
    let quantity = U.parseNum(trade.qty);
    if (isPartial(trade)) quantity = exitedQty(trade);
    if (entry === null || stop === null || quantity === null) return null;
    const risk = Math.abs(entry - stop) * quantity * normalizeMultiplier(trade.multiplier);
    return risk > 0 ? risk : null;
  }

  function openRisk(trade) {
    if (!trade) return null;
    const remaining = remainingQty(trade);
    if (remaining === null) return null;
    if (remaining <= QTY_EPSILON) return 0;
    const entry = U.parseNum(trade.entry);
    const currentStop = U.parseNum(trade.currentStop);
    const initialStop = U.parseNum(trade.stop);
    const stop = currentStop !== null ? currentStop : initialStop;
    if (entry === null || stop === null) return null;
    const risk = Math.abs(entry - stop) * remaining * normalizeMultiplier(trade.multiplier);
    return risk > 0 ? risk : null;
  }

  function tradeStatus(trade) {
    if (isClosed(trade)) return 'closed';
    if (isPartial(trade)) return 'partial';
    return 'open';
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
    const realized = sortTrades((trades || []).filter(hasRealized), 'asc');
    const closed = realized.filter(isClosed);
    const rows = [];
    let partials = 0;
    realized.forEach(function (trade) {
      const pnl = tradePnl(trade);
      if (pnl === null) return;
      if (isPartial(trade)) partials++;
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
      fees += tradeFees(row.trade);
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
    pnlEventRows(realized).forEach(function (event) {
      equity += event.pnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
      const peakBalance = base + peak;
      const ddPct = peakBalance > 0 ? (dd / peakBalance) * 100 : 0;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
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
      partials: partials,
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
    state.trades.forEach(function (trade) {
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
    META_KEY: META_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_ACCOUNT_NAME: DEFAULT_ACCOUNT_NAME,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    MAX_EXITS: MAX_EXITS,
    MULTIPLIER_MIN: MULTIPLIER_MIN,
    MULTIPLIER_MAX: MULTIPLIER_MAX,
    QTY_EPSILON: QTY_EPSILON,
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
    gcScreenshots: gcScreenshots,
    requestPersistentStorage: requestPersistentStorage,
    requestPersistentStorageOnce: requestPersistentStorageOnce,
    supportsPersistentStorage: supportsPersistentStorage,
    isStoragePersisted: isStoragePersisted,
    storageEstimate: storageEstimate,
    exportSnapshot: exportSnapshot,
    tradeExits: tradeExits,
    exitedQty: exitedQty,
    remainingQty: remainingQty,
    isClosed: isClosed,
    isPartial: isPartial,
    allocateExitFees: allocateExitFees,
    hasRealized: hasRealized,
    weightedExit: weightedExit,
    tradePnl: tradePnl,
    tradePnlEvents: tradePnlEvents,
    dayPnlMap: dayPnlMap,
    dayEventPnlMap: dayEventPnlMap,
    tradeFees: tradeFees,
    tradeRisk: tradeRisk,
    openRisk: openRisk,
    tradeStatus: tradeStatus,
    tradeR: tradeR,
    normalizeMultiplier: normalizeMultiplier,
    plannedRR: plannedRR,
    sortTrades: sortTrades,
    metrics: metrics,
    groupRows: groupRows,
    balanceAll: balanceAll,
    storageSize: storageSize,
    normalizeTrade: normalizeTrade
  };
})();
