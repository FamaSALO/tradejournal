(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const desktop = window.tradeJournalDesktop || null;

  const KEY = 'tradejournal.v1';
  const MAX_SCREENSHOT_LENGTH = 3000000;
  const SAFE_SCREENSHOT_RE = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;
  const DEFAULT_SETTINGS = {
    name: '',
    currency: '$',
    startBalance: 10000,
    riskPercent: 1,
    dailyLossLimit: 3,
    maxTradesPerDay: 3
  };

  let state = blankState(DEFAULT_SETTINGS);
  let loadError = null;

  function blankState(settings) {
    return {
      version: 1,
      demo: false,
      settings: Object.assign({}, DEFAULT_SETTINGS, settings || {}),
      trades: [],
      notes: []
    };
  }

  function hasStored() {
    if (desktop) {
      try { return desktop.hasData(); } catch (err) {
        // If the file cannot be checked, report that data may exist so the app
        // does not silently replace it with demo data.
        console.warn('TradeJournal: не удалось проверить файл журнала', err);
        return true;
      }
    }
    try { return localStorage.getItem(KEY) !== null; } catch (err) { return false; }
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
    const shot = typeof raw.screenshot === 'string'
      && raw.screenshot.length <= MAX_SCREENSHOT_LENGTH
      && SAFE_SCREENSHOT_RE.test(raw.screenshot) ? raw.screenshot : '';
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
      name: String(raw.name || '').slice(0, 40),
      currency: currency || '$',
      startBalance: startBalance !== null && startBalance >= 0 ? startBalance : 10000,
      riskPercent: risk !== null && risk >= 0 ? U.clamp(risk, 0, 100) : 1,
      dailyLossLimit: daily !== null && daily >= 0 ? U.clamp(daily, 0, 100) : 3,
      maxTradesPerDay: maxTrades !== null && maxTrades >= 0 ? U.clamp(Math.round(maxTrades), 0, 100) : 3
    };
  }

  function isJournalData(raw) {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw)
      && Array.isArray(raw.trades) && Array.isArray(raw.notes);
  }

  function normalizeData(raw) {
    raw = raw || {};
    const settings = normalizeSettings(raw.settings);
    const seenTradeIds = new Set();
    const trades = (Array.isArray(raw.trades) ? raw.trades : []).map(normalizeTrade).filter(Boolean).map(function (trade) {
      if (seenTradeIds.has(trade.id)) trade.id = U.uid();
      seenTradeIds.add(trade.id);
      return trade;
    });
    const seenNoteIds = new Set();
    const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(normalizeNote).filter(Boolean).map(function (note) {
      if (seenNoteIds.has(note.id)) note.id = U.uid();
      seenNoteIds.add(note.id);
      return note;
    });
    return {
      version: 1,
      demo: !!raw.demo,
      settings: settings,
      trades: trades,
      notes: notes
    };
  }

  function load() {
    try {
      const raw = desktop ? desktop.load() : localStorage.getItem(KEY);
      if (raw === null) return false;
      const parsed = JSON.parse(raw);
      if (!isJournalData(parsed)) throw new Error('Неожиданная структура журнала');
      state = normalizeData(parsed);
      loadError = null;
      return true;
    } catch (err) {
      loadError = err;
      console.warn('TradeJournal: не удалось прочитать данные', err);
      return false;
    }
  }

  function getRaw() {
    if (desktop) {
      try { return desktop.load(); } catch (err) { return null; }
    }
    try { return localStorage.getItem(KEY); } catch (err) { return null; }
  }

  function clearRaw() {
    if (desktop) {
      try { return desktop.clear(); } catch (err) { return false; }
    }
    try { localStorage.removeItem(KEY); return true; } catch (err) { return false; }
  }

  function save() {
    try {
      if (desktop) return desktop.save(JSON.stringify(state));
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn('TradeJournal: не удалось сохранить данные', err);
      return false;
    }
  }

  function replaceData(raw) {
    if (!isJournalData(raw)) return false;
    state = normalizeData(raw);
    return save();
  }

  function setDemo(data) {
    state = normalizeData(data);
    state.demo = true;
    return save();
  }

  function resetData(keepSettings) {
    const settings = keepSettings ? Object.assign({}, state.settings) : Object.assign({}, DEFAULT_SETTINGS);
    state = blankState(settings);
    return save();
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
    try { return new Blob([JSON.stringify(state)]).size; } catch (err) { return 0; }
  }

  NS.store = {
    KEY: KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    get state() { return state; },
    get loadError() { return loadError; },
    hasStored: hasStored,
    isJournalData: isJournalData,
    load: load,
    getRaw: getRaw,
    clearRaw: clearRaw,
    save: save,
    replaceData: replaceData,
    setDemo: setDemo,
    resetData: resetData,
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
