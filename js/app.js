(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const store = NS.store;
  const desktop = window.tradeJournalDesktop || null;

  const $ = function (selector, root) { return (root || document).querySelector(selector); };
  const $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };

  const VIEW_META = {
    dashboard: { title: 'Обзор', subtitle: 'Статистика счёта и последние результаты' },
    trades: { title: 'Сделки', subtitle: 'Полный журнал ваших сделок' },
    calendar: { title: 'Календарь', subtitle: 'Результат по дням и заметки' },
    analytics: { title: 'Аналитика', subtitle: 'Где вы зарабатываете и где теряете' },
    journal: { title: 'Журнал', subtitle: 'Мысли, ошибки и выводы' },
    calculator: { title: 'Калькулятор позиции', subtitle: 'Размер позиции под ваш риск' },
    settings: { title: 'Настройки', subtitle: 'Профиль, риск-менеджмент и данные' }
  };

  const state = {
    view: 'dashboard',
    period: 'all',
    filters: { search: '', side: 'all', result: 'all', setup: 'all' },
    sort: { key: 'date', dir: 'desc' },
    calCursor: monthStart(new Date()),
    selectedDay: U.todayISO(),
    tradeId: null,
    noteId: null,
    screenshot: '',
    noteMood: 'neutral',
    confirmResolver: null,
    lastFocus: null
  };

  const EMOTION_OPTIONS = NS.EMOTIONS;

  /* ============================================================
     Init
     ============================================================ */

  function init() {
    const hadStored = store.hasStored();
    if (hadStored) {
      if (!store.load()) {
        showRecoveryScreen(store.getRaw());
        return;
      }
    } else {
      store.setDemo(NS.sample.generate());
    }
    applyCurrency();
    buildMoodPicker();
    buildEmotionSelect();
    refreshDatalists();
    bindEvents();
    initDesktopUi();

    const hashView = String(location.hash || '').replace('#', '');
    const initialView = VIEW_META[hashView] ? hashView : 'dashboard';
    navigate(initialView, { push: false, scroll: false });
  }

  function showRecoveryScreen(rawData) {
    document.body.classList.add('recovery-mode');
    const screen = document.createElement('div');
    screen.className = 'recovery-screen';
    screen.innerHTML =
      '<div class="recovery-card">' +
        '<div class="recovery-badge" aria-hidden="true">!</div>' +
        '<h1>Не удалось прочитать журнал</h1>' +
        '<p>Локальные данные повреждены или имеют неожиданный формат. Приложение остановлено, чтобы не перезаписать их.</p>' +
        '<p class="recovery-note">Сначала скачайте файл с исходными данными — его можно попробовать восстановить вручную или отправить на анализ.</p>' +
        '<div class="recovery-actions">' +
          '<button type="button" class="btn btn-primary" id="recoveryDownload">Скачать данные</button>' +
          '<button type="button" class="btn btn-ghost" id="recoveryReload">Попробовать снова</button>' +
          '<button type="button" class="btn btn-danger-ghost" id="recoveryReset">Сбросить журнал</button>' +
        '</div>' +
        '<p class="recovery-hint">Сброс удалит повреждённые данные и загрузит демо-журнал.</p>' +
      '</div>';
    document.body.appendChild(screen);

    const downloadBtn = $('#recoveryDownload');
    if (!rawData) {
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Данные недоступны';
    } else {
      downloadBtn.addEventListener('click', function () {
        U.download('tradejournal-corrupt-' + U.todayISO() + '.json', rawData, 'application/json');
        downloadBtn.textContent = 'Файл скачан';
        toast('Повреждённые данные скачаны. Теперь можно сбросить журнал.', 'success');
      });
    }

    $('#recoveryReload').addEventListener('click', function () { location.reload(); });
    $('#recoveryReset').addEventListener('click', function () {
      if (!window.confirm('Удалить повреждённые данные и загрузить демо-журнал? Убедитесь, что файл уже скачан.')) return;
      store.clearRaw();
      location.reload();
    });
  }

  function applyCurrency() {
    NS.config.currency = (store.state.settings.currency || '$').slice(0, 3);
  }

  function monthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function navigate(view, options) {
    options = options || {};
    if (!VIEW_META[view]) view = 'dashboard';
    state.view = view;

    $$('.view').forEach(function (panel) {
      panel.classList.toggle('active', panel.dataset.panel === view);
    });
    $$('.nav-item[data-view]').forEach(function (item) {
      item.classList.toggle('active', item.dataset.view === view);
    });

    const meta = VIEW_META[view];
    $('#pageTitle').textContent = meta.title;
    $('#pageSubtitle').textContent = meta.subtitle;
    document.title = meta.title + ' — TradeJournal';

    const showPeriod = view === 'dashboard' || view === 'analytics';
    $('#periodWrap').classList.toggle('hidden', !showPeriod);

    if (options.push !== false && location.hash !== '#' + view) {
      try { location.hash = view; } catch (err) { /* ignore */ }
    }

    if (view === 'calculator') ensureCalcDefaults();
    if (view === 'calendar') {
      state.calCursor = monthStart(state.calCursor || new Date());
      if (!state.selectedDay) state.selectedDay = U.todayISO();
    }

    renderCurrentView();
    if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
    closeSidebar();
  }

  function renderCurrentView() {
    renderSidebar();
    refreshDatalists();
    switch (state.view) {
      case 'dashboard': renderDashboard(); break;
      case 'trades': renderTrades(); break;
      case 'calendar': renderCalendar(); break;
      case 'analytics': renderAnalytics(); break;
      case 'journal': renderJournal(); break;
      case 'calculator': calcUpdate(); break;
      case 'settings': renderSettings(); break;
      default: break;
    }
  }

  function renderAll() {
    renderCurrentView();
  }

  /* ============================================================
     Sidebar & common
     ============================================================ */

  function renderSidebar() {
    const settings = store.state.settings;
    const balance = store.balanceAll();
    const start = U.parseNum(settings.startBalance) || 0;
    const net = balance - start;
    const roi = start > 0 ? (net / start) * 100 : 0;

    $('#sidebarBalance').textContent = U.money(balance);
    const delta = $('#sidebarDelta');
    delta.textContent = (roi > 0 ? '+' : '') + U.percent(roi, 1);
    delta.classList.toggle('neg', roi < -0.004);
    delta.classList.toggle('pos', roi > 0.004);

    const today = U.todayISO();
    let todayPnl = 0;
    store.state.trades.forEach(function (trade) {
      if (trade.date === today && store.isClosed(trade)) {
        const pnl = store.tradePnl(trade);
        if (pnl !== null) todayPnl += pnl;
      }
    });
    const todayEl = $('#sidebarToday');
    todayEl.innerHTML = 'сегодня <b class="' + toneClass(todayPnl) + '">' + U.escapeHtml(U.money(todayPnl, { sign: true })) + '</b>';

    $('#navTradesCount').textContent = store.state.trades.length;

    const name = (settings.name || '').trim();
    const initials = name
      ? name.split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('')
      : 'TJ';
    $('#avatarInitials').textContent = initials;
    $('#avatarBtn').title = name ? name + ' — профиль и настройки' : 'Профиль и настройки';
  }

  function toneClass(value) {
    if (value > 0.004) return 'pos';
    if (value < -0.004) return 'neg';
    return 'neutral';
  }

  function persist() {
    const ok = store.save();
    if (!ok) {
      toast(desktop
        ? 'Не удалось сохранить файл журнала. Проверьте свободное место и папку данных.'
        : 'Не удалось сохранить: хранилище браузера заполнено. Удалите скриншоты или экспортируйте журнал.',
      'error');
    }
    return ok;
  }

  function toast(message, type, action) {
    const box = document.createElement('div');
    box.className = 'toast ' + (type || 'success');
    box.innerHTML = '<span class="toast-dot"></span><span class="toast-message">' + U.escapeHtml(message) + '</span>' +
      (action && action.label ? '<button type="button" class="toast-action">' + U.escapeHtml(action.label) + '</button>' : '');
    $('#toasts').appendChild(box);
    const life = action ? 8500 : 3400;
    setTimeout(function () { box.classList.add('out'); }, life);
    setTimeout(function () { box.remove(); }, life + 250);
    if (action) {
      box.querySelector('.toast-action').addEventListener('click', function () {
        box.remove();
        action.onClick();
      });
    }
  }

  function refreshDatalists() {
    const symbols = Array.from(new Set(
      ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'NAS100', 'AAPL', 'TSLA', 'USDJPY']
        .concat(store.state.trades.map(function (t) { return t.symbol; }))
        .filter(Boolean)
    )).sort();

    const setups = Array.from(new Set(
      NS.SETUPS.concat(store.state.trades.map(function (t) { return t.setup; }))
        .filter(Boolean)
    ));

    const symbolList = $('#symbolList');
    if (symbolList) symbolList.innerHTML = symbols.map(function (s) { return '<option value="' + U.escapeHtml(s) + '"></option>'; }).join('');
    const setupList = $('#setupList');
    if (setupList) setupList.innerHTML = setups.map(function (s) { return '<option value="' + U.escapeHtml(s) + '"></option>'; }).join('');
  }

  function splitTags(value) {
    return String(value || '').split(',').map(function (tag) { return tag.trim(); }).filter(Boolean).slice(0, 12);
  }

  function pluralTrades(n) {
    return U.plural(n, ['сделка', 'сделки', 'сделок']);
  }

  /* ============================================================
     Periods
     ============================================================ */

  function currentRange() {
    const today = U.todayISO();
    switch (state.period) {
      case '30': return { from: U.addDaysISO(today, -29), to: today };
      case '90': return { from: U.addDaysISO(today, -89), to: today };
      case 'month': return { from: today.slice(0, 8) + '01', to: today };
      case 'year': return { from: today.slice(0, 4) + '-01-01', to: today };
      default: return { from: null, to: null };
    }
  }

  function filterByRange(trades, range) {
    if (!range || (!range.from && !range.to)) return trades;
    return trades.filter(function (trade) {
      return (!range.from || trade.date >= range.from) && (!range.to || trade.date <= range.to);
    });
  }

  function buildPeriodMetrics() {
    const settings = store.state.settings;
    const range = currentRange();
    const closedAll = store.sortTrades(store.state.trades.filter(store.isClosed), 'asc');
    const filtered = filterByRange(closedAll, range);
    let beforePnl = 0;
    if (range.from) {
      closedAll.forEach(function (trade) {
        if (trade.date < range.from) {
          const pnl = store.tradePnl(trade);
          if (pnl !== null) beforePnl += pnl;
        }
      });
    }
    const base = (U.parseNum(settings.startBalance) || 0) + beforePnl;
    const m = store.metrics(filtered, base);
    return { range: range, closedAll: closedAll, filtered: filtered, base: base, m: m };
  }

  /* ============================================================
     Dashboard
     ============================================================ */

  function renderDashboard() {
    $('#welcomeBanner').hidden = !store.state.demo;

    const data = buildPeriodMetrics();
    const m = data.m;
    renderKpis(m, data.base);

    const points = buildEquityPoints(data.filtered, data.base);
    NS.charts.equity($('#equityChart'), points, { emptyText: 'Нет закрытых сделок за период' });

    const roi = data.base > 0 ? (m.net / data.base) * 100 : 0;
    const chip = $('#equityChip');
    chip.textContent = m.count ? (roi > 0 ? '+' : '') + U.percent(roi, 1) : 'нет сделок';
    chip.className = 'chip ' + toneClass(m.net);

    NS.charts.donut($('#donutChart'), [
      { value: m.wins, color: '#31e3aa' },
      { value: m.losses, color: '#ff6b81' },
      { value: m.be, color: '#5f7187' }
    ]);
    $('#donutRate').textContent = m.count ? U.percent(m.winRate, 0) : '—';

    const legend = [
      { label: 'Прибыльные', count: m.wins, color: '#31e3aa' },
      { label: 'Убыточные', count: m.losses, color: '#ff6b81' },
      { label: 'Безубыток', count: m.be, color: '#5f7187' }
    ];
    $('#donutLegend').innerHTML = legend.map(function (item) {
      const pct = m.count ? U.percent((item.count / m.count) * 100, 0) : '—';
      return '<div class="legend-row"><span class="legend-dot" style="background:' + item.color + '"></span>' +
        U.escapeHtml(item.label) + '<b>' + item.count + '</b><span class="legend-pct">' + pct + '</span></div>';
    }).join('');

    const daily = dailySeries(data.filtered, 30);
    NS.charts.bars($('#dailyChart'), daily, { emptyText: 'За этот период сделок не было' });
    const dailyNet = daily.reduce(function (sum, point) { return sum + point.value; }, 0);
    const dailyChip = $('#dailyChip');
    dailyChip.textContent = daily.length ? U.money(dailyNet, { sign: true }) : '—';
    dailyChip.className = 'chip ' + toneClass(dailyNet);
    dailyChip.title = 'Сумма P&L по показанным торговым дням';

    renderDiscipline();
    renderRecentTrades();
    renderTopSymbols(m.rows);

    $('#todayDate').textContent = U.capitalize(U.formatDate(U.todayISO(), 'full'));
  }

  function renderKpis(m, base) {
    const roi = base > 0 ? (m.net / base) * 100 : 0;
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2).replace('.', ',');
    const hasR = m.rCount > 0;
    const streak = m.currentStreak
      ? m.currentStreak.n + (m.currentStreak.type === 'win' ? 'W' : 'L')
      : '—';

    const cards = [
      {
        label: 'Чистый P&L',
        value: m.count ? U.money(m.net, { sign: true }) : '—',
        tone: toneClass(m.net),
        sub: m.count ? 'ROI ' + (roi > 0 ? '+' : '') + U.percent(roi, 1) + ' · ' + m.count + ' ' + pluralTrades(m.count) : 'Нет закрытых сделок'
      },
      {
        label: 'Винрейт',
        value: m.count ? U.percent(m.winRate, 0) : '—',
        tone: m.count ? (m.winRate >= 50 ? 'pos' : '') : '',
        sub: m.count ? m.wins + 'W · ' + m.losses + 'L · ' + m.be + 'BE' : 'Нужны закрытые сделки'
      },
      {
        label: 'Профит-фактор',
        value: m.count ? pf : '—',
        tone: m.count ? (m.profitFactor > 1 ? 'pos' : (m.profitFactor < 1 ? 'neg' : '')) : '',
        sub: m.count ? 'Прибыль / убыток' : 'Отношение валовой прибыли к убытку'
      },
      {
        label: 'Средний R',
        value: hasR ? U.rfmt(m.avgR, { sign: true }) : '—',
        tone: hasR ? toneClass(m.avgR) : '',
        sub: hasR ? 'Итого ' + U.rfmt(m.totalR, { sign: true }) + ' · ' + m.rCount + ' с R' : 'Добавьте стоп при входе к сделкам'
      },
      {
        label: 'Макс. просадка',
        value: m.count ? U.money(m.maxDD) : '—',
        tone: m.maxDD > 0.004 ? 'neg' : '',
        sub: m.count ? U.percent(m.maxDDPct, 1) + ' от пика счёта' : 'Пока без просадок'
      },
      {
        label: 'Серия',
        value: streak,
        tone: m.currentStreak ? (m.currentStreak.type === 'win' ? 'pos' : 'neg') : '',
        sub: m.count ? 'Макс. ' + m.maxWinStreak + 'W / ' + m.maxLossStreak + 'L' : 'Текущая серия'
      }
    ];

    $('#kpiGrid').innerHTML = cards.map(function (card) {
      return '<div class="kpi"><div class="kpi-label">' + U.escapeHtml(card.label) + '</div>' +
        '<div class="kpi-value ' + (card.tone || '') + '">' + U.escapeHtml(card.value) + '</div>' +
        '<div class="kpi-sub">' + card.sub + '</div></div>';
    }).join('');
  }

  function buildEquityPoints(closedAsc, base) {
    let balance = base;
    const points = [{ label: 'Старт', value: balance, meta: 'Начало периода' }];
    closedAsc.forEach(function (trade) {
      const pnl = store.tradePnl(trade);
      if (pnl === null) return;
      balance += pnl;
      points.push({
        label: trade.date,
        value: balance,
        meta: trade.symbol + ' · ' + U.money(pnl, { sign: true })
      });
    });

    if (points.length > 260) {
      const byDay = new Map();
      points.slice(1).forEach(function (point) { byDay.set(point.label, point); });
      return [points[0]].concat(Array.from(byDay.values()));
    }
    return points;
  }

  function dailySeries(trades, limit) {
    const map = new Map();
    trades.forEach(function (trade) {
      const pnl = store.tradePnl(trade);
      if (pnl === null) return;
      let item = map.get(trade.date);
      if (!item) { item = { value: 0, count: 0 }; map.set(trade.date, item); }
      item.value += pnl;
      item.count++;
    });
    const list = Array.from(map.entries()).map(function (entry) {
      return {
        label: entry[0],
        value: entry[1].value,
        meta: entry[1].count + ' ' + pluralTrades(entry[1].count)
      };
    }).sort(function (a, b) { return a.label.localeCompare(b.label); });
    return limit ? list.slice(-limit) : list;
  }

  function renderDiscipline() {
    const settings = store.state.settings;
    const today = U.todayISO();
    const todayTrades = store.state.trades.filter(function (trade) { return trade.date === today; });
    const closedToday = todayTrades.filter(store.isClosed);
    let dayPnl = 0;
    closedToday.forEach(function (trade) {
      const pnl = store.tradePnl(trade);
      if (pnl !== null) dayPnl += pnl;
    });

    const balance = store.balanceAll();
    const startOfDayBalance = Math.max(0, balance - dayPnl);
    const lossLimit = Math.max(0, (U.parseNum(settings.dailyLossLimit) || 0) / 100 * startOfDayBalance);
    const maxTrades = U.parseNum(settings.maxTradesPerDay) || 0;
    const lossUsed = dayPnl < 0 ? Math.min(-dayPnl, lossLimit) : 0;
    const lossPct = lossLimit > 0 ? Math.min(100, (lossUsed / lossLimit) * 100) : 0;
    const countPct = maxTrades > 0 ? Math.min(100, (todayTrades.length / maxTrades) * 100) : 0;

    let statusTone = 'ok';
    let statusText = 'В рамках плана. Сохраняйте темп.';
    if (!todayTrades.length) {
      statusText = 'Сделок сегодня ещё нет — можно работать по плану.';
    } else if (lossLimit > 0 && dayPnl <= -lossLimit) {
      statusTone = 'bad';
      statusText = 'Дневной лимит убытка достигнут. Остановитесь на сегодня.';
    } else if (maxTrades > 0 && todayTrades.length >= maxTrades) {
      statusTone = 'warn';
      statusText = 'Лимит сделок на день исчерпан. Больше не входите.';
    }

    const lossBarClass = lossPct >= 100 ? 'bad' : (lossPct > 55 ? 'warn' : '');
    const countBarClass = countPct >= 100 ? 'warn' : '';

    const lossRule = lossLimit > 0
      ? '<div class="rule"><div class="rule-top"><span>Лимит убытка</span><b>' + U.money(lossUsed) + ' / ' + U.money(lossLimit) + '</b></div>' +
        '<div class="progress"><i class="' + lossBarClass + '" style="width:' + lossPct + '%"></i></div></div>'
      : '<div class="rule"><div class="rule-top"><span>Лимит убытка</span><b>не задан</b></div><div class="progress"><i style="width:0"></i></div></div>';

    const tradesRule = maxTrades > 0
      ? '<div class="rule"><div class="rule-top"><span>Сделки сегодня</span><b>' + todayTrades.length + ' / ' + maxTrades + '</b></div>' +
        '<div class="progress"><i class="' + countBarClass + '" style="width:' + countPct + '%"></i></div></div>'
      : '<div class="rule"><div class="rule-top"><span>Сделки сегодня</span><b>' + todayTrades.length + '</b></div><div class="progress"><i style="width:0"></i></div></div>';

    $('#disciplineBody').innerHTML =
      '<div class="today-pnl"><span>Результат дня</span><strong class="' + toneClass(dayPnl) + '">' +
      U.escapeHtml(U.money(dayPnl, { sign: true })) + '</strong><small>' + todayTrades.length + ' ' + pluralTrades(todayTrades.length) + '</small></div>' +
      lossRule + tradesRule +
      '<div class="rule-status ' + statusTone + '">' + (statusTone === 'ok' ? '✓' : '!') + ' ' + U.escapeHtml(statusText) + '</div>';
  }

  function renderRecentTrades() {
    const recent = store.sortTrades(store.state.trades, 'desc').slice(0, 5);
    const container = $('#recentTrades');
    if (!recent.length) {
      container.innerHTML = '<div class="mini-empty">Пока нет сделок.<br>Добавьте первую — и здесь появится история.</div>';
      return;
    }
    container.innerHTML = recent.map(function (trade) {
      const open = !store.isClosed(trade);
      const pnl = store.tradePnl(trade);
      const r = store.tradeR(trade);
      return '<div class="mini-row" data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
        '<div class="mini-icon ' + trade.side + '">' + U.escapeHtml(trade.symbol.slice(0, 2)) + '</div>' +
        '<div class="mini-main"><strong>' + U.escapeHtml(trade.symbol) + '</strong><span>' +
        U.escapeHtml(U.formatDate(trade.date, 'med')) + (trade.time ? ' · ' + U.escapeHtml(trade.time) : '') +
        ' · ' + (trade.side === 'long' ? 'Long' : 'Short') + (trade.setup ? ' · ' + U.escapeHtml(trade.setup) : '') +
        '</span></div>' +
        '<div class="mini-pnl"><strong class="' + (open ? '' : toneClass(pnl)) + '">' +
        (open ? 'Открыта' : U.escapeHtml(U.money(pnl, { sign: true }))) + '</strong><span>' +
        (open ? 'без выхода' : (r !== null ? U.escapeHtml(U.rfmt(r, { sign: true })) : '—')) +
        '</span></div></div>';
    }).join('');
  }

  function renderTopSymbols(rows) {
    const groups = store.groupRows(rows, function (trade) { return trade.symbol; })
      .sort(function (a, b) { return b.pnl - a.pnl; })
      .slice(0, 5);
    const container = $('#topSymbols');
    if (!groups.length) {
      container.innerHTML = '<div class="hb-empty">Нет сделок за период</div>';
      return;
    }
    const max = Math.max.apply(null, groups.map(function (g) { return Math.abs(g.pnl); }).concat([1]));
    container.innerHTML = groups.map(function (group) {
      const width = Math.max(3, Math.abs(group.pnl) / max * 100);
      return '<div class="hb-row"><div class="hb-top"><span class="hb-label">' + U.escapeHtml(group.key) +
        '<small>' + group.count + ' ' + pluralTrades(group.count) + '</small></span>' +
        '<span class="hb-value ' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</span></div>' +
        '<div class="hb-track"><div class="hb-fill ' + (group.pnl < 0 ? 'neg' : '') + '" style="width:' + width + '%"></div></div></div>';
    }).join('');
  }

  /* ============================================================
     Trades
     ============================================================ */

  function getFilteredTrades() {
    const filters = state.filters;
    let list = store.state.trades.slice();

    if (filters.search) {
      const query = filters.search.toLowerCase();
      list = list.filter(function (trade) {
        const emotion = U.emotionMeta(trade.emotion).label;
        const haystack = [trade.symbol, trade.setup, trade.notes, trade.tags.join(' '), emotion, trade.date, trade.time].join(' ').toLowerCase();
        return haystack.indexOf(query) !== -1;
      });
    }

    if (filters.side !== 'all') list = list.filter(function (trade) { return trade.side === filters.side; });
    if (filters.setup !== 'all') list = list.filter(function (trade) { return (trade.setup || '') === (filters.setup === '__empty__' ? '' : filters.setup); });

    if (filters.result !== 'all') {
      list = list.filter(function (trade) {
        if (filters.result === 'open') return !store.isClosed(trade);
        if (!store.isClosed(trade)) return false;
        const pnl = store.tradePnl(trade);
        if (pnl === null) return false;
        if (filters.result === 'win') return pnl > 0.004;
        if (filters.result === 'loss') return pnl < -0.004;
        return Math.abs(pnl) <= 0.004;
      });
    }

    const key = state.sort.key;
    const dir = state.sort.dir === 'asc' ? 1 : -1;
    list.sort(function (a, b) {
      let av, bv;
      if (key === 'date') {
        av = (a.date || '') + ' ' + (a.time || '00:00');
        bv = (b.date || '') + ' ' + (b.time || '00:00');
        return av.localeCompare(bv) * dir;
      }
      if (key === 'symbol' || key === 'setup') {
        av = String(a[key] || '').toLowerCase();
        bv = String(b[key] || '').toLowerCase();
        return av.localeCompare(bv, 'ru') * dir;
      }
      if (key === 'pnl') {
        av = store.isClosed(a) ? store.tradePnl(a) : null;
        bv = store.isClosed(b) ? store.tradePnl(b) : null;
      } else if (key === 'r') {
        av = store.tradeR(a);
        bv = store.tradeR(b);
      } else {
        av = U.parseNum(a[key]);
        bv = U.parseNum(b[key]);
      }
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
    return list;
  }

  function populateSetupFilter() {
    const select = $('#filterSetup');
    const setups = Array.from(new Set(store.state.trades.map(function (t) { return t.setup; }).filter(function (s) { return !!s; })))
      .sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    const current = state.filters.setup;
    let html = '<option value="all">Все сетапы</option>';
    setups.forEach(function (setup) {
      html += '<option value="' + U.escapeHtml(setup) + '">' + U.escapeHtml(setup) + '</option>';
    });
    select.innerHTML = html;
    if (current !== 'all' && setups.indexOf(current) === -1) {
      state.filters.setup = 'all';
      select.value = 'all';
    } else {
      select.value = current;
    }
  }

  function renderTrades() {
    populateSetupFilter();

    $('#filterSide').value = state.filters.side;
    $('#filterResult').value = state.filters.result;

    const list = getFilteredTrades();
    const tbody = $('#tradesTbody');
    const table = $('#tradesTable');
    const empty = $('#tradesEmpty');
    const hasAny = store.state.trades.length > 0;

    $$('#tradesTable th[data-sort]').forEach(function (th) {
      if (th.dataset.sort === state.sort.key) th.dataset.dir = state.sort.dir;
      else th.removeAttribute('data-dir');
    });

    if (!list.length) {
      tbody.innerHTML = '';
      table.classList.add('hidden');
      empty.hidden = false;
      $('#emptyTitle').textContent = hasAny ? 'Ничего не найдено' : 'Пока нет сделок';
      $('#emptyText').textContent = hasAny
        ? 'Попробуйте изменить фильтры или поисковый запрос.'
        : 'Добавьте первую сделку — статистика, графики и аналитика появятся автоматически.';
      const actions = $('#tradesEmpty .empty-actions');
      if (actions) actions.style.display = hasAny ? 'none' : 'flex';
      $('#tradesCountLabel').textContent = '0 ' + pluralTrades(0);
      $('#tradesFooter').innerHTML = '';
      return;
    }

    table.classList.remove('hidden');
    empty.hidden = true;
    tbody.innerHTML = list.map(function (trade) {
      const open = !store.isClosed(trade);
      const pnl = store.tradePnl(trade);
      const r = store.tradeR(trade);
      const emotion = U.emotionMeta(trade.emotion);
      return '<tr data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
        '<td><div class="cell-date"><strong>' + U.escapeHtml(U.formatDate(trade.date, 'med')) + '</strong><span>' + U.escapeHtml(trade.time || '—') + '</span></div></td>' +
        '<td><div class="symbol-cell"><div class="symbol-line"><strong>' + U.escapeHtml(trade.symbol) + '</strong>' + (trade.screenshot ? '<span class="shot-dot" title="Есть скриншот"></span>' : '') + '</div>' +
        '<span class="side-badge ' + trade.side + '"><span class="arr">' + (trade.side === 'long' ? '↑' : '↓') + '</span>' + (trade.side === 'long' ? 'Long' : 'Short') + '</span></div></td>' +
        '<td class="num">' + U.escapeHtml(U.price(trade.entry)) + '</td>' +
        '<td class="num">' + (open ? '—' : U.escapeHtml(U.price(trade.exit))) + '</td>' +
        '<td class="num pnl-cell">' + (open ? '<span class="open-badge">Открыта</span>' : '<span class="' + toneClass(pnl) + '">' + U.escapeHtml(U.money(pnl, { sign: true })) + '</span>') + '</td>' +
        '<td class="num ' + (r !== null ? toneClass(r) : '') + '">' + (r !== null ? U.escapeHtml(U.rfmt(r, { sign: true })) : '—') + '</td>' +
        '<td>' + (trade.setup ? '<span class="setup-chip" title="' + U.escapeHtml(trade.setup) + '">' + U.escapeHtml(trade.setup) + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="emotion-cell" title="' + U.escapeHtml(emotion.label) + '">' + U.escapeHtml(emotion.emoji) + ' <span class="muted" style="font-size:10px">' + U.escapeHtml(emotion.label) + '</span></span></td>' +
        '<td style="text-align:right"><span class="row-chevron">›</span></td>' +
        '</tr>';
    }).join('');

    $('#tradesCountLabel').textContent = list.length + ' ' + pluralTrades(list.length);

    let net = 0;
    let rSum = 0;
    let rCount = 0;
    let closedCount = 0;
    list.forEach(function (trade) {
      if (!store.isClosed(trade)) return;
      const pnl = store.tradePnl(trade);
      const r = store.tradeR(trade);
      if (pnl !== null) { net += pnl; closedCount++; }
      if (r !== null) { rSum += r; rCount++; }
    });

    $('#tradesFooter').innerHTML = '<span>Показано <b>' + list.length + '</b> из <b>' + store.state.trades.length + '</b></span>' +
      '<span class="dot-sep">·</span><span>Итого по фильтру: <b class="' + toneClass(net) + '">' + U.escapeHtml(U.money(net, { sign: true })) + '</b></span>' +
      (rCount ? '<span class="dot-sep">·</span><span>Средний R: <b class="' + toneClass(rSum / rCount) + '">' + U.escapeHtml(U.rfmt(rSum / rCount, { sign: true })) + '</b></span>' : '') +
      '<span class="table-foot-hint">Клик по строке — редактирование</span>';
  }

  function resetFilters() {
    state.filters = { search: '', side: 'all', result: 'all', setup: 'all' };
    $('#tradeSearch').value = '';
    $('#filterSide').value = 'all';
    $('#filterResult').value = 'all';
    renderTrades();
  }

  /* ============================================================
     Calendar
     ============================================================ */

  function renderCalendar() {
    const cursor = state.calCursor;
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const prefix = year + '-' + pad2(month + 1);

    $('#calTitle').textContent = U.monthTitle(year, month);
    $('#calWeekdays').innerHTML = NS.WEEKDAY_LABELS.map(function (label) { return '<span>' + label + '</span>'; }).join('');

    const monthTrades = store.state.trades.filter(function (trade) { return (trade.date || '').slice(0, 7) === prefix; });
    const closedMonth = monthTrades.filter(store.isClosed);
    const pnlMap = {};
    const countMap = {};

    monthTrades.forEach(function (trade) {
      countMap[trade.date] = (countMap[trade.date] || 0) + 1;
      if (!store.isClosed(trade)) return;
      const pnl = store.tradePnl(trade);
      if (pnl !== null) pnlMap[trade.date] = (pnlMap[trade.date] || 0) + pnl;
    });

    const notesByDate = {};
    store.state.notes.forEach(function (note) {
      if (!notesByDate[note.date]) notesByDate[note.date] = [];
      notesByDate[note.date].push(note);
    });

    const settings = store.state.settings;
    const monthMetrics = store.metrics(closedMonth, U.parseNum(settings.startBalance) || 0);
    const dayValues = Object.keys(pnlMap).map(function (key) { return pnlMap[key]; });
    const monthPnl = U.sum(dayValues);
    let bestDay = null;
    Object.keys(pnlMap).forEach(function (key) {
      if (!bestDay || pnlMap[key] > bestDay.value) bestDay = { date: key, value: pnlMap[key] };
    });

    $('#calSummary').innerHTML =
      '<span class="chip ' + toneClass(monthPnl) + '">' + U.escapeHtml(U.money(monthPnl, { sign: true })) + '</span>' +
      '<span class="chip">' + closedMonth.length + ' ' + pluralTrades(closedMonth.length) + '</span>' +
      '<span class="chip">Винрейт ' + (monthMetrics.count ? U.percent(monthMetrics.winRate, 0) : '—') + '</span>' +
      (bestDay && bestDay.value > 0.004 ? '<span class="chip pos">Лучший день +' + U.escapeHtml(U.money(bestDay.value)) + '</span>' : '');

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - offset);
    const today = U.todayISO();
    const maxAbs = dayValues.length ? Math.max.apply(null, dayValues.map(Math.abs)) : 0;

    let html = '';
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = U.isoOf(date);
      const inMonth = date.getMonth() === month;
      const dayPnl = pnlMap[iso] || 0;
      const count = countMap[iso] || 0;
      const hasNote = notesByDate[iso] && notesByDate[iso].length > 0;
      const ratio = maxAbs > 0 ? Math.abs(dayPnl) / maxAbs : 0;
      let style = '';
      if (dayPnl > 0.004) style = 'background:rgba(49,227,170,' + (0.05 + ratio * 0.24).toFixed(3) + ')';
      else if (dayPnl < -0.004) style = 'background:rgba(255,107,129,' + (0.05 + ratio * 0.24).toFixed(3) + ')';

      const classes = ['cal-day'];
      if (!inMonth) classes.push('other');
      if (iso === today) classes.push('today');
      if (iso === state.selectedDay) classes.push('selected');

      const titleParts = [U.formatDate(iso, 'full')];
      if (count) titleParts.push(U.money(dayPnl, { sign: true }) + ' · ' + count + ' ' + pluralTrades(count));
      if (hasNote) titleParts.push('есть запись в журнале');

      html += '<button type="button" class="' + classes.join(' ') + '" data-date="' + iso + '"' +
        (style ? ' style="' + style + '"' : '') + ' title="' + U.escapeHtml(titleParts.join(' · ')) + '">' +
        '<span class="cal-num">' + date.getDate() + '</span>' +
        (count ? '<span class="cal-pnl ' + toneClass(dayPnl) + '">' + U.escapeHtml(U.compactMoney(dayPnl, { sign: true })) + '</span>' : '') +
        (count || hasNote
          ? '<span class="cal-meta">' + (count ? count + ' ' + pluralTrades(count) : '') +
            (hasNote ? '<span class="cal-note-dot" title="Есть запись"></span>' : '') + '</span>'
          : '') +
        '</button>';
    }

    $('#calGrid').innerHTML = html;
    renderDayPanel();
  }

  function renderDayPanel() {
    const card = $('#dayCard');
    const day = state.selectedDay;
    if (!day) {
      card.innerHTML = '<div class="day-empty">Выберите день в календаре, чтобы увидеть детали.</div>';
      return;
    }

    const dayTrades = store.state.trades
      .filter(function (trade) { return trade.date === day; })
      .sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
    const closedTrades = dayTrades.filter(store.isClosed);
    let dayPnl = 0;
    closedTrades.forEach(function (trade) {
      const pnl = store.tradePnl(trade);
      if (pnl !== null) dayPnl += pnl;
    });

    const dayNotes = store.state.notes
      .filter(function (note) { return note.date === day; })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

    const wins = closedTrades.filter(function (trade) { return (store.tradePnl(trade) || 0) > 0.004; }).length;
    const losses = closedTrades.filter(function (trade) { return (store.tradePnl(trade) || 0) < -0.004; }).length;

    let tradesHtml = '';
    if (!dayTrades.length) {
      tradesHtml = '<div class="day-empty">В этот день сделок нет.<br>Можно добавить сделку или записать наблюдение.</div>';
    } else {
      tradesHtml = '<div class="day-sub">Сделки дня</div>' + dayTrades.map(function (trade) {
        const open = !store.isClosed(trade);
        const pnl = store.tradePnl(trade);
        return '<div class="day-trade" data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
          '<span class="day-trade-symbol">' + U.escapeHtml(trade.symbol) +
          ' <span class="day-trade-side">' + (trade.side === 'long' ? 'long' : 'short') + '</span></span>' +
          '<span class="day-trade-pnl ' + (open ? 'neutral' : toneClass(pnl)) + '">' +
          (open ? 'открыта' : U.escapeHtml(U.money(pnl, { sign: true }))) + '</span></div>';
      }).join('');
    }

    let notesHtml = '';
    if (dayNotes.length) {
      const note = dayNotes[0];
      const mood = U.moodMeta(note.mood);
      notesHtml = '<div class="day-sub">Запись в журнале</div>' +
        '<div class="day-note"><div class="day-note-head">' + mood.emoji + ' ' + U.escapeHtml(note.title || mood.label) + '</div>' +
        '<p>' + U.escapeHtml(U.truncate(note.text, 180)) + '</p>' +
        '<div style="margin-top:6px"><button type="button" class="link-btn" data-edit-note="' + U.escapeHtml(note.id) + '">Открыть запись</button>' +
        (dayNotes.length > 1 ? '<span class="muted small"> · ещё ' + (dayNotes.length - 1) + '</span>' : '') + '</div></div>';
    }

    const closedInfo = closedTrades.length
      ? closedTrades.length + ' ' + pluralTrades(closedTrades.length) + ' · ' + wins + 'W / ' + losses + 'L'
      : 'закрытых сделок нет';

    card.innerHTML =
      '<div class="day-head"><div><h2>' + U.escapeHtml(U.formatDate(day, 'long')) + '</h2>' +
      '<p>' + U.escapeHtml(U.formatDate(day, 'weekday-full')) + '</p></div>' +
      '<span class="chip">' + dayTrades.length + ' ' + pluralTrades(dayTrades.length) + '</span></div>' +
      '<div class="day-pnl"><span>Результат дня</span><strong class="' + toneClass(dayPnl) + '">' +
      (closedTrades.length ? U.escapeHtml(U.money(dayPnl, { sign: true })) : '—') + '</strong><small>' + U.escapeHtml(closedInfo) + '</small></div>' +
      tradesHtml + notesHtml +
      '<div class="day-actions">' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="new-trade" data-date="' + day + '">+ Сделка</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="new-note" data-date="' + day + '">Запись в журнал</button>' +
      '</div>';
  }

  function changeMonth(delta) {
    if (!state.calCursor) state.calCursor = monthStart(new Date());
    state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() + delta, 1);
    state.selectedDay = defaultDayForMonth(state.calCursor);
    renderCalendar();
  }

  function defaultDayForMonth(cursor) {
    const now = new Date();
    if (cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth()) return U.todayISO();
    const prefix = cursor.getFullYear() + '-' + pad2(cursor.getMonth() + 1);
    const days = store.state.trades
      .filter(function (trade) { return (trade.date || '').slice(0, 7) === prefix; })
      .map(function (trade) { return trade.date; })
      .sort();
    return days[0] || prefix + '-01';
  }

  /* ============================================================
     Analytics
     ============================================================ */

  function renderAnalytics() {
    const data = buildPeriodMetrics();
    const m = data.m;
    const rows = m.rows;
    const hasR = m.rCount > 0;

    $('#insights').innerHTML = buildInsights(m).map(function (insight) {
      return '<div class="insight ' + (insight.tone || '') + '"><span class="insight-ico">' + insight.icon + '</span><span>' + insight.text + '</span></div>';
    }).join('');

    const cards = [
      {
        label: 'Средняя сделка',
        value: m.count ? U.money(m.expectancy, { sign: true }) : '—',
        tone: toneClass(m.expectancy),
        sub: m.count ? m.count + ' ' + pluralTrades(m.count) + ' за период' : 'Нет данных'
      },
      {
        label: 'Средний R',
        value: hasR ? U.rfmt(m.avgR, { sign: true }) : '—',
        tone: hasR ? toneClass(m.avgR) : '',
        sub: hasR ? 'Всего ' + U.rfmt(m.totalR, { sign: true }) + ' · ' + m.rCount + ' с R' : 'Нужны стопы при входе'
      },
      {
        label: 'Винрейт',
        value: m.count ? U.percent(m.winRate, 0) : '—',
        tone: m.count ? (m.winRate >= 50 ? 'pos' : '') : '',
        sub: m.count ? m.wins + ' прибыльных · ' + m.losses + ' убыточных' : 'Нет данных'
      },
      {
        label: 'Профит-фактор',
        value: m.count ? (m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2).replace('.', ',')) : '—',
        tone: m.count ? (m.profitFactor > 1 ? 'pos' : 'neg') : '',
        sub: m.count ? 'Валовая прибыль / убыток' : 'Нет данных'
      },
      {
        label: 'Лучшая сделка',
        value: m.best ? U.money(m.best.pnl, { sign: true }) : '—',
        tone: m.best ? 'pos' : '',
        sub: m.best ? m.best.trade.symbol + ' · ' + U.formatDate(m.best.trade.date, 'med') : 'Нет данных'
      },
      {
        label: 'Худшая сделка',
        value: m.worst ? U.money(m.worst.pnl, { sign: true }) : '—',
        tone: m.worst ? 'neg' : '',
        sub: m.worst ? m.worst.trade.symbol + ' · ' + U.formatDate(m.worst.trade.date, 'med') : 'Нет данных'
      }
    ];
    $('#analyticsKpis').innerHTML = cards.map(function (card) {
      return '<div class="kpi"><div class="kpi-label">' + U.escapeHtml(card.label) + '</div>' +
        '<div class="kpi-value ' + (card.tone || '') + '">' + U.escapeHtml(card.value) + '</div>' +
        '<div class="kpi-sub">' + U.escapeHtml(card.sub) + '</div></div>';
    }).join('');

    renderHistogram(rows);
    renderSideBreakdown(rows);

    renderBreakdown($('#symbolBreakdown'), store.groupRows(rows, function (t) { return t.symbol; }), {
      empty: 'Нет сделок за период'
    });

    renderBreakdown($('#setupBreakdown'), store.groupRows(rows, function (t) { return t.setup || 'Без сетапа'; }), {
      empty: 'Сетапы не указаны'
    });

    const weekdayGroups = store.groupRows(rows, function (t) { return String(U.weekdayIndex(t.date)); });
    const weekdayMap = {};
    weekdayGroups.forEach(function (group) { weekdayMap[group.key] = group; });
    const weekdays = NS.WEEKDAY_LABELS.map(function (label, index) {
      const group = weekdayMap[String(index)];
      return group
        ? Object.assign({}, group, { key: label })
        : { key: label, count: 0, pnl: 0, winRate: 0, avgR: 0 };
    });
    renderBreakdown($('#weekdayBreakdown'), weekdays, { preserveOrder: true, empty: 'Нет сделок за период' });

    renderBreakdown($('#emotionBreakdown'), store.groupRows(rows, function (t) { return t.emotion || '—'; }), {
      labelFn: function (key) {
        const meta = U.emotionMeta(key);
        return meta.emoji + ' ' + meta.label;
      },
      empty: 'Эмоции не указаны'
    });

    const sessionGroups = store.groupRows(rows, function (t) { return U.sessionOf(t.time); });
    const sessionOrder = ['Азия', 'Лондон', 'Нью-Йорк', 'Вечер', 'Без времени'];
    sessionGroups.sort(function (a, b) { return sessionOrder.indexOf(a.key) - sessionOrder.indexOf(b.key); });
    renderBreakdown($('#sessionBreakdown'), sessionGroups, { preserveOrder: true, empty: 'Нет сделок за период' });

    renderQuality(m);
    renderSetupTable(rows);
  }

  function buildInsights(m) {
    if (!m.count) {
      return [{ tone: '', icon: '💡', text: 'Пока нет закрытых сделок за выбранный период. Добавьте сделки — и здесь появятся закономерности вашей торговли.' }];
    }
    const out = [];
    const rows = m.rows;
    const setups = store.groupRows(rows, function (t) { return t.setup || 'Без сетапа'; })
      .filter(function (g) { return g.count >= 3; })
      .sort(function (a, b) { return b.pnl - a.pnl; });

    if (setups.length) {
      const best = setups[0];
      if (best.pnl > 0.004) {
        out.push({
          tone: 'pos', icon: '★',
          text: 'Лучший сетап — <b>' + U.escapeHtml(best.key) + '</b>: <b class="pos">' + U.escapeHtml(U.money(best.pnl, { sign: true })) + '</b> за ' + best.count + ' ' + pluralTrades(best.count) + ', винрейт ' + U.percent(best.winRate, 0) + '.'
        });
      }
      if (setups.length > 1) {
        const worst = setups[setups.length - 1];
        if (worst.pnl < -0.004) {
          out.push({
            tone: 'neg', icon: '!',
            text: 'Проблемный сетап — <b>' + U.escapeHtml(worst.key) + '</b>: <b class="neg">' + U.escapeHtml(U.money(worst.pnl, { sign: true })) + '</b> за ' + worst.count + ' ' + pluralTrades(worst.count) + '. Стоит пересмотреть условия входа.'
          });
        }
      }
    }

    const weekdayGroups = store.groupRows(rows, function (t) { return String(U.weekdayIndex(t.date)); })
      .filter(function (g) { return g.count >= 2; })
      .sort(function (a, b) { return a.pnl - b.pnl; });
    if (weekdayGroups.length > 1) {
      const worstDay = weekdayGroups[0];
      if (worstDay.pnl < -0.004) {
        out.push({
          tone: 'warn', icon: '◷',
          text: 'Самый слабый день — <b>' + NS.WEEKDAY_LABELS[Number(worstDay.key)] + '</b>: <b class="neg">' + U.escapeHtml(U.money(worstDay.pnl, { sign: true })) + '</b> за ' + worstDay.count + ' ' + pluralTrades(worstDay.count) + '. Возможно, стоит торговать в этот день меньшим объёмом.'
        });
      }
    }

    const emotions = store.groupRows(rows, function (t) { return t.emotion || '—'; })
      .filter(function (g) { return g.count >= 3; })
      .sort(function (a, b) { return a.pnl - b.pnl; });
    if (emotions.length) {
      const worstEmotion = emotions[0];
      if (worstEmotion.pnl < -0.004 && worstEmotion.key !== '—') {
        const meta = U.emotionMeta(worstEmotion.key);
        out.push({
          tone: 'warn', icon: '🧠',
          text: 'Эмоция <b>' + U.escapeHtml(meta.label) + '</b> стоит вам <b class="neg">' + U.escapeHtml(U.money(worstEmotion.pnl, { sign: true })) + '</b> за ' + worstEmotion.count + ' ' + pluralTrades(worstEmotion.count) + '. Замечайте её до входа.'
        });
      }
    }

    const sides = store.groupRows(rows, function (t) { return t.side; });
    const longGroup = sides.find(function (g) { return g.key === 'long'; });
    const shortGroup = sides.find(function (g) { return g.key === 'short'; });
    if (longGroup && shortGroup && longGroup.count >= 3 && shortGroup.count >= 3) {
      const better = longGroup.pnl >= shortGroup.pnl ? longGroup : shortGroup;
      const label = better.key === 'long' ? 'Long' : 'Short';
      if (better.pnl > 0.004) {
        out.push({
          tone: '', icon: '↗',
          text: 'Сильнее работает направление <b>' + label + '</b>: <b class="pos">' + U.escapeHtml(U.money(better.pnl, { sign: true })) + '</b> и винрейт ' + U.percent(better.winRate, 0) + ' против ' + U.percent((better === longGroup ? shortGroup : longGroup).winRate, 0) + ' у противоположного.'
        });
      }
    }

    if (out.length < 3 && m.avgDiscipline > 0) {
      if (m.avgDiscipline < 3.5) {
        out.push({
          tone: 'warn', icon: '◎',
          text: 'Средняя дисциплина <b>' + m.avgDiscipline.toFixed(1).replace('.', ',') + ' / 5</b>. Сделки вне плана заметно ухудшают результат — начните с чек-листа перед входом.'
        });
      } else if (m.avgDiscipline >= 4.2) {
        out.push({
          tone: 'pos', icon: '✓',
          text: 'Средняя дисциплина <b>' + m.avgDiscipline.toFixed(1).replace('.', ',') + ' / 5</b>. Вы стабильно следуете плану — это важнее отдельной прибыльной сделки.'
        });
      }
    }

    if (!out.length && m.best) {
      out.push({
        tone: 'pos', icon: '★',
        text: 'Лучшая сделка периода — <b>' + U.escapeHtml(m.best.trade.symbol) + '</b> на <b class="pos">' + U.escapeHtml(U.money(m.best.pnl, { sign: true })) + '</b>. Продолжайте собирать статистику: для выводов нужно больше сделок.'
      });
    }

    return out.slice(0, 4);
  }

  function renderHistogram(rows) {
    const container = $('#rHistogram');
    const bins = [
      { label: '< −2R', from: -Infinity, to: -2, neg: true },
      { label: '−2…−1R', from: -2, to: -1, neg: true },
      { label: '−1…0R', from: -1, to: 0, neg: true },
      { label: '0…1R', from: 0, to: 1, neg: false },
      { label: '1…2R', from: 1, to: 2, neg: false },
      { label: '2…3R', from: 2, to: 3, neg: false },
      { label: '> 3R', from: 3, to: Infinity, neg: false }
    ].map(function (bin) { return Object.assign({ count: 0 }, bin); });

    let total = 0;
    rows.forEach(function (row) {
      if (row.r === null) return;
      total++;
      const r = row.r;
      let index;
      if (r < -2) index = 0;
      else if (r < -1) index = 1;
      else if (r < 0) index = 2;
      else if (r < 1) index = 3;
      else if (r < 2) index = 4;
      else if (r < 3) index = 5;
      else index = 6;
      bins[index].count++;
    });

    if (!total) {
      container.innerHTML = '<div class="hb-empty" style="grid-column:1/-1">Добавьте стоп-лосс к сделкам, чтобы увидеть распределение R.</div>';
      return;
    }

    const max = Math.max.apply(null, bins.map(function (bin) { return bin.count; }).concat([1]));
    container.innerHTML = bins.map(function (bin) {
      const height = bin.count ? Math.max(5, Math.round(bin.count / max * 132)) : 2;
      const cls = bin.count ? (bin.neg ? 'neg' : '') : 'zero';
      return '<div class="hist-col" title="' + bin.count + ' ' + pluralTrades(bin.count) + '"><div class="hist-bar ' + cls + '" style="height:' + height + 'px"></div>' +
        '<span class="hist-label">' + bin.label + '<b>' + bin.count + '</b></span></div>';
    }).join('');
  }

  function renderSideBreakdown(rows) {
    const groups = store.groupRows(rows, function (t) { return t.side; });
    const longGroup = groups.find(function (g) { return g.key === 'long'; }) || { count: 0, pnl: 0, winRate: 0 };
    const shortGroup = groups.find(function (g) { return g.key === 'short'; }) || { count: 0, pnl: 0, winRate: 0 };

    $('#sideBreakdown').innerHTML = [['long', 'Long', longGroup], ['short', 'Short', shortGroup]].map(function (item) {
      const side = item[0], label = item[1], group = item[2];
      return '<div class="side-box ' + side + '"><div class="side-box-top"><span>' + label + '</span>' +
        '<strong class="' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</strong></div>' +
        '<sub>' + group.count + ' ' + pluralTrades(group.count) + ' · винрейт ' + (group.count ? U.percent(group.winRate, 0) : '—') + '</sub>' +
        '<div class="side-bar"><i style="width:' + (group.count ? Math.min(100, group.winRate) : 0) + '%"></i></div></div>';
    }).join('');
  }

  function renderBreakdown(container, groups, options) {
    options = options || {};
    let list = groups.slice();
    if (!options.preserveOrder) list.sort(function (a, b) { return b.pnl - a.pnl; });
    list = list.filter(function (group, index) { return options.preserveOrder || index < 6; });

    if (!options.preserveOrder) list = list.slice(0, 6);

    if (!list.length) {
      container.innerHTML = '<div class="hb-empty">' + U.escapeHtml(options.empty || 'Нет данных') + '</div>';
      return;
    }

    const max = Math.max.apply(null, list.map(function (group) { return Math.abs(group.pnl); }).concat([1]));
    container.innerHTML = list.map(function (group) {
      const label = options.labelFn ? options.labelFn(group.key) : group.key;
      const width = group.pnl === 0 ? 0 : Math.max(3, Math.abs(group.pnl) / max * 100);
      return '<div class="hb-row" title="' + U.escapeHtml(group.count + ' ' + pluralTrades(group.count) + ' · винрейт ' + U.percent(group.winRate, 0)) + '">' +
        '<div class="hb-top"><span class="hb-label">' + U.escapeHtml(label) +
        '<small>' + group.count + '</small></span>' +
        '<span class="hb-value ' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</span></div>' +
        '<div class="hb-track"><div class="hb-fill ' + (group.pnl < 0 ? 'neg' : '') + '" style="width:' + width + '%"></div></div></div>';
    }).join('');
  }

  function renderQuality(m) {
    const withR = m.rows.filter(function (row) { return row.r !== null; }).length;
    const discipline = m.avgDiscipline > 0 ? m.avgDiscipline.toFixed(1).replace('.', ',') + ' / 5' : '—';
    const totalR = withR ? U.rfmt(m.totalR, { sign: true }) : '—';
    $('#qualityBlock').innerHTML =
      '<div class="quality-row"><span>Всего R</span><b class="' + (withR ? toneClass(m.totalR) : '') + '">' + U.escapeHtml(totalR) + '</b></div>' +
      '<div class="quality-row"><span>Сделок с рассчитанным R</span><b>' + withR + ' из ' + m.count + '</b></div>' +
      '<div class="quality-row"><span>Средняя дисциплина</span><b>' + discipline + '</b></div>' +
      '<div class="quality-row"><span>Комиссии и издержки</span><b class="neg">' + U.escapeHtml(U.money(-m.fees)) + '</b></div>' +
      '<div class="quality-row"><span>Средняя прибыль</span><b class="pos">' + U.escapeHtml(U.money(m.avgWin)) + '</b></div>' +
      '<div class="quality-row"><span>Средний убыток</span><b class="neg">' + U.escapeHtml(U.money(-m.avgLoss)) + '</b></div>' +
      '<div class="quality-row"><span>Серия побед</span><b>' + m.maxWinStreak + '</b></div>' +
      '<div class="quality-row"><span>Серия поражений</span><b>' + m.maxLossStreak + '</b></div>';
  }

  function renderSetupTable(rows) {
    const groups = store.groupRows(rows, function (t) { return t.setup || 'Без сетапа'; })
      .sort(function (a, b) { return b.pnl - a.pnl; });
    const tbody = $('#setupTableBody');
    if (!groups.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted-2);padding:24px">Нет данных за период</td></tr>';
      return;
    }
    tbody.innerHTML = groups.map(function (group) {
      const pf = group.profitFactor === Infinity ? '∞' : group.profitFactor.toFixed(2).replace('.', ',');
      const hasR = group.rCount > 0;
      return '<tr><td>' + U.escapeHtml(group.key) + '</td>' +
        '<td class="num">' + group.count + '</td>' +
        '<td class="num">' + U.percent(group.winRate, 0) + '</td>' +
        '<td class="num ' + (hasR ? toneClass(group.avgR) : '') + '">' + (hasR ? U.escapeHtml(U.rfmt(group.avgR, { sign: true })) : '—') + '</td>' +
        '<td class="num ' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</td>' +
        '<td class="num">' + pf + '</td></tr>';
    }).join('');
  }

  /* ============================================================
     Journal
     ============================================================ */

  function renderJournal() {
    const notes = store.state.notes.slice().sort(function (a, b) {
      return (b.date + String(b.createdAt)).localeCompare(a.date + String(a.createdAt));
    });

    const dates = new Set(notes.map(function (note) { return note.date; }));
    const moodScore = notes.length
      ? notes.reduce(function (acc, note) { return acc + U.moodMeta(note.mood).score; }, 0) / notes.length
      : 0;
    const latest = notes.length ? notes[0].date : null;

    $('#journalStats').innerHTML =
      '<div class="jstat"><span>Записей</span><strong>' + notes.length + '</strong><small>в дневнике</small></div>' +
      '<div class="jstat"><span>Дней с записями</span><strong>' + dates.size + '</strong><small>из истории</small></div>' +
      '<div class="jstat"><span>Среднее настроение</span><strong>' + (notes.length ? moodScore.toFixed(1).replace('.', ',') + ' / 5' : '—') + '</strong><small>по всем записям</small></div>' +
      '<div class="jstat"><span>Последняя запись</span><strong>' + (latest ? U.formatDate(latest, 'med') : '—') + '</strong><small>' + (latest ? U.formatDate(latest, 'weekday-full') : 'пока нет записей') + '</small></div>';

    const container = $('#journalList');
    if (!notes.length) {
      container.innerHTML = '<div class="card empty-state" style="grid-column:1/-1">' +
        '<div class="empty-icon">📝</div><h3>Дневник пока пуст</h3>' +
        '<p>Записывайте выводы после торгового дня: что сработало, что нет и что измените завтра.</p>' +
        '<div class="empty-actions"><button class="btn btn-primary" data-action="new-note">Новая запись</button></div></div>';
      return;
    }

    const dayStats = new Map();
    store.state.trades.forEach(function (trade) {
      if (!store.isClosed(trade)) {
        let item = dayStats.get(trade.date);
        if (!item) { item = { pnl: 0, count: 0 }; dayStats.set(trade.date, item); }
        item.count++;
        return;
      }
      const pnl = store.tradePnl(trade);
      if (pnl === null) return;
      let item = dayStats.get(trade.date);
      if (!item) { item = { pnl: 0, count: 0 }; dayStats.set(trade.date, item); }
      item.pnl += pnl;
      item.count++;
    });

    container.innerHTML = notes.map(function (note) {
      const mood = U.moodMeta(note.mood);
      const day = dayStats.get(note.date) || { pnl: 0, count: 0 };
      return '<article class="note-card" style="--mood:' + mood.color + '">' +
        '<div class="note-head"><span class="note-date">' + U.escapeHtml(U.formatDate(note.date, 'long')) +
        '<span>' + U.escapeHtml(U.formatDate(note.date, 'weekday')) + '</span></span>' +
        '<span class="mood-chip">' + mood.emoji + ' ' + U.escapeHtml(mood.label) + '</span></div>' +
        (day.count ? '<span class="note-daypnl ' + toneClass(day.pnl) + '">' + U.escapeHtml(U.money(day.pnl, { sign: true })) + ' · ' + day.count + ' ' + pluralTrades(day.count) + '</span>' : '') +
        '<h3>' + U.escapeHtml(note.title || 'Без заголовка') + '</h3>' +
        '<p class="note-text">' + U.escapeHtml(note.text) + '</p>' +
        (note.tags.length ? '<div class="note-tags">' + note.tags.map(function (tag) { return '<span class="tag">' + U.escapeHtml(tag) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="note-foot"><span>' + (day.count ? day.count + ' ' + pluralTrades(day.count) + ' в этот день' : 'без сделок') + '</span>' +
        '<div class="note-actions">' +
        '<button type="button" class="icon-btn" data-edit-note="' + U.escapeHtml(note.id) + '" title="Редактировать" aria-label="Редактировать запись">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
        '<button type="button" class="icon-btn danger" data-delete-note="' + U.escapeHtml(note.id) + '" title="Удалить" aria-label="Удалить запись">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg></button>' +
        '</div></div></article>';
    }).join('');
  }

  /* ============================================================
     Calculator
     ============================================================ */

  function ensureCalcDefaults() {
    const balanceField = $('#calcBalance');
    const riskField = $('#calcRisk');
    if (!balanceField.value) balanceField.value = round2(store.balanceAll());
    if (!riskField.value) riskField.value = store.state.settings.riskPercent;
    if (!$('#calcPointValue').value) $('#calcPointValue').value = '1';
    calcUpdate();
  }

  function resetCalculator() {
    $('#calcBalance').value = round2(store.balanceAll());
    $('#calcRisk').value = store.state.settings.riskPercent;
    $('#calcPointValue').value = '1';
    $('#calcEntry').value = '';
    $('#calcStop').value = '';
    $('#calcTarget').value = '';
    calcUpdate();
  }

  function round2(value) {
    const num = U.parseNum(value);
    return num === null ? '' : String(Math.round(num * 100) / 100);
  }

  function calcUpdate() {
    if (!$('#calcQtyValue')) return;
    const balance = U.parseNum($('#calcBalance').value);
    const riskPct = U.parseNum($('#calcRisk').value);
    const entry = U.parseNum($('#calcEntry').value);
    const stop = U.parseNum($('#calcStop').value);
    const target = U.parseNum($('#calcTarget').value);
    const pointValue = U.parseNum($('#calcPointValue').value);

    const riskAmount = balance !== null && riskPct !== null ? balance * riskPct / 100 : null;
    const distance = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
    let quantity = null;
    let notional = null;

    if (riskAmount !== null && distance !== null && distance > 0 && pointValue !== null && pointValue > 0) {
      quantity = riskAmount / (distance * pointValue);
      if (entry !== null) notional = quantity * entry;
    }

    let rr = null;
    if (entry !== null && stop !== null && target !== null && distance > 0) {
      rr = Math.abs(target - entry) / distance;
    }
    const potentialProfit = rr !== null && riskAmount !== null ? riskAmount * rr : null;

    $('#calcQtyValue').textContent = quantity !== null ? U.qty(quantity) : '—';
    $('#calcNotional').textContent = 'Номинал: ' + (notional !== null ? U.money(notional) : '—');
    $('#calcRiskAmount').textContent = riskAmount !== null ? U.money(riskAmount) : '—';
    $('#calcLoss').textContent = riskAmount !== null ? U.money(-riskAmount) : '—';
    $('#calcProfit').textContent = potentialProfit !== null ? U.money(potentialProfit, { sign: true }) : '—';
    $('#calcRR').textContent = rr !== null ? '1 : ' + rr.toFixed(2).replace('.', ',') : '—';

    let error = '';
    if (entry !== null && stop !== null && Math.abs(entry - stop) < 1e-12) error = 'Стоп-лосс не может совпадать с ценой входа.';
    else if (entry !== null && stop !== null && target !== null && distance > 0 && (target - entry) * (stop - entry) > 0) {
      error = 'Стоп и тейк должны находиться по разные стороны от входа.';
    } else if (pointValue !== null && pointValue <= 0) error = 'Стоимость пункта должна быть больше нуля.';
    else if (balance !== null && balance <= 0) error = 'Укажите баланс счёта больше нуля.';

    $('#calcError').hidden = !error;
    if (error) $('#calcError').textContent = error;

    const visual = $('#rrVisual');
    if (rr !== null && rr > 0 && riskAmount !== null) {
      visual.hidden = false;
      const riskShare = (1 / (1 + rr)) * 100;
      $('#rrRisk').style.flexBasis = riskShare + '%';
      $('#rrReward').style.flexBasis = (100 - riskShare) + '%';
      $('#rrRisk span').textContent = 'Риск ' + U.money(riskAmount);
      $('#rrReward span').textContent = 'Прибыль ' + U.money(potentialProfit);
    } else {
      visual.hidden = true;
    }

    let hint = 'Заполните вход и стоп, чтобы увидеть размер позиции.';
    if (error) {
      hint = '';
    } else if (quantity !== null) {
      hint = 'При риске ' + U.percent(riskPct, 1) + ' (' + U.money(riskAmount) + ') и стопе ' + U.price(stop) +
        ' размер позиции — ' + U.qty(quantity) + '. Убыток по стопу ограничен ' + U.money(riskAmount) + '.';
    } else if (balance === null || riskPct === null) {
      hint = 'Укажите баланс и риск на сделку.';
    }
    $('#calcHint').textContent = hint;
    $('#calcHint').style.display = hint ? '' : 'none';
  }

  /* ============================================================
     Settings & data
     ============================================================ */

  function renderSettings() {
    const settings = store.state.settings;
    $('#settingName').value = settings.name || '';
    $('#settingCurrency').value = settings.currency || '$';
    $('#settingBalance').value = settings.startBalance;
    $('#settingRisk').value = settings.riskPercent;
    $('#settingDailyLimit').value = settings.dailyLossLimit;
    $('#settingMaxTrades').value = settings.maxTradesPerDay;
    $('#settingsSavedAt').textContent = '';

    const size = store.storageSize();
    const storageLimit = desktop ? 100 * 1024 * 1024 : 5 * 1024 * 1024;
    const pct = Math.min(100, size / storageLimit * 100);
    $('#storageText').textContent = U.bytes(size) + ' · ' + pct.toFixed(1).replace('.', ',') + '%';
    $('#storageBar').style.width = Math.max(pct > 0 ? 2 : 0, pct) + '%';

    if (desktop) refreshDesktopBackups();
  }

  function desktopReasonLabel(reason) {
    return {
      auto: 'Автоматическая копия',
      manual: 'Ручная копия',
      'before-restore': 'Перед восстановлением',
      removed: 'Перед сбросом',
      smoke: 'Тестовая копия',
      backup: 'Резервная копия'
    }[reason] || 'Резервная копия';
  }

  function formatBackupDate(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function initDesktopUi() {
    if (!desktop) return;
    const card = $('#desktopDataCard');
    if (!card) return;
    card.hidden = false;
    loadDesktopDataInfo();
    refreshDesktopBackups();
    $('#openDataFolderBtn').addEventListener('click', openDesktopDataFolder);
    $('#backupNowBtn').addEventListener('click', createDesktopBackup);
    $('#refreshBackupsBtn').addEventListener('click', refreshDesktopBackups);
    $('#desktopBackupsList').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-backup]');
      if (!button) return;
      restoreDesktopBackup(button.dataset.backup);
    });
  }

  async function loadDesktopDataInfo() {
    if (!desktop) return;
    try {
      const info = await desktop.getDataInfo();
      const path = info && (info.journalPath || info.dataDir);
      if (path) {
        $('#desktopDataPath').textContent = path;
        $('#desktopDataPath').title = path;
      }
    } catch (err) {
      $('#desktopDataPath').textContent = 'Не удалось получить путь к данным';
    }
  }

  async function refreshDesktopBackups() {
    if (!desktop) return;
    const list = $('#desktopBackupsList');
    if (!list) return;
    try {
      const backups = await desktop.listBackups();
      if (!backups.length) {
        list.innerHTML = '<p class="muted small">Резервных копий пока нет. Они создаются автоматически при сохранении журнала и вручную по кнопке выше.</p>';
        return;
      }
      const visible = backups.slice(0, 8);
      list.innerHTML = visible.map(function (backup) {
        return '<div class="backup-row">' +
          '<div class="backup-meta">' +
            '<strong>' + U.escapeHtml(desktopReasonLabel(backup.reason)) + '</strong>' +
            '<span>' + U.escapeHtml(formatBackupDate(backup.mtime)) + ' · ' + U.escapeHtml(U.bytes(backup.size)) + '</span>' +
          '</div>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-backup="' + U.escapeHtml(backup.name) + '">Восстановить</button>' +
        '</div>';
      }).join('') + (backups.length > visible.length
        ? '<p class="muted small">Показаны последние ' + visible.length + ' из ' + backups.length + ' копий. Остальные лежат в папке backups.</p>'
        : '');
    } catch (err) {
      list.innerHTML = '<p class="muted small">Не удалось прочитать список резервных копий. Откройте папку данных вручную.</p>';
    }
  }

  async function createDesktopBackup() {
    if (!desktop) return;
    try {
      const result = await desktop.backup();
      if (!result || !result.ok) {
        toast(result && result.error ? result.error : 'Не удалось создать резервную копию.', 'error');
        return;
      }
      refreshDesktopBackups();
      toast('Резервная копия создана');
    } catch (err) {
      toast('Не удалось создать резервную копию: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  async function openDesktopDataFolder() {
    if (!desktop) return;
    try {
      const result = await desktop.openDataFolder();
      if (!result || !result.ok) {
        toast(result && result.error ? result.error : 'Не удалось открыть папку данных.', 'error');
      }
    } catch (err) {
      toast('Не удалось открыть папку данных: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  function restoreDesktopBackup(name) {
    if (!desktop) return;
    askConfirm({
      title: 'Восстановить резервную копию?',
      text: 'Текущий журнал будет заменён выбранной копией. Перед заменой приложение сохранит текущее состояние ещё одной резервной копией.',
      okLabel: 'Восстановить'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      try {
        const result = await desktop.restoreBackup(name);
        if (!result || !result.ok) {
          toast(result && result.error ? result.error : 'Не удалось восстановить копию.', 'error');
          return;
        }
        if (!store.load()) {
          toast('Копия записана в файл, но приложение не смогло её перечитать. Перезапустите приложение.', 'error');
          return;
        }
        applyCurrency();
        state.calCursor = monthStart(new Date());
        state.selectedDay = U.todayISO();
        renderAll();
        refreshDesktopBackups();
        toast('Резервная копия восстановлена');
      } catch (err) {
        toast('Не удалось восстановить копию: ' + (err && err.message ? err.message : err), 'error');
      }
    });
  }

  function saveSettings(event) {
    event.preventDefault();
    const name = $('#settingName').value.trim();
    const currency = $('#settingCurrency').value || '$';
    const balance = U.parseNum($('#settingBalance').value);
    const risk = U.parseNum($('#settingRisk').value);
    const daily = U.parseNum($('#settingDailyLimit').value);
    const maxTrades = U.parseNum($('#settingMaxTrades').value);

    if (balance === null || balance < 0) return toast('Стартовый баланс должен быть неотрицательным числом.', 'error');
    if (risk === null || risk < 0 || risk > 100) return toast('Риск на сделку должен быть от 0 до 100%.', 'error');
    if (daily === null || daily < 0 || daily > 100) return toast('Дневной лимит убытка должен быть от 0 до 100%.', 'error');
    if (maxTrades === null || maxTrades < 0) return toast('Максимум сделок в день должен быть неотрицательным.', 'error');

    store.state.settings = {
      name: name,
      currency: currency,
      startBalance: balance,
      riskPercent: risk,
      dailyLossLimit: daily,
      maxTradesPerDay: Math.round(maxTrades)
    };
    store.state.demo = false;
    applyCurrency();
    const ok = persist();
    renderSidebar();
    renderCurrentView();
    if (ok) {
      $('#settingsSavedAt').textContent = 'Сохранено в ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      toast('Настройки сохранены');
    }
  }

  function exportJSON() {
    const payload = {
      app: 'TradeJournal',
      version: 1,
      exportedAt: new Date().toISOString(),
      demo: !!store.state.demo,
      settings: store.state.settings,
      trades: store.state.trades,
      notes: store.state.notes
    };
    U.download('tradejournal-' + U.todayISO() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('Резервная копия скачана');
  }

  function csvCell(value) {
    return '"' + String(value === null || value === undefined ? '' : value).replace(/"/g, '""') + '"';
  }

  function csvText(value) {
    const text = String(value === null || value === undefined ? '' : value);
    const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
    return '"' + safe.replace(/"/g, '""') + '"';
  }

  function csvNumber(value, digits) {
    const num = U.parseNum(value);
    if (num === null) return '';
    return num.toFixed(digits === undefined ? 2 : digits).replace('.', ',');
  }

  function exportCSV() {
    const trades = store.sortTrades(store.state.trades, 'desc');
    const headers = ['Дата', 'Время', 'Инструмент', 'Направление', 'Вход', 'Выход', 'Стоп при входе', 'Текущий стоп', 'Тейк', 'Количество', 'Комиссия', 'P&L', 'R', 'Сетап', 'Эмоция', 'Дисциплина', 'Теги', 'Заметка'];
    const lines = [headers.map(csvCell).join(';')];
    trades.forEach(function (trade) {
      const emotion = U.emotionMeta(trade.emotion);
      const pnl = store.isClosed(trade) ? store.tradePnl(trade) : null;
      const r = store.isClosed(trade) ? store.tradeR(trade) : null;
      const row = [
        csvText(trade.date),
        csvText(trade.time),
        csvText(trade.symbol),
        csvText(trade.side === 'long' ? 'Long' : 'Short'),
        csvNumber(trade.entry, 6),
        trade.exit === null ? '' : csvNumber(trade.exit, 6),
        trade.stop === null ? '' : csvNumber(trade.stop, 6),
        trade.currentStop === null ? '' : csvNumber(trade.currentStop, 6),
        trade.target === null ? '' : csvNumber(trade.target, 6),
        csvNumber(trade.qty, 4),
        csvNumber(trade.fees, 2),
        pnl === null ? '' : csvNumber(pnl, 2),
        r === null ? '' : csvNumber(r, 2),
        csvText(trade.setup),
        csvText(emotion.label),
        trade.discipline ? csvNumber(trade.discipline, 0) : '',
        csvText(trade.tags.join(', ')),
        csvText(trade.notes)
      ];
      lines.push(row.join(';'));
    });
    U.download('tradejournal-trades-' + U.todayISO() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('Таблица сделок скачана в CSV');
  }

  function importJSONFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let data;
      try {
        data = JSON.parse(String(reader.result || ''));
      } catch (err) {
        toast('Не удалось прочитать файл: это не корректный JSON.', 'error');
        return;
      }
      if (!store.isJournalData(data)) {
        toast('В файле нет корректных массивов сделок и записей. Похоже, это резервная копия другого формата.', 'error');
        return;
      }
      askConfirm({
        title: 'Импортировать данные?',
        text: 'Текущие сделки и записи будут заменены данными из файла. Рекомендуем сначала сделать экспорт текущего журнала. Сразу после импорта действие можно будет отменить.',
        okLabel: 'Импортировать'
      }).then(function (confirmed) {
        if (!confirmed) return;
        const before = JSON.parse(JSON.stringify(store.state));
        const ok = store.replaceData(data);
        if (!ok) {
          store.replaceData(before);
          applyCurrency();
          renderAll();
          toast('Импорт не сохранён: не удалось записать данные. Журнал оставлен прежним.', 'error');
          return;
        }
        applyCurrency();
        state.calCursor = monthStart(new Date());
        state.selectedDay = U.todayISO();
        renderAll();
        toast('Импортировано: ' + store.state.trades.length + ' ' + pluralTrades(store.state.trades.length) + ' и ' + store.state.notes.length + ' записей', 'success', {
          label: 'Отменить',
          onClick: function () {
            const restored = store.replaceData(before);
            applyCurrency();
            state.calCursor = monthStart(new Date());
            state.selectedDay = U.todayISO();
            renderAll();
            toast(restored ? 'Импорт отменён, прежние данные восстановлены' : 'Не удалось сохранить откат', restored ? 'success' : 'error');
          }
        });
      });
    };
    reader.onerror = function () { toast('Не удалось открыть файл.', 'error'); };
    reader.readAsText(file);
  }

  function loadDemoData() {
    askConfirm({
      title: 'Загрузить демо-данные?',
      text: 'Текущие сделки и записи будут заменены примерами. В настройках журнал можно очистить в любой момент.',
      okLabel: 'Загрузить демо'
    }).then(function (confirmed) {
      if (!confirmed) return;
      const before = JSON.parse(JSON.stringify(store.state));
      const ok = store.setDemo(NS.sample.generate());
      if (!ok) {
        store.replaceData(before);
        renderAll();
        toast('Демо не сохранено: не удалось записать данные. Журнал оставлен прежним.', 'error');
        return;
      }
      applyCurrency();
      state.calCursor = monthStart(new Date());
      state.selectedDay = U.todayISO();
      renderAll();
      toast('Демо-данные загружены', 'success', {
        label: 'Отменить',
        onClick: function () {
          const restored = store.replaceData(before);
          applyCurrency();
          state.calCursor = monthStart(new Date());
          state.selectedDay = U.todayISO();
          renderAll();
          toast(restored ? 'Демо-данные убраны, прежние восстановлены' : 'Не удалось сохранить откат', restored ? 'success' : 'error');
        }
      });
    });
  }

  function resetJournalData() {
    askConfirm({
      title: 'Очистить все данные?',
      text: 'Все сделки и записи будут удалены. Настройки профиля и стартовый баланс сохранятся. Сразу после очистки действие можно будет отменить.',
      okLabel: 'Очистить всё'
    }).then(function (confirmed) {
      if (!confirmed) return;
      const before = JSON.parse(JSON.stringify(store.state));
      const ok = store.resetData(true);
      if (!ok) {
        store.replaceData(before);
        renderAll();
        toast('Очистка не сохранена: не удалось записать данные. Журнал оставлен прежним.', 'error');
        return;
      }
      applyCurrency();
      state.calCursor = monthStart(new Date());
      state.selectedDay = U.todayISO();
      renderAll();
      toast('Журнал очищен. Начинаем с чистого листа.', 'success', {
        label: 'Отменить',
        onClick: function () {
          const restored = store.replaceData(before);
          applyCurrency();
          state.calCursor = monthStart(new Date());
          state.selectedDay = U.todayISO();
          renderAll();
          toast(restored ? 'Очистка отменена, данные восстановлены' : 'Не удалось сохранить откат', restored ? 'success' : 'error');
        }
      });
    });
  }

  /* ============================================================
     Trade modal
     ============================================================ */

  function buildEmotionSelect() {
    const select = $('#tradeEmotion');
    select.innerHTML = '<option value="">— не указана —</option>' + EMOTION_OPTIONS.map(function (emotion) {
      return '<option value="' + emotion.key + '">' + emotion.emoji + ' ' + U.escapeHtml(emotion.label) + '</option>';
    }).join('');
  }

  function openTradeModal(id, presetDate) {
    const trade = id ? store.state.trades.find(function (t) { return t.id === id; }) : null;
    state.tradeId = trade ? trade.id : null;
    state.screenshot = trade && trade.screenshot ? trade.screenshot : '';

    $('#tradeModalTitle').textContent = trade ? 'Редактировать сделку' : 'Новая сделка';
    $('#tradeDate').value = trade ? trade.date : (presetDate || U.todayISO());
    $('#tradeTime').value = trade ? (trade.time || '') : U.nowTime();
    $('#tradeSymbol').value = trade ? trade.symbol : '';
    $('#tradeEntry').value = trade && trade.entry !== null ? trade.entry : '';
    $('#tradeExit').value = trade && trade.exit !== null ? trade.exit : '';
    $('#tradeStop').value = trade && trade.stop !== null ? trade.stop : '';
    $('#tradeCurrentStop').value = trade && trade.currentStop !== null ? trade.currentStop : '';
    $('#tradeTarget').value = trade && trade.target !== null ? trade.target : '';
    $('#tradeQty').value = trade && trade.qty !== null ? trade.qty : '';
    $('#tradeFees').value = trade ? trade.fees : '';
    $('#tradeSetup').value = trade ? (trade.setup || '') : '';
    $('#tradeEmotion').value = trade ? (trade.emotion || '') : '';
    $('#tradeTags').value = trade ? trade.tags.join(', ') : '';
    $('#tradeNotes').value = trade ? (trade.notes || '') : '';

    setSide(trade ? trade.side : 'long');
    setDiscipline(trade ? trade.discipline : 0);
    renderShotPreview();

    $('#tradeError').hidden = true;
    $('#deleteTradeBtn').classList.toggle('hidden', !trade);
    $('#saveTradeBtn').textContent = trade ? 'Сохранить изменения' : 'Сохранить сделку';
    $('#tradeShot').value = '';
    updateTradePreview();
    openModal('tradeModal', '#tradeSymbol');
  }

  function setSide(side) {
    $('#tradeSide').value = side === 'short' ? 'short' : 'long';
    $$('#sideSegmented button').forEach(function (button) {
      button.classList.toggle('active', button.dataset.side === side);
    });
    updateTradePreview();
  }

  function setDiscipline(value) {
    const level = U.clamp(Math.round(value || 0), 0, 5);
    $('#tradeDiscipline').value = level;
    const labels = ['не оценено', 'хаос', 'слабо', 'нормально', 'хорошо', 'идеально'];
    $('#disciplineLabel').textContent = labels[level];
    $$('#disciplineStars .star').forEach(function (star) {
      star.classList.toggle('active', Number(star.dataset.star) <= level);
    });
  }

  function renderShotPreview() {
    const box = $('#shotPreview');
    const remove = $('#removeShot');
    box.innerHTML = '';
    if (state.screenshot) {
      const image = document.createElement('img');
      image.src = state.screenshot;
      image.alt = 'Скриншот сделки';
      box.appendChild(image);
      box.classList.add('has');
      remove.classList.remove('hidden');
    } else {
      box.classList.remove('has');
      remove.classList.add('hidden');
    }
  }

  function compressScreenshot(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('Можно прикрепить только изображение.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      const image = new Image();
      image.onload = function () {
        const maxSide = 1100;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
          state.screenshot = canvas.toDataURL('image/jpeg', 0.72);
          renderShotPreview();
          toast('Скриншот добавлен');
        } catch (err) {
          toast('Не удалось обработать изображение.', 'error');
        }
      };
      image.onerror = function () { toast('Не удалось открыть изображение.', 'error'); };
      image.src = String(reader.result);
    };
    reader.onerror = function () { toast('Не удалось прочитать файл.', 'error'); };
    reader.readAsDataURL(file);
  }

  function updateTradePreview() {
    const side = $('#tradeSide').value;
    const entry = U.parseNum($('#tradeEntry').value);
    const exit = $('#tradeExit').value.trim() === '' ? null : U.parseNum($('#tradeExit').value);
    const stop = $('#tradeStop').value.trim() === '' ? null : U.parseNum($('#tradeStop').value);
    const target = $('#tradeTarget').value.trim() === '' ? null : U.parseNum($('#tradeTarget').value);
    const qty = U.parseNum($('#tradeQty').value);
    const fees = U.parseNum($('#tradeFees').value) || 0;

    const preview = { side: side, entry: entry, exit: exit, stop: stop, target: target, qty: qty, fees: fees };
    const pnl = store.tradePnl(preview);
    const r = store.tradeR(preview);
    const rr = store.plannedRR(preview);

    const pnlEl = $('#previewPnl');
    if (exit === null) {
      pnlEl.textContent = entry !== null && qty !== null ? 'Открыта' : '—';
      pnlEl.className = exit === null && entry !== null && qty !== null ? 'neutral' : '';
    } else if (pnl !== null) {
      pnlEl.textContent = U.money(pnl, { sign: true });
      pnlEl.className = toneClass(pnl);
    } else {
      pnlEl.textContent = '—';
      pnlEl.className = '';
    }

    const rEl = $('#previewR');
    rEl.textContent = r !== null ? U.rfmt(r, { sign: true }) : '—';
    rEl.className = r !== null ? toneClass(r) : '';

    $('#previewRR').textContent = rr !== null ? '1 : ' + rr.toFixed(2).replace('.', ',') : '—';
    $('#previewRR').className = '';
  }

  function saveTrade(event) {
    event.preventDefault();
    const date = $('#tradeDate').value;
    const symbol = $('#tradeSymbol').value.trim().toUpperCase();
    const entry = U.parseNum($('#tradeEntry').value);
    const qty = U.parseNum($('#tradeQty').value);
    const exitRaw = $('#tradeExit').value.trim();
    const stopRaw = $('#tradeStop').value.trim();
    const currentStopRaw = $('#tradeCurrentStop').value.trim();
    const targetRaw = $('#tradeTarget').value.trim();
    const exit = exitRaw === '' ? null : U.parseNum(exitRaw);
    const stop = stopRaw === '' ? null : U.parseNum(stopRaw);
    const currentStop = currentStopRaw === '' ? null : U.parseNum(currentStopRaw);
    const target = targetRaw === '' ? null : U.parseNum(targetRaw);
    const fees = U.parseNum($('#tradeFees').value) || 0;
    const side = $('#tradeSide').value === 'short' ? 'short' : 'long';

    let error = '';
    if (!date) error = 'Укажите дату сделки.';
    else if (!symbol) error = 'Укажите инструмент (например, EURUSD).';
    else if (entry === null) error = 'Укажите цену входа.';
    else if (qty === null || qty <= 0) error = 'Количество должно быть больше нуля.';
    else if (fees < 0) error = 'Комиссия не может быть отрицательной.';
    else if (stop !== null && Math.abs(stop - entry) < 1e-12) error = 'Стоп при входе не может совпадать с ценой входа.';
    else if (stop !== null && side === 'long' && stop > entry) error = 'Для Long стоп при входе должен быть ниже цены входа.';
    else if (stop !== null && side === 'short' && stop < entry) error = 'Для Short стоп при входе должен быть выше цены входа.';
    else if (target !== null && side === 'long' && target <= entry) error = 'Для Long тейк-профит должен быть выше цены входа.';
    else if (target !== null && side === 'short' && target >= entry) error = 'Для Short тейк-профит должен быть ниже цены входа.';

    if (error) {
      $('#tradeError').hidden = false;
      $('#tradeError').textContent = error;
      return;
    }

    const existing = state.tradeId ? store.state.trades.find(function (t) { return t.id === state.tradeId; }) : null;
    const trade = {
      id: existing ? existing.id : U.uid(),
      date: date,
      time: $('#tradeTime').value,
      symbol: symbol,
      side: side,
      entry: entry,
      exit: exit,
      stop: stop,
      currentStop: currentStop,
      target: target,
      qty: qty,
      fees: fees,
      setup: $('#tradeSetup').value.trim(),
      emotion: $('#tradeEmotion').value,
      discipline: Number($('#tradeDiscipline').value) || 0,
      tags: splitTags($('#tradeTags').value),
      notes: $('#tradeNotes').value.trim(),
      screenshot: state.screenshot
    };

    if (existing) {
      const index = store.state.trades.findIndex(function (t) { return t.id === existing.id; });
      if (index !== -1) store.state.trades[index] = trade;
    } else {
      store.state.trades.push(trade);
      state.tradeId = trade.id;
      $('#tradeModalTitle').textContent = 'Редактировать сделку';
      $('#deleteTradeBtn').classList.remove('hidden');
      $('#saveTradeBtn').textContent = 'Сохранить изменения';
    }

    store.state.demo = false;
    const ok = persist();
    if (!ok) {
      $('#tradeError').hidden = false;
      $('#tradeError').textContent = 'Сделка добавлена в текущую сессию, но сохранить её не удалось. Проверьте свободное место и папку данных, затем попробуйте ещё раз.';
      return;
    }
    closeModal('tradeModal');
    renderAll();
    toast(existing ? 'Сделка обновлена' : 'Сделка добавлена');
  }

  function deleteTrade() {
    if (!state.tradeId) return;
    const trade = store.state.trades.find(function (t) { return t.id === state.tradeId; });
    if (!trade) return;
    askConfirm({
      title: 'Удалить сделку?',
      text: 'Сделка ' + trade.symbol + ' от ' + U.formatDate(trade.date, 'long') + ' будет удалена. Сразу после удаления действие можно будет отменить.',
      okLabel: 'Удалить'
    }).then(function (confirmed) {
      if (!confirmed) return;
      const index = store.state.trades.findIndex(function (t) { return t.id === trade.id; });
      store.state.trades = store.state.trades.filter(function (t) { return t.id !== trade.id; });
      const ok = persist();
      if (!ok) {
        store.state.trades.splice(Math.max(0, index), 0, trade);
        renderAll();
        toast('Не удалось удалить сделку: данные не сохранены.', 'error');
        return;
      }
      closeModal('tradeModal');
      renderAll();
      toast('Сделка удалена', 'success', {
        label: 'Отменить',
        onClick: function () {
          if (!store.state.trades.some(function (t) { return t.id === trade.id; })) {
            store.state.trades.splice(Math.min(Math.max(0, index), store.state.trades.length), 0, trade);
          }
          const restored = persist();
          renderAll();
          toast(restored ? 'Сделка восстановлена' : 'Сделка восстановлена только в текущей сессии', restored ? 'success' : 'error');
        }
      });
    });
  }

  /* ============================================================
     Note modal
     ============================================================ */

  function buildMoodPicker() {
    $('#moodPicker').innerHTML = Object.keys(NS.MOODS).map(function (key) {
      const mood = NS.MOODS[key];
      return '<button type="button" class="mood-btn" data-mood="' + key + '" style="--mood-color:' + mood.color + '">' +
        '<span class="m-emoji">' + mood.emoji + '</span>' + U.escapeHtml(mood.label) + '</button>';
    }).join('');
    setNoteMood('neutral');
  }

  function setNoteMood(mood) {
    state.noteMood = NS.MOODS[mood] ? mood : 'neutral';
    $('#noteMood').value = state.noteMood;
    $$('#moodPicker .mood-btn').forEach(function (button) {
      button.classList.toggle('active', button.dataset.mood === state.noteMood);
    });
  }

  function openNoteModal(id, presetDate) {
    const note = id ? store.state.notes.find(function (n) { return n.id === id; }) : null;
    state.noteId = note ? note.id : null;
    $('#noteModalTitle').textContent = note ? 'Редактировать запись' : 'Новая запись';
    $('#noteDate').value = note ? note.date : (presetDate || U.todayISO());
    $('#noteTitle').value = note ? (note.title || '') : '';
    $('#noteText').value = note ? note.text : '';
    $('#noteTags').value = note ? note.tags.join(', ') : '';
    setNoteMood(note ? note.mood : 'neutral');
    $('#noteError').hidden = true;
    $('#deleteNoteBtn').classList.toggle('hidden', !note);
    $('#saveNoteBtn').textContent = note ? 'Сохранить изменения' : 'Сохранить запись';
    openModal('noteModal', '#noteText');
  }

  function saveNote(event) {
    event.preventDefault();
    const date = $('#noteDate').value;
    const text = $('#noteText').value.trim();
    let error = '';
    if (!date) error = 'Укажите дату.';
    else if (!text) error = 'Запись не может быть пустой.';
    if (error) {
      $('#noteError').hidden = false;
      $('#noteError').textContent = error;
      return;
    }

    const existing = state.noteId ? store.state.notes.find(function (n) { return n.id === state.noteId; }) : null;
    const note = {
      id: existing ? existing.id : U.uid(),
      date: date,
      mood: state.noteMood,
      title: $('#noteTitle').value.trim(),
      text: text,
      tags: splitTags($('#noteTags').value),
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };

    if (existing) {
      const index = store.state.notes.findIndex(function (n) { return n.id === existing.id; });
      if (index !== -1) store.state.notes[index] = note;
    } else {
      store.state.notes.push(note);
      state.noteId = note.id;
      $('#noteModalTitle').textContent = 'Редактировать запись';
      $('#deleteNoteBtn').classList.remove('hidden');
      $('#saveNoteBtn').textContent = 'Сохранить изменения';
    }

    store.state.demo = false;
    const ok = persist();
    if (!ok) {
      $('#noteError').hidden = false;
      $('#noteError').textContent = 'Запись сохранена в текущей сессии, но сохранить её не удалось. Проверьте свободное место и папку данных.';
      return;
    }
    closeModal('noteModal');
    renderAll();
    toast(existing ? 'Запись обновлена' : 'Запись добавлена');
  }

  function deleteNote(id) {
    const note = store.state.notes.find(function (n) { return n.id === id; });
    if (!note) return;
    askConfirm({
      title: 'Удалить запись?',
      text: 'Запись от ' + U.formatDate(note.date, 'long') + ' будет удалена. Сразу после удаления действие можно будет отменить.',
      okLabel: 'Удалить'
    }).then(function (confirmed) {
      if (!confirmed) return;
      const index = store.state.notes.findIndex(function (n) { return n.id === id; });
      store.state.notes = store.state.notes.filter(function (n) { return n.id !== id; });
      const ok = persist();
      if (!ok) {
        store.state.notes.splice(Math.max(0, index), 0, note);
        renderAll();
        toast('Не удалось удалить запись: данные не сохранены.', 'error');
        return;
      }
      if (state.noteId === id) {
        state.noteId = null;
        closeModal('noteModal');
      }
      renderAll();
      toast('Запись удалена', 'success', {
        label: 'Отменить',
        onClick: function () {
          if (!store.state.notes.some(function (n) { return n.id === note.id; })) {
            store.state.notes.splice(Math.min(Math.max(0, index), store.state.notes.length), 0, note);
          }
          const restored = persist();
          renderAll();
          toast(restored ? 'Запись восстановлена' : 'Запись восстановлена только в текущей сессии', restored ? 'success' : 'error');
        }
      });
    });
  }

  /* ============================================================
     Modals & confirm
     ============================================================ */

  function anyModalOpen() {
    return $$('.modal').some(function (modal) { return !modal.hidden; });
  }

  function syncModalClass() {
    document.body.classList.toggle('modal-open', anyModalOpen());
  }

  function openModal(id, focusSelector) {
    const modal = document.getElementById(id);
    if (!modal) return;
    state.lastFocus = document.activeElement;
    modal.hidden = false;
    syncModalClass();
    setTimeout(function () {
      const target = focusSelector ? $(focusSelector, modal) : null;
      if (target) target.focus();
    }, 40);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (id === 'confirmModal' && state.confirmResolver) {
      const resolve = state.confirmResolver;
      state.confirmResolver = null;
      resolve(false);
    }
    syncModalClass();
    if (state.lastFocus && document.contains(state.lastFocus) && !anyModalOpen()) {
      try { state.lastFocus.focus(); } catch (err) { /* ignore */ }
    }
  }

  function askConfirm(options) {
    options = options || {};
    return new Promise(function (resolve) {
      if (state.confirmResolver) {
        const previous = state.confirmResolver;
        state.confirmResolver = null;
        previous(false);
      }
      state.confirmResolver = resolve;
      $('#confirmTitle').textContent = options.title || 'Подтвердите действие';
      $('#confirmText').textContent = options.text || '';
      $('#confirmOk').textContent = options.okLabel || 'Подтвердить';
      $('#confirmOk').className = 'btn ' + (options.danger === false ? 'btn-primary' : 'btn-danger');
      openModal('confirmModal');
      setTimeout(function () { $('#confirmCancel').focus(); }, 40);
    });
  }

  function resolveConfirm(value) {
    const resolve = state.confirmResolver;
    state.confirmResolver = null;
    closeModal('confirmModal');
    if (resolve) resolve(value);
  }

  /* ============================================================
     Events
     ============================================================ */

  function bindEvents() {
    document.addEventListener('click', handleGlobalClick);
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('hashchange', function () {
      const view = String(location.hash || '').replace('#', '');
      if (VIEW_META[view] && view !== state.view) navigate(view, { push: false });
    });
    window.addEventListener('resize', U.debounce(function () {
      if (state.view === 'dashboard') renderDashboard();
    }, 220));

    $('#newTradeBtn').addEventListener('click', function () { openTradeModal(); });
    $('#newNoteBtn').addEventListener('click', function () { openNoteModal(); });
    $('#emptyNewTrade').addEventListener('click', function () { openTradeModal(); });
    $('#emptyDemo').addEventListener('click', loadDemoData);
    $('#menuBtn').addEventListener('click', openSidebar);
    $('#sidebarOverlay').addEventListener('click', closeSidebar);
    $('#avatarBtn').addEventListener('click', function () { navigate('settings'); });
    $('#periodSelect').addEventListener('change', function (event) {
      state.period = event.target.value;
      renderCurrentView();
    });

    $('#keepDemoBtn').addEventListener('click', function () {
      store.state.demo = false;
      persist();
      renderDashboard();
      renderSidebar();
      toast('Демо-режим отключён, данные остались в журнале');
    });
    $('#clearDemoBtn').addEventListener('click', function () {
      askConfirm({
        title: 'Начать с чистого листа?',
        text: 'Демо-сделки и записи будут удалены. Настройки профиля сохранятся.',
        okLabel: 'Очистить демо'
      }).then(function (confirmed) {
        if (!confirmed) return;
        store.resetData(true);
        state.calCursor = monthStart(new Date());
        state.selectedDay = U.todayISO();
        renderAll();
        toast('Демо-данные удалены. Добро пожаловать в собственный журнал!');
      });
    });

    $('#tradeSearch').addEventListener('input', U.debounce(function (event) {
      state.filters.search = event.target.value.trim().toLowerCase();
      renderTrades();
    }, 160));
    $('#filterSide').addEventListener('change', function (event) { state.filters.side = event.target.value; renderTrades(); });
    $('#filterResult').addEventListener('change', function (event) { state.filters.result = event.target.value; renderTrades(); });
    $('#filterSetup').addEventListener('change', function (event) { state.filters.setup = event.target.value; renderTrades(); });
    $('#clearFilters').addEventListener('click', resetFilters);
    $('#tradesTable').querySelector('thead').addEventListener('click', function (event) {
      const th = event.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else { state.sort.key = key; state.sort.dir = 'desc'; }
      renderTrades();
    });
    $('#tradesTbody').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('tr[data-open-trade]');
      if (row) { event.preventDefault(); openTradeModal(row.dataset.openTrade); }
    });
    $('#recentTrades').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('[data-open-trade]');
      if (row) { event.preventDefault(); openTradeModal(row.dataset.openTrade); }
    });
    $('#dayCard').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('[data-open-trade]');
      if (row) { event.preventDefault(); openTradeModal(row.dataset.openTrade); }
    });
    $('#exportCsvBtn').addEventListener('click', exportCSV);
    $('#exportCsvBtn2').addEventListener('click', exportCSV);

    $('#calPrev').addEventListener('click', function () { changeMonth(-1); });
    $('#calNext').addEventListener('click', function () { changeMonth(1); });
    $('#calToday').addEventListener('click', function () {
      state.calCursor = monthStart(new Date());
      state.selectedDay = U.todayISO();
      renderCalendar();
    });

    $('#calcForm').addEventListener('input', calcUpdate);
    $('#calcReset').addEventListener('click', resetCalculator);

    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#exportJsonBtn').addEventListener('click', exportJSON);
    $('#importJsonBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      importJSONFile(file);
      event.target.value = '';
    });
    $('#loadDemoBtn').addEventListener('click', loadDemoData);
    $('#resetAllBtn').addEventListener('click', resetJournalData);

    $('#sideSegmented').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-side]');
      if (button) setSide(button.dataset.side);
    });
    $('#disciplineStars').addEventListener('click', function (event) {
      const star = event.target.closest('.star');
      if (!star) return;
      const value = Number(star.dataset.star);
      const current = Number($('#tradeDiscipline').value) || 0;
      setDiscipline(current === value ? 0 : value);
    });
    $('#tradeShot').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      compressScreenshot(file);
      event.target.value = '';
    });
    $('#removeShot').addEventListener('click', function () {
      state.screenshot = '';
      renderShotPreview();
    });
    $('#tradeForm').addEventListener('input', updateTradePreview);
    $('#tradeForm').addEventListener('submit', saveTrade);
    $('#deleteTradeBtn').addEventListener('click', deleteTrade);

    $('#moodPicker').addEventListener('click', function (event) {
      const button = event.target.closest('.mood-btn');
      if (button) setNoteMood(button.dataset.mood);
    });
    $('#noteForm').addEventListener('submit', saveNote);
    $('#deleteNoteBtn').addEventListener('click', function () {
      if (state.noteId) deleteNote(state.noteId);
    });

    $('#confirmOk').addEventListener('click', function () { resolveConfirm(true); });
    $('#confirmCancel').addEventListener('click', function () { resolveConfirm(false); });
  }

  function handleGlobalClick(event) {
    const closeEl = event.target.closest('[data-close]');
    if (closeEl) {
      closeModal(closeEl.dataset.close);
      return;
    }

    const navEl = event.target.closest('.nav-item[data-view]');
    if (navEl) {
      event.preventDefault();
      navigate(navEl.dataset.view);
      return;
    }

    const gotoEl = event.target.closest('[data-goto]');
    if (gotoEl) {
      event.preventDefault();
      navigate(gotoEl.dataset.goto);
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === 'new-trade') { openTradeModal(null, actionEl.dataset.date); return; }
      if (action === 'new-note') { openNoteModal(null, actionEl.dataset.date); return; }
    }

    const openTradeEl = event.target.closest('[data-open-trade]');
    if (openTradeEl) {
      openTradeModal(openTradeEl.dataset.openTrade);
      return;
    }

    const editNoteEl = event.target.closest('[data-edit-note]');
    if (editNoteEl) {
      openNoteModal(editNoteEl.dataset.editNote);
      return;
    }

    const deleteNoteEl = event.target.closest('[data-delete-note]');
    if (deleteNoteEl) {
      deleteNote(deleteNoteEl.dataset.deleteNote);
      return;
    }

    const calDay = event.target.closest('.cal-day[data-date]');
    if (calDay) {
      const iso = calDay.dataset.date;
      const date = U.parseISO(iso);
      if (!date) return;
      state.selectedDay = iso;
      if (date.getFullYear() !== state.calCursor.getFullYear() || date.getMonth() !== state.calCursor.getMonth()) {
        state.calCursor = monthStart(date);
      }
      renderCalendar();
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      const open = $$('.modal').filter(function (modal) { return !modal.hidden; });
      if (open.length) {
        closeModal(open[open.length - 1].id);
        return;
      }
      closeSidebar();
      return;
    }

    if (isTyping(event.target) || anyModalOpen()) return;

    if (event.key === 'n' || event.key === 'N' || event.key === 'т' || event.key === 'Т') {
      event.preventDefault();
      openTradeModal();
      return;
    }

    if (event.key === '/' && state.view === 'trades') {
      event.preventDefault();
      $('#tradeSearch').focus();
    }
  }

  function isTyping(element) {
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
  }

  function openSidebar() {
    document.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
  }

  /* ============================================================
     Start
     ============================================================ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
