(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const store = NS.store;
  const desktop = window.tradeJournalDesktop || null;
  const APP_VERSION = '2.4.0';
  const DRAFT_PREFIX = 'tradejournal.draft.v1.';
  const META_KEY = store.META_KEY;
  // Drafts live in localStorage even on desktop, so a full screenshot data URL
  // must not be duplicated there. Keep the draft small; the screenshot stays in
  // the trade itself or in a file reference on desktop.
  const DRAFT_MAX_CHARS = 1000000;
  // Screenshots keep their detail: desktop stores lossless PNG when it stays
  // reasonable in size, otherwise high-quality WebP. The web version uses the
  // same WebP quality but caps the size so localStorage stays usable.
  const SHOT_MAX_SIDE_DESKTOP = 2560;
  const SHOT_MAX_SIDE_WEB = 1920;
  const SHOT_MAX_CHARS_DESKTOP = 7200000;
  const SHOT_MAX_CHARS_WEB = 2800000;
  const SHOT_PNG_MAX_CHARS_DESKTOP = 2000000;
  const SHOT_LOSSY_QUALITY = 0.92;

  const $ = function (selector, root) { return (root || document).querySelector(selector); };
  const $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  const T = function (text) { return NS.i18n && NS.i18n.t ? NS.i18n.t(text) : text; };

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
    page: 1,
    pageSize: 25,
    calCursor: monthStart(new Date()),
    selectedDay: U.todayISO(),
    tradeId: null,
    tradeOriginalId: null,
    tradeAccountId: null,
    tradeBaseline: null,
    tradeBaselineScreenshot: '',
    tradeExits: [],
    csvImport: null,
    tradeDirty: false,
    tradeSaving: false,
    tradeInitializing: false,
    tradeDraftTimer: null,
    draftQuotaWarned: false,
    draftShotWarned: false,
    draftScreenshotOmitted: false,
    noteId: null,
    screenshot: '',
    screenshotPreview: '',
    screenshotBusy: false,
    shotFocus: null,
    noteMood: 'neutral',
    profileAvatarDraft: '',
    accountModalMode: 'create',
    confirmResolver: null,
    lastFocus: null,
    storageHealthData: null,
    storageHealthScanning: false,
    storageHealthCleaning: false,
    backupReminderShown: false
  };

  const EMOTION_OPTIONS = NS.EMOTIONS;

  /* ============================================================
     Init
     ============================================================ */

  async function init() {
    const hadStored = await store.hasStored();
    if (hadStored) {
      if (!(await store.load())) {
        showRecoveryScreen(await store.getRaw());
        return;
      }
      const migratedShots = await store.migrateScreenshots();
      if (migratedShots) console.info('TradeJournal: скриншоты перенесены в отдельное хранилище:', migratedShots);
      if (store.needsMigration) await store.save();
    } else {
      const demoOk = await store.setDemo(NS.sample.generate());
      if (!demoOk) toast('Не удалось сохранить демо-данные. Проверьте папку данных.', 'error');
    }
    if (!desktop) {
      store.gcScreenshots();
    }
    applyCurrency();
    setVersionLabel(APP_VERSION);
    state.selectedDay = todayInAccount();
    buildMoodPicker();
    buildEmotionSelect();
    refreshDatalists();
    bindEvents();
    initDesktopUi();
    if (NS.pwa && typeof NS.pwa.init === 'function') {
      NS.pwa.init({ onUpdate: showPwaUpdateBanner });
    }

    const hashView = String(location.hash || '').replace('#', '');
    const initialView = VIEW_META[hashView] ? hashView : 'dashboard';
    navigate(initialView, { push: false, scroll: false });
    maybeRemindBackup();
  }

  function setVersionLabel(version) {
    const label = $('#appVersion');
    if (label) label.textContent = 'v' + (version || APP_VERSION);
  }

  function setDesktopVersionLabel(version) {
    const label = $('#desktopVersion');
    if (label) label.textContent = 'v' + (version || APP_VERSION);
  }

  function showUpdateBanner(title, text, actionLabel) {
    const banner = $('#updateBanner');
    if (!banner) return;
    $('#updateBannerTitle').textContent = title;
    $('#updateBannerText').textContent = text;
    $('#installUpdateBtn').textContent = actionLabel || 'Обновить';
    $('#installUpdateBtn').disabled = false;
    banner.hidden = false;
  }

  function showPwaUpdateBanner() {
    showUpdateBanner(
      'Доступно обновление',
      'Новая версия TradeJournal загружена. Обновите страницу, чтобы применить изменения.',
      'Обновить'
    );
  }

  function setDesktopUpdateStatus(text, tone) {
    const el = $('#updateStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'muted small' + (tone ? ' ' + tone : '');
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
        '<div class="recovery-restore" id="recoveryRestore" hidden>' +
          '<h2>Восстановить журнал</h2>' +
          '<p class="recovery-hint">Можно вернуть предыдущую версию или одну из резервных копий. Повреждённый файл сначала скачайте кнопкой выше — после замены он не сохраняется.</p>' +
          '<div class="recovery-restore-row">' +
            '<select id="recoveryBackupSelect" aria-label="Резервная копия" disabled></select>' +
            '<button type="button" class="btn btn-primary" id="recoveryRestoreBackup" disabled>Восстановить копию</button>' +
          '</div>' +
          '<div class="recovery-actions">' +
            '<button type="button" class="btn btn-ghost" id="recoveryRestorePrevious">Вернуть предыдущую версию</button>' +
            '<button type="button" class="btn btn-ghost" id="recoveryOpenFolder">Открыть папку данных</button>' +
          '</div>' +
          '<p class="recovery-status" id="recoveryStatus" role="status"></p>' +
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
    $('#recoveryReset').addEventListener('click', async function () {
      if (!window.confirm(T('Удалить повреждённые данные и загрузить демо-журнал? Убедитесь, что файл уже скачан.'))) return;
      await store.clearRaw();
      location.reload();
    });

    if (desktop) setupRecoveryRestore();
  }

  function setupRecoveryRestore() {
    const panel = $('#recoveryRestore');
    if (!panel || !desktop) return;
    panel.hidden = false;

    const select = $('#recoveryBackupSelect');
    const restoreButton = $('#recoveryRestoreBackup');
    const previousButton = $('#recoveryRestorePrevious');
    const folderButton = $('#recoveryOpenFolder');
    const status = $('#recoveryStatus');
    let busy = false;

    function setStatus(text, tone) {
      status.textContent = text || '';
      status.className = 'recovery-status' + (tone ? ' ' + tone : '');
    }

    function setBusy(value) {
      busy = value;
      [select, restoreButton, previousButton, folderButton].forEach(function (element) {
        if (element) element.disabled = value;
      });
    }

    desktop.listBackups().then(function (backups) {
      const list = Array.isArray(backups) ? backups : [];
      if (!list.length) {
        select.innerHTML = '<option value="">Резервных копий нет</option>';
        return;
      }
      select.innerHTML = list.map(function (backup) {
        const label = desktopReasonLabel(backup.reason) + ' · ' + formatBackupDate(backup.mtime) + ' · ' + U.bytes(backup.size);
        return '<option value="' + U.escapeHtml(backup.name) + '">' + U.escapeHtml(label) + '</option>';
      }).join('');
      select.disabled = false;
      restoreButton.disabled = false;
    }).catch(function (err) {
      select.innerHTML = '<option value="">Не удалось прочитать копии</option>';
      setStatus(err && err.message ? err.message : 'Не удалось прочитать список резервных копий.', 'error');
    });

    restoreButton.addEventListener('click', function () {
      if (busy) return;
      const name = select.value;
      if (!name) return;
      if (!window.confirm(T('Восстановить выбранную резервную копию? Повреждённый текущий файл будет заменён.'))) return;
      setBusy(true);
      setStatus('Восстанавливаем резервную копию…');
      desktop.restoreBackup(name).then(function () {
        setStatus('Копия восстановлена. Перезапускаем приложение…', 'success');
        setTimeout(function () { location.reload(); }, 500);
      }).catch(function (err) {
        setBusy(false);
        setStatus(err && err.message ? err.message : 'Не удалось восстановить копию.', 'error');
      });
    });

    previousButton.addEventListener('click', function () {
      if (busy) return;
      if (!window.confirm(T('Вернуть предыдущую версию журнала? Повреждённый текущий файл будет заменён.'))) return;
      setBusy(true);
      setStatus('Восстанавливаем предыдущую версию…');
      desktop.restorePrevious().then(function () {
        setStatus('Предыдущая версия восстановлена. Перезапускаем приложение…', 'success');
        setTimeout(function () { location.reload(); }, 500);
      }).catch(function (err) {
        setBusy(false);
        setStatus(err && err.message ? err.message : 'Не удалось восстановить предыдущую версию.', 'error');
      });
    });

    folderButton.addEventListener('click', function () {
      desktop.openDataFolder().catch(function (err) {
        setStatus(err && err.message ? err.message : 'Не удалось открыть папку данных.', 'error');
      });
    });
  }

  function applyCurrency() {
    NS.config.currency = (store.state.settings.currency || '$').slice(0, 3);
  }

  function accountTimeZone() {
    return store.state.settings.timezone || U.systemTimeZone();
  }

  function todayInAccount() {
    return U.todayISO(accountTimeZone());
  }

  function monthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function decimal(value, digits) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return new Intl.NumberFormat(U.locale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(num);
  }

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
    const title = T(meta.title);
    $('#pageTitle').textContent = title;
    $('#pageSubtitle').textContent = T(meta.subtitle);
    document.title = title + ' — TradeJournal';

    const showPeriod = view === 'dashboard' || view === 'analytics';
    $('#periodWrap').classList.toggle('hidden', !showPeriod);

    if (options.push !== false && location.hash !== '#' + view) {
      try { location.hash = view; } catch (err) { /* ignore */ }
    }

    if (view === 'calculator') ensureCalcDefaults();
    if (view === 'calendar') {
      state.calCursor = monthStart(state.calCursor || new Date());
      if (!state.selectedDay) state.selectedDay = todayInAccount();
    }

    renderCurrentView();
    if (desktop && view === 'settings' && !state.storageHealthScanning) {
      scanStorageHealth(false);
    }
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

    const today = todayInAccount();
    const todayInfo = store.dayPnlMap(store.state.trades).get(today);
    const todayPnl = todayInfo ? todayInfo.pnl : 0;
    const todayEl = $('#sidebarToday');
    todayEl.innerHTML = T('сегодня') + ' <b class="' + toneClass(todayPnl) + '">' + U.escapeHtml(U.money(todayPnl, { sign: true })) + '</b>';

    $('#navTradesCount').textContent = store.state.trades.length;

    renderAvatar();
    renderSidebarAccounts();
  }

  function initialsOf(name) {
    const text = String(name || '').trim();
    return text
      ? text.split(/\s+/).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('')
      : 'TJ';
  }

  function renderAvatar() {
    const profile = store.state.profile || {};
    const name = (profile.name || '').trim();
    const image = $('#avatarImage');
    const initials = $('#avatarInitials');
    if (image && initials) {
      if (profile.avatar) {
        image.src = profile.avatar;
        image.hidden = false;
        initials.hidden = true;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
        initials.hidden = false;
        initials.textContent = initialsOf(name);
      }
    }
    const button = $('#avatarBtn');
    if (button) {
      button.setAttribute('data-i18n-skip', '');
      button.title = name ? name + ' — ' + T('Профиль и настройки') : T('Профиль и настройки');
    }
  }

  function renderSidebarAccounts() {
    const select = $('#sidebarAccountSelect');
    if (!select) return;
    select.innerHTML = store.state.accounts.map(function (account) {
      return '<option data-i18n-skip value="' + U.escapeHtml(account.id) + '">' + U.escapeHtml(account.name) + '</option>';
    }).join('');
    select.value = store.state.activeAccountId;
  }

  function toneClass(value) {
    if (value > 0.004) return 'pos';
    if (value < -0.004) return 'neg';
    return 'neutral';
  }

  async function persist() {
    const ok = await store.save();
    if (!ok) {
      toast(desktop
        ? 'Не удалось сохранить файл журнала. Проверьте свободное место и папку данных.'
        : 'Не удалось сохранить: хранилище браузера заполнено. Удалите скриншоты или экспортируйте журнал.',
      'error');
    }
    return ok;
  }

  function toast(message, type, action, options) {
    options = options || {};
    const text = options.skip ? message : T(message);
    const box = document.createElement('div');
    box.className = 'toast ' + (type || 'success');
    box.innerHTML = '<span class="toast-dot"></span><span class="toast-message"' + (options.skip ? ' data-i18n-skip' : '') + '>' + U.escapeHtml(text) + '</span>' +
      (action && action.label ? '<button type="button" class="toast-action">' + U.escapeHtml(T(action.label)) + '</button>' : '');
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

  function pluralScreenshots(n) {
    return U.plural(n, ['скриншот', 'скриншота', 'скриншотов']);
  }

  /* ============================================================
     Periods
     ============================================================ */

  function currentRange() {
    const today = todayInAccount();
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
    const closedAll = store.sortTrades(store.state.trades.filter(store.hasRealized), 'asc');
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

    $('#todayDate').textContent = U.capitalize(U.formatDate(todayInAccount(), 'full'));
  }

  function renderKpis(m, base) {
    const roi = base > 0 ? (m.net / base) * 100 : 0;
    const pf = m.profitFactor === Infinity ? '∞' : decimal(m.profitFactor, 2);
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
        label: 'Макс. просадка, $',
        value: m.count ? U.money(m.maxDD) : '—',
        tone: m.maxDD > 0.004 ? 'neg' : '',
        sub: m.count ? 'Макс. просадка, %: ' + U.percent(m.maxDDPct, 1) + ' от пика счёта' : 'Пока без просадок'
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

  function orderedPnlEvents(trades) {
    const events = [];
    (trades || []).forEach(function (trade) {
      store.tradePnlEvents(trade).forEach(function (event, index) {
        events.push({
          date: event.date || trade.date || '',
          time: trade.time || '00:00',
          tradeId: trade.id || '',
          exitId: event.exitId || '',
          index: index,
          pnl: event.pnl,
          trade: trade
        });
      });
    });
    events.sort(function (a, b) {
      return (a.date || '').localeCompare(b.date || '') ||
        (a.time || '').localeCompare(b.time || '') ||
        (a.tradeId || '').localeCompare(b.tradeId || '') ||
        (a.exitId || '').localeCompare(b.exitId || '') ||
        a.index - b.index;
    });
    return events;
  }

  function buildEquityPoints(closedAsc, base) {
    let balance = base;
    const points = [{ label: 'Старт', value: balance, meta: 'Начало периода' }];
    orderedPnlEvents(closedAsc).forEach(function (event) {
      balance += event.pnl;
      points.push({
        label: event.date,
        value: balance,
        meta: event.trade.symbol + ' · ' + U.money(event.pnl, { sign: true })
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
    (trades || []).forEach(function (trade) {
      store.tradePnlEvents(trade).forEach(function (event) {
        if (!event.date) return;
        let item = map.get(event.date);
        if (!item) { item = { value: 0, count: 0, trades: new Set() }; map.set(event.date, item); }
        item.value += event.pnl;
        if (!item.trades.has(trade.id)) { item.trades.add(trade.id); item.count++; }
      });
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

  function disciplineSnapshot() {
    const settings = store.state.settings;
    const today = todayInAccount();
    const todayTrades = store.state.trades.filter(function (trade) { return trade.date === today; });
    const todayInfo = store.dayPnlMap(store.state.trades).get(today);
    const dayPnl = todayInfo ? todayInfo.pnl : 0;

    const balance = store.balanceAll();
    const startOfDayBalance = Math.max(0, balance - dayPnl);
    const lossLimit = Math.max(0, (U.parseNum(settings.dailyLossLimit) || 0) / 100 * startOfDayBalance);
    const maxTrades = U.parseNum(settings.maxTradesPerDay) || 0;
    return {
      todayTrades: todayTrades,
      dayPnl: dayPnl,
      startOfDayBalance: startOfDayBalance,
      lossLimit: lossLimit,
      maxTrades: maxTrades
    };
  }

  function dailyLimitWarning(date) {
    if (date !== todayInAccount()) return null;
    const snapshot = disciplineSnapshot();
    const messages = [];
    let title = 'Дневной лимит превышен';

    if (snapshot.lossLimit > 0 && snapshot.dayPnl <= -snapshot.lossLimit) {
      title = 'Дневной лимит убытка достигнут';
      messages.push('Убыток за сегодня: ' + U.money(-snapshot.dayPnl) + ' при лимите ' + U.money(snapshot.lossLimit) + '.');
    }
    if (snapshot.maxTrades > 0 && snapshot.todayTrades.length >= snapshot.maxTrades) {
      if (messages.length) title = 'Дневные лимиты превышены';
      else title = 'Лимит сделок на день достигнут';
      messages.push('Сегодня уже ' + snapshot.todayTrades.length + ' ' + pluralTrades(snapshot.todayTrades.length) + ' при лимите ' + snapshot.maxTrades + '.');
    }
    if (!messages.length) return null;

    return {
      title: title,
      text: messages.join(' ') + ' Добавить сделку вне плана?'
    };
  }

  function renderDiscipline() {
    const snapshot = disciplineSnapshot();
    const todayTrades = snapshot.todayTrades;
    const dayPnl = snapshot.dayPnl;
    const lossLimit = snapshot.lossLimit;
    const maxTrades = snapshot.maxTrades;
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
      ? '<div class="rule"><div class="rule-top"><span>Лимит убытка</span><b>' + U.escapeHtml(U.money(lossUsed)) + ' / ' + U.escapeHtml(U.money(lossLimit)) + '</b></div>' +
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
      const status = store.tradeStatus(trade);
      const pnl = store.tradePnl(trade);
      const r = store.tradeR(trade);
      const pnlLabel = status === 'closed'
        ? U.money(pnl, { sign: true })
        : (status === 'partial' ? U.money(pnl, { sign: true }) : 'Открыта');
      const statusLabel = status === 'closed'
        ? (r !== null ? U.rfmt(r, { sign: true }) : '—')
        : (status === 'partial' ? 'частично · остаток ' + U.qty(store.remainingQty(trade)) : 'без выхода');
      return '<div class="mini-row" data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
        '<div class="mini-icon ' + trade.side + '" data-i18n-skip>' + U.escapeHtml(trade.symbol.slice(0, 2)) + '</div>' +
        '<div class="mini-main"><strong data-i18n-skip>' + U.escapeHtml(trade.symbol) + '</strong><span>' +
        U.escapeHtml(U.formatDate(trade.date, 'med')) + (trade.time ? ' · ' + U.escapeHtml(trade.time) : '') +
        ' · ' + (trade.side === 'long' ? 'Long' : 'Short') + (trade.setup ? ' · <span data-i18n-skip>' + U.escapeHtml(trade.setup) + '</span>' : '') +
        '</span></div>' +
        '<div class="mini-pnl"><strong class="' + (status === 'open' ? '' : toneClass(pnl)) + '">' +
        U.escapeHtml(pnlLabel) + '</strong><span>' + U.escapeHtml(statusLabel) +
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
      return '<div class="hb-row"><div class="hb-top"><span class="hb-label"><span data-i18n-skip>' + U.escapeHtml(group.key) + '</span>' +
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
        const status = store.tradeStatus(trade);
        if (filters.result === 'open') return status === 'open';
        if (filters.result === 'partial') return status === 'partial';
        if (!store.hasRealized(trade)) return false;
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
        av = store.hasRealized(a) ? store.tradePnl(a) : null;
        bv = store.hasRealized(b) ? store.tradePnl(b) : null;
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

  let thumbHydrationToken = 0;

  function tradeRowHtml(trade) {
    const status = store.tradeStatus(trade);
    const pnl = store.tradePnl(trade);
    const r = store.tradeR(trade);
    const emotion = U.emotionMeta(trade.emotion);
    const weighted = store.weightedExit(trade);
    const remaining = store.remainingQty(trade);
    const exitHtml = status === 'open'
      ? '<span class="open-badge">Открыта</span>'
      : '<span class="exit-value">' + U.escapeHtml(U.price(weighted)) + '</span>' +
        (status === 'partial' ? '<small class="exit-remain">ост. ' + U.escapeHtml(U.qty(remaining)) + '</small>' : '');
    const pnlHtml = pnl === null
      ? '<span class="muted">—</span>'
      : '<span class="' + toneClass(pnl) + '">' + U.escapeHtml(U.money(pnl, { sign: true })) + '</span>' +
        (status === 'partial' ? '<small class="exit-remain">реализовано</small>' : '');
    const statusHtml = status === 'partial'
      ? '<span class="partial-badge">частично</span>'
      : (status === 'open' ? '<span class="open-badge">открыта</span>' : '');
    return '<tr data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
      '<td><div class="cell-date"><strong>' + U.escapeHtml(U.formatDate(trade.date, 'med')) + '</strong><span>' + U.escapeHtml(trade.time || '—') + '</span></div></td>' +
      '<td><div class="symbol-cell"><div class="symbol-main">' +
      '<button type="button" class="symbol-thumb' + (trade.screenshot ? ' has-shot' : '') + '"' +
      (trade.screenshot ? ' data-open-shot="' + U.escapeHtml(trade.id) + '" title="Открыть скриншот"' : ' tabindex="-1" aria-hidden="true"') + '>' +
      '<span class="thumb-empty"></span></button>' +
      '<div class="symbol-line"><strong data-i18n-skip>' + U.escapeHtml(trade.symbol) + '</strong></div></div>' +
      '<span class="side-badge ' + trade.side + '"><span class="arr">' + (trade.side === 'long' ? '↑' : '↓') + '</span>' + (trade.side === 'long' ? 'Long' : 'Short') + '</span>' +
      statusHtml + '</div></td>' +
      '<td class="num">' + U.escapeHtml(U.price(trade.entry)) + '</td>' +
      '<td class="num exit-cell">' + exitHtml + '</td>' +
      '<td class="num pnl-cell">' + pnlHtml + '</td>' +
      '<td class="num ' + (r !== null ? toneClass(r) : '') + '">' + (r !== null ? U.escapeHtml(U.rfmt(r, { sign: true })) : '—') + '</td>' +
      '<td>' + (trade.setup ? '<span class="setup-chip" data-i18n-skip title="' + U.escapeHtml(trade.setup) + '">' + U.escapeHtml(trade.setup) + '</span>' : '<span class="muted">—</span>') + '</td>' +
      '<td><span class="emotion-cell" title="' + U.escapeHtml(emotion.label) + '">' + U.escapeHtml(emotion.emoji) + ' <span class="muted" style="font-size:10px">' + U.escapeHtml(emotion.label) + '</span></span></td>' +
      '<td style="text-align:right"><span class="row-chevron">›</span></td>' +
      '</tr>';
  }

  function hydrateTradeThumbnails(trades) {
    const token = ++thumbHydrationToken;
    const byId = new Map(trades.map(function (trade) { return [trade.id, trade]; }));
    $$('#tradesTbody [data-open-shot]').forEach(function (button) {
      const trade = byId.get(button.dataset.openShot);
      if (!trade || !trade.screenshot) return;
      store.screenshotSource(trade.screenshot).then(function (source) {
        if (token !== thumbHydrationToken || !source || !document.contains(button)) return;
        const image = document.createElement('img');
        image.src = source;
        image.alt = '';
        image.loading = 'lazy';
        button.innerHTML = '';
        button.appendChild(image);
      }).catch(function () { /* the placeholder stays */ });
    });
  }

  function pagerHtml(page, totalPages) {
    if (totalPages <= 1) return '';
    const parts = ['<button type="button" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Предыдущая страница">‹</button>'];
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    if (start > 1) {
      parts.push('<button type="button" data-page="1">1</button>');
      if (start > 2) parts.push('<span class="pager-info">…</span>');
    }
    for (let i = start; i <= end; i++) {
      parts.push('<button type="button" data-page="' + i + '"' + (i === page ? ' class="active" aria-current="page"' : '') + '>' + i + '</button>');
    }
    if (end < totalPages) {
      if (end < totalPages - 1) parts.push('<span class="pager-info">…</span>');
      parts.push('<button type="button" data-page="' + totalPages + '">' + totalPages + '</button>');
    }
    parts.push('<button type="button" data-page="' + (page + 1) + '"' + (page >= totalPages ? ' disabled' : '') + ' aria-label="Следующая страница">›</button>');
    return '<div class="pager">' + parts.join('') + '</div>';
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
      state.page = 1;
      thumbHydrationToken++;
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

    const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));
    state.page = U.clamp(state.page || 1, 1, totalPages);
    const startIndex = (state.page - 1) * state.pageSize;
    const pageTrades = list.slice(startIndex, startIndex + state.pageSize);

    table.classList.remove('hidden');
    empty.hidden = true;
    tbody.innerHTML = pageTrades.map(tradeRowHtml).join('');
    hydrateTradeThumbnails(pageTrades);

    $('#tradesCountLabel').textContent = list.length + ' ' + pluralTrades(list.length);

    let net = 0;
    let rSum = 0;
    let rCount = 0;
    let realizedCount = 0;
    list.forEach(function (trade) {
      if (!store.hasRealized(trade)) return;
      const pnl = store.tradePnl(trade);
      const r = store.tradeR(trade);
      if (pnl !== null) { net += pnl; realizedCount++; }
      if (r !== null) { rSum += r; rCount++; }
    });

    const from = startIndex + 1;
    const to = startIndex + pageTrades.length;
    $('#tradesFooter').innerHTML = '<span>Показано <b>' + from + '–' + to + '</b> из <b>' + list.length + '</b></span>' +
      '<span class="dot-sep">·</span><span>Итого по фильтру: <b class="' + toneClass(net) + '">' + U.escapeHtml(U.money(net, { sign: true })) + '</b></span>' +
      (realizedCount !== list.length ? '<span class="dot-sep">·</span><span>с результатом: <b>' + realizedCount + '</b></span>' : '') +
      (rCount ? '<span class="dot-sep">·</span><span>Средний R: <b class="' + toneClass(rSum / rCount) + '">' + U.escapeHtml(U.rfmt(rSum / rCount, { sign: true })) + '</b></span>' : '') +
      pagerHtml(state.page, totalPages) +
      '<span class="table-foot-hint">Клик по строке — редактирование</span>';
  }

  function resetFilters() {
    state.filters = { search: '', side: 'all', result: 'all', setup: 'all' };
    state.page = 1;
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

    const dayMap = store.dayPnlMap(store.state.trades);
    const monthTrades = store.state.trades.filter(function (trade) {
      return store.tradePnlEvents(trade).some(function (event) {
        return (event.date || '').slice(0, 7) === prefix;
      });
    });
    const closedMonth = monthTrades.filter(store.hasRealized);
    const monthKeys = Array.from(dayMap.keys()).filter(function (key) {
      return key.slice(0, 7) === prefix;
    });
    const monthPnl = monthKeys.reduce(function (sum, key) {
      return sum + dayMap.get(key).pnl;
    }, 0);
    let bestDay = null;
    monthKeys.forEach(function (key) {
      const value = dayMap.get(key).pnl;
      if (!bestDay || value > bestDay.value) bestDay = { date: key, value: value };
    });

    const notesByDate = {};
    store.state.notes.forEach(function (note) {
      if (!notesByDate[note.date]) notesByDate[note.date] = [];
      notesByDate[note.date].push(note);
    });

    const settings = store.state.settings;
    const monthMetrics = store.metrics(closedMonth, U.parseNum(settings.startBalance) || 0);
    const dayValues = monthKeys.map(function (key) { return dayMap.get(key).pnl; });

    $('#calSummary').innerHTML =
      '<span class="chip ' + toneClass(monthPnl) + '">' + U.escapeHtml(U.money(monthPnl, { sign: true })) + '</span>' +
      '<span class="chip">' + closedMonth.length + ' ' + pluralTrades(closedMonth.length) + '</span>' +
      '<span class="chip">Винрейт ' + (monthMetrics.count ? U.percent(monthMetrics.winRate, 0) : '—') + '</span>' +
      (bestDay && bestDay.value > 0.004 ? '<span class="chip pos">Лучший день +' + U.escapeHtml(U.money(bestDay.value)) + '</span>' : '');

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - offset);
    const today = todayInAccount();
    const maxAbs = dayValues.length ? Math.max.apply(null, dayValues.map(Math.abs)) : 0;

    let html = '';
    for (let i = 0; i < 42; i++) {
      const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = U.isoOf(date);
      const inMonth = date.getMonth() === month;
      const dayInfo = dayMap.get(iso);
      const dayPnl = dayInfo ? dayInfo.pnl : 0;
      const count = dayInfo ? dayInfo.count : 0;
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

    const dayInfo = store.dayPnlMap(store.state.trades).get(day) || { pnl: 0, count: 0 };
    const dayPnl = dayInfo.pnl;
    const dayEventPnl = new Map();
    const dayTrades = store.state.trades
      .filter(function (trade) {
        if (trade.date === day) return true;
        const events = store.tradePnlEvents(trade).filter(function (event) { return event.date === day; });
        if (!events.length) return false;
        dayEventPnl.set(trade.id, events.reduce(function (sum, event) { return sum + event.pnl; }, 0));
        return true;
      })
      .sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
    const closedTrades = dayTrades.filter(function (trade) { return dayEventPnl.has(trade.id); });

    const dayNotes = store.state.notes
      .filter(function (note) { return note.date === day; })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

    const wins = closedTrades.filter(function (trade) { return dayEventPnl.get(trade.id) > 0.004; }).length;
    const losses = closedTrades.filter(function (trade) { return dayEventPnl.get(trade.id) < -0.004; }).length;

    let tradesHtml;
    if (!dayTrades.length) {
      tradesHtml = '<div class="day-empty">В этот день сделок нет.<br>Можно добавить сделку или записать наблюдение.</div>';
    } else {
      tradesHtml = '<div class="day-sub">Сделки дня</div>' + dayTrades.map(function (trade) {
        const status = store.tradeStatus(trade);
        const hasEvent = dayEventPnl.has(trade.id);
        const pnl = hasEvent ? dayEventPnl.get(trade.id) : null;
        return '<div class="day-trade" data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
          '<span class="day-trade-symbol" data-i18n-skip>' + U.escapeHtml(trade.symbol) +
          ' <span class="day-trade-side">' + (trade.side === 'long' ? 'long' : 'short') + '</span>' +
          (status === 'partial' ? ' <span class="partial-badge">' + T('частично') + '</span>' : '') + '</span>' +
          '<span class="day-trade-pnl ' + (hasEvent ? toneClass(pnl) : 'neutral') + '">' +
          (status === 'open' ? T('открыта') : (hasEvent ? U.escapeHtml(U.money(pnl, { sign: true })) : '—')) + '</span></div>';
      }).join('');
    }

    let notesHtml = '';
    if (dayNotes.length) {
      const note = dayNotes[0];
      const mood = U.moodMeta(note.mood);
      notesHtml = '<div class="day-sub">Запись в журнале</div>' +
        '<div class="day-note"><div class="day-note-head">' + mood.emoji + ' <span data-i18n-skip>' + U.escapeHtml(note.title || mood.label) + '</span></div>' +
        '<p data-i18n-skip>' + U.escapeHtml(U.truncate(note.text, 180)) + '</p>' +
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
      '<button type="button" class="btn btn-primary btn-sm" data-action="new-trade" data-date="' + day + '">' + T('+ Сделка') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="new-note" data-date="' + day + '">' + T('Запись в журнал') + '</button>' +
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
    if (cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth()) return todayInAccount();
    const prefix = cursor.getFullYear() + '-' + pad2(cursor.getMonth() + 1);
    const days = Array.from(store.dayPnlMap(store.state.trades).keys())
      .filter(function (day) { return day.slice(0, 7) === prefix; })
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
        value: m.count ? (m.profitFactor === Infinity ? '∞' : decimal(m.profitFactor, 2)) : '—',
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
      labelSkip: true,
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

    const sessions = store.state.settings.sessions;
    const sessionGroups = store.groupRows(rows, function (t) { return U.sessionOf(t.time, sessions); });
    const sessionOrder = U.sessionNames(sessions).concat('Без времени');
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

    const weekdayMap = new Map();
    rows.forEach(function (trade) {
      store.tradePnlEvents(trade).forEach(function (event) {
        const key = String(U.weekdayIndex(event.date));
        let group = weekdayMap.get(key);
        if (!group) { group = { key: key, count: 0, pnl: 0, trades: new Set() }; weekdayMap.set(key, group); }
        group.pnl += event.pnl;
        if (!group.trades.has(trade.id)) { group.trades.add(trade.id); group.count++; }
      });
    });
    const weekdayGroups = Array.from(weekdayMap.values())
      .filter(function (group) { return group.count >= 2; })
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
          text: 'Средняя дисциплина <b>' + decimal(m.avgDiscipline, 1) + ' / 5</b>. Сделки вне плана заметно ухудшают результат — начните с чек-листа перед входом.'
        });
      } else if (m.avgDiscipline >= 4.2) {
        out.push({
          tone: 'pos', icon: '✓',
          text: 'Средняя дисциплина <b>' + decimal(m.avgDiscipline, 1) + ' / 5</b>. Вы стабильно следуете плану — это важнее отдельной прибыльной сделки.'
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
        '<div class="hb-top"><span class="hb-label"' + (options.labelSkip ? ' data-i18n-skip' : '') + '>' + U.escapeHtml(label) +
        '<small>' + group.count + '</small></span>' +
        '<span class="hb-value ' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</span></div>' +
        '<div class="hb-track"><div class="hb-fill ' + (group.pnl < 0 ? 'neg' : '') + '" style="width:' + width + '%"></div></div></div>';
    }).join('');
  }

  function renderQuality(m) {
    const withR = m.rows.filter(function (row) { return row.r !== null; }).length;
    const discipline = m.avgDiscipline > 0 ? decimal(m.avgDiscipline, 1) + ' / 5' : '—';
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
      const pf = group.profitFactor === Infinity ? '∞' : decimal(group.profitFactor, 2);
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
      '<div class="jstat"><span>Среднее настроение</span><strong>' + (notes.length ? decimal(moodScore, 1) + ' / 5' : '—') + '</strong><small>по всем записям</small></div>' +
      '<div class="jstat"><span>Последняя запись</span><strong>' + (latest ? U.formatDate(latest, 'med') : '—') + '</strong><small>' + (latest ? U.formatDate(latest, 'weekday-full') : 'пока нет записей') + '</small></div>';

    const container = $('#journalList');
    if (!notes.length) {
      container.innerHTML = '<div class="card empty-state" style="grid-column:1/-1">' +
        '<div class="empty-icon">📝</div><h3>' + T('Дневник пока пуст') + '</h3>' +
        '<p>' + T('Записывайте выводы после торгового дня: что сработало, что нет и что измените завтра.') + '</p>' +
        '<div class="empty-actions"><button class="btn btn-primary" data-action="new-note">' + T('Новая запись') + '</button></div></div>';
      return;
    }

    const dayStats = store.dayPnlMap(store.state.trades);

    container.innerHTML = notes.map(function (note) {
      const mood = U.moodMeta(note.mood);
      const day = dayStats.get(note.date) || { pnl: 0, count: 0 };
      return '<article class="note-card" style="--mood:' + mood.color + '">' +
        '<div class="note-head"><span class="note-date">' + U.escapeHtml(U.formatDate(note.date, 'long')) +
        '<span>' + U.escapeHtml(U.formatDate(note.date, 'weekday')) + '</span></span>' +
        '<span class="mood-chip">' + mood.emoji + ' ' + U.escapeHtml(mood.label) + '</span></div>' +
        (day.count ? '<span class="note-daypnl ' + toneClass(day.pnl) + '">' + U.escapeHtml(U.money(day.pnl, { sign: true })) + ' · ' + day.count + ' ' + pluralTrades(day.count) + '</span>' : '') +
        '<h3 data-i18n-skip>' + U.escapeHtml(note.title || T('Без заголовка')) + '</h3>' +
        '<p class="note-text" data-i18n-skip>' + U.escapeHtml(note.text) + '</p>' +
        (note.tags.length ? '<div class="note-tags" data-i18n-skip>' + note.tags.map(function (tag) { return '<span class="tag">' + U.escapeHtml(tag) + '</span>'; }).join('') + '</div>' : '') +
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
    $('#calcRR').textContent = rr !== null ? '1 : ' + decimal(rr, 2) : '—';

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

  function fillTimezoneOptions() {
    const list = $('#timezoneList');
    if (!list || list.dataset.filled === '1') return;
    const common = [
      'UTC',
      'Europe/Moscow',
      'Europe/London',
      'Europe/Berlin',
      'Europe/Kiev',
      'Europe/Istanbul',
      'Asia/Almaty',
      'Asia/Dubai',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Asia/Singapore',
      'America/New_York',
      'America/Chicago',
      'America/Los_Angeles',
      'Australia/Sydney'
    ];
    let zones = [];
    try {
      if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
    } catch (err) { zones = []; }
    const seen = new Set();
    const all = common.concat(zones).filter(function (zone) {
      if (!zone || seen.has(zone)) return false;
      seen.add(zone);
      return true;
    });
    list.innerHTML = all.map(function (zone) {
      return '<option value="' + U.escapeHtml(zone) + '"></option>';
    }).join('');
    list.dataset.filled = '1';
  }

  function renderSessionSettings() {
    const box = $('#sessionSettings');
    if (!box) return;
    const sessions = store.state.settings.sessions || U.normalizeSessions();
    box.innerHTML = sessions.map(function (session) {
      return '<div class="session-setting-row" data-session-key="' + U.escapeHtml(session.key) + '">' +
        '<input type="text" data-session-name data-i18n-skip maxlength="24" value="' + U.escapeHtml(session.name) + '" aria-label="' + T('Название сессии') + '" autocomplete="off">' +
        '<span class="session-dash">' + T('с') + '</span>' +
        '<input type="time" data-session-start value="' + U.escapeHtml(session.start) + '" aria-label="' + T('Начало сессии') + '">' +
        '</div>';
    }).join('');
  }

  function readSessionSettings() {
    const rows = $$('#sessionSettings .session-setting-row');
    if (!rows.length) return store.state.settings.sessions;
    return rows.map(function (row) {
      const name = row.querySelector('[data-session-name]').value.trim();
      const start = row.querySelector('[data-session-start]').value;
      return { key: row.dataset.sessionKey, name: name, start: start };
    });
  }

  function renderSettings() {
    const settings = store.state.settings;
    const account = store.activeAccount();
    const profile = store.state.profile || {};

    fillTimezoneOptions();
    $('#profileName').value = profile.name || '';
    state.profileAvatarDraft = profile.avatar || '';
    renderProfileAvatar();
    $('#profileSavedAt').textContent = '';

    const accountSelect = $('#accountSelect');
    if (accountSelect) {
      accountSelect.innerHTML = store.state.accounts.map(function (item) {
        return '<option data-i18n-skip value="' + U.escapeHtml(item.id) + '">' + U.escapeHtml(item.name) + '</option>';
      }).join('');
      accountSelect.value = store.state.activeAccountId;
    }
    const chip = $('#activeAccountChip');
    chip.setAttribute('data-i18n-skip', '');
    chip.textContent = account ? account.name : '—';
    const meta = $('#accountMeta');
    meta.innerHTML = account
      ? '<span data-i18n-skip>' + U.escapeHtml(account.name) + '</span> · ' + account.trades.length + ' ' + pluralTrades(account.trades.length) + ' · ' +
        account.notes.length + ' ' + pluralNotes(account.notes.length)
      : '—';
    $('#deleteAccountBtn').disabled = store.state.accounts.length <= 1;

    $('#settingCurrency').value = settings.currency || '$';
    $('#settingBalance').value = settings.startBalance;
    $('#settingRisk').value = settings.riskPercent;
    $('#settingDailyLimit').value = settings.dailyLossLimit;
    $('#settingMaxTrades').value = settings.maxTradesPerDay;
    $('#settingTimezone').value = settings.timezone || U.systemTimeZone();
    renderSessionSettings();
    $('#settingsSavedAt').textContent = '';
    setVersionLabel(APP_VERSION);

    renderStorageMeter(store.storageSize(), desktop ? 100 * 1024 * 1024 : 5 * 1024 * 1024);
    if (!desktop) renderWebStorageEstimate();
    renderBackupMeta();

    if (desktop) refreshDesktopBackups();
    renderAppearance();
  }

  function renderAppearance() {
    if (!NS.prefs) return;
    const prefs = NS.prefs.get();
    const base = NS.prefs.defaultsFor(prefs.theme);
    const accent = prefs.accent || base.accent;
    const bg = prefs.bg || base.bg;
    const panel = prefs.panel || base.panel;

    $$('#languageSegmented [data-lang-option]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.langOption === prefs.lang);
    });
    $$('#themeSegmented [data-theme-option]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.themeOption === prefs.theme);
    });
    const chip = $('#appearanceThemeChip');
    if (chip) {
      chip.setAttribute('data-i18n-skip', '');
      chip.textContent = T(prefs.theme === 'light' ? 'Светлая' : 'Тёмная');
    }

    const swatches = $('#accentSwatches');
    if (swatches) {
      swatches.innerHTML = NS.prefs.ACCENTS.map(function (item) {
        return '<button type="button" class="swatch" data-accent-value="' + item.color + '"' +
          ' style="background:' + item.color + '" aria-label="' + U.escapeHtml(T(item.label)) + '" title="' + U.escapeHtml(T(item.label)) + '"></button>';
      }).join('');
      $$('.swatch', swatches).forEach(function (button) {
        button.classList.toggle('active', button.dataset.accentValue.toLowerCase() === accent.toLowerCase());
      });
    }
    const accentInput = $('#accentColor');
    if (accentInput) accentInput.value = accent;
    const bgInput = $('#bgColor');
    if (bgInput) bgInput.value = bg;
    const panelInput = $('#panelColor');
    if (panelInput) panelInput.value = panel;
  }

  function saveAppearance(patch, redraw) {
    if (!NS.prefs) return;
    NS.prefs.save(patch);
    renderAppearance();
    if (redraw) renderCurrentView();
  }

  function renderStorageMeter(size, limit) {
    const pct = limit > 0 ? Math.min(100, size / limit * 100) : 0;
    $('#storageText').textContent = U.bytes(size) + ' · ' + U.percent(pct, 1);
    $('#storageBar').style.width = Math.max(pct > 0 ? 2 : 0, pct) + '%';
  }

  function renderWebStorageEstimate() {
    const note = $('#storageEstimate');
    if (!note) return;
    note.hidden = false;
    note.textContent = 'Скриншоты хранятся в IndexedDB. Считаем размер хранилища…';
    Promise.all([store.storageEstimate(), store.isStoragePersisted()]).then(function (results) {
      if (!note.isConnected) return;
      const data = results[0];
      const persisted = results[1] === true;
      if (!data) {
        note.textContent = 'Скриншоты хранятся в IndexedDB. Браузер не сообщает точный размер хранилища.' +
          (persisted ? ' Постоянное хранилище включено.' : '');
        return;
      }
      renderStorageMeter(data.usage, data.quota);
      const pct = data.usage / data.quota * 100;
      note.textContent = 'Оценка браузера: ' + U.bytes(data.usage) + ' из ' + U.bytes(data.quota) +
        ' (' + U.percent(pct, 1) + '). Скриншоты хранятся в IndexedDB.' +
        (persisted ? ' Постоянное хранилище включено.' : '');
    });
  }

  function pluralNotes(n) {
    return U.plural(n, ['запись', 'записи', 'записей']);
  }

  function renderProfileAvatar() {
    const box = $('#profileAvatarPreview');
    if (!box) return;
    box.innerHTML = '';
    if (state.profileAvatarDraft) {
      const image = document.createElement('img');
      image.src = state.profileAvatarDraft;
      image.alt = 'Аватар профиля';
      box.appendChild(image);
      return;
    }
    const initials = document.createElement('span');
    initials.textContent = initialsOf($('#profileName') ? $('#profileName').value : '');
    box.appendChild(initials);
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
    return date.toLocaleString(U.locale(), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function initDesktopUi() {
    if (!desktop) return;
    const backupRow = $('#backupMetaRow');
    if (backupRow) backupRow.hidden = true;
    const card = $('#desktopDataCard');
    if (!card) return;
    card.hidden = false;
    setDesktopVersionLabel(APP_VERSION);
    loadDesktopDataInfo();
    refreshDesktopBackups();
    $('#openDataFolderBtn').addEventListener('click', openDesktopDataFolder);
    $('#backupNowBtn').addEventListener('click', createDesktopBackup);
    $('#refreshBackupsBtn').addEventListener('click', refreshDesktopBackups);
    $('#scanStorageBtn').addEventListener('click', function () { scanStorageHealth(true); });
    $('#cleanupScreenshotsBtn').addEventListener('click', cleanupUnusedScreenshots);
    $('#checkUpdateBtn').addEventListener('click', function () { checkDesktopUpdate(true); });
    $('#downloadUpdateBtn').addEventListener('click', installDesktopUpdate);
    $('#desktopBackupsList').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-backup]');
      if (!button) return;
      restoreDesktopBackup(button.dataset.backup);
    });
    window.setTimeout(function () { checkDesktopUpdate(false); }, 2500);
  }

  const desktopUpdate = { checking: false, installing: false, available: false, version: '' };

  function setDownloadUpdateButton(visible) {
    const button = $('#downloadUpdateBtn');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = false;
    button.textContent = 'Скачать и установить';
  }

  async function checkDesktopUpdate(manual) {
    if (!desktop || typeof desktop.checkUpdate !== 'function' || desktopUpdate.checking || desktopUpdate.installing) return;
    desktopUpdate.checking = true;
    const button = $('#checkUpdateBtn');
    if (button) {
      button.disabled = true;
      button.textContent = 'Проверяем…';
    }
    if (manual) setDesktopUpdateStatus('Проверяем обновления…');
    try {
      const info = await desktop.checkUpdate();
      const current = info && info.currentVersion ? String(info.currentVersion) : APP_VERSION;
      setDesktopVersionLabel(current);
      desktopUpdate.available = !!(info && info.available);
      desktopUpdate.version = info && info.version ? String(info.version) : '';
      if (desktopUpdate.available) {
        setDesktopUpdateStatus('Доступна версия ' + (desktopUpdate.version || '—') + '. Можно скачать и установить её здесь.', 'pos');
        setDownloadUpdateButton(true);
        showUpdateBanner(
          'Доступно обновление TradeJournal',
          'Версия ' + (desktopUpdate.version || '') + ' готова к установке. Приложение скачает обновление и перезапустится.',
          'Установить'
        );
      } else {
        setDesktopUpdateStatus('Установлена последняя версия (' + current + ').', 'pos');
        setDownloadUpdateButton(false);
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err || 'неизвестная ошибка');
      setDesktopUpdateStatus('Не удалось проверить обновления: ' + message, 'neg');
    } finally {
      desktopUpdate.checking = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Проверить обновления';
      }
    }
  }

  async function installDesktopUpdate() {
    if (!desktop || typeof desktop.installUpdate !== 'function' || desktopUpdate.installing) return;
    if (!desktopUpdate.available) {
      checkDesktopUpdate(true);
      return;
    }
    desktopUpdate.installing = true;
    const bannerButton = $('#installUpdateBtn');
    const downloadButton = $('#downloadUpdateBtn');
    const checkButton = $('#checkUpdateBtn');
    if (bannerButton) {
      bannerButton.disabled = true;
      bannerButton.textContent = 'Устанавливаем…';
    }
    if (downloadButton) {
      downloadButton.disabled = true;
      downloadButton.textContent = 'Скачиваем…';
    }
    if (checkButton) checkButton.disabled = true;
    setDesktopUpdateStatus('Скачиваем и устанавливаем обновление…');
    try {
      await desktop.installUpdate();
      desktopUpdate.available = false;
      setDesktopUpdateStatus('Обновление установлено. Приложение перезапустится.', 'pos');
      const banner = $('#updateBanner');
      if (banner) banner.hidden = true;
      setDownloadUpdateButton(false);
      toast('Обновление установлено. Приложение перезапустится.');
    } catch (err) {
      const message = err && err.message ? err.message : String(err || 'неизвестная ошибка');
      setDesktopUpdateStatus('Не удалось установить обновление: ' + message, 'neg');
      toast('Не удалось установить обновление: ' + message, 'error');
      if (bannerButton) {
        bannerButton.disabled = false;
        bannerButton.textContent = 'Установить';
      }
      if (downloadButton) {
        downloadButton.disabled = false;
        downloadButton.textContent = 'Скачать и установить';
      }
    } finally {
      desktopUpdate.installing = false;
      if (checkButton) checkButton.disabled = false;
      if (bannerButton && desktopUpdate.available) {
        bannerButton.disabled = false;
        bannerButton.textContent = 'Установить';
      }
    }
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
      if (info && info.version) setDesktopVersionLabel(info.version);
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

  function setStorageHealthStatus(text, tone) {
    const el = $('#storageHealthStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'muted small storage-health-status' + (tone ? ' ' + tone : '');
  }

  function renderUnusedScreenshots(data) {
    const wrap = $('#unusedScreenshots');
    const list = $('#unusedList');
    const note = $('#unusedNote');
    const button = $('#cleanupScreenshotsBtn');
    if (!wrap || !list || !button) return;

    const unused = data && Array.isArray(data.unused) ? data.unused : [];
    if (!unused.length) {
      wrap.hidden = true;
      list.innerHTML = '';
      note.hidden = true;
      note.textContent = '';
      button.disabled = true;
      return;
    }

    wrap.hidden = false;
    const visible = unused.slice(0, 100);
    list.innerHTML = visible.map(function (file) {
      return '<li><code>' + U.escapeHtml(file.name) + '</code><span>' + U.escapeHtml(U.bytes(file.size)) + '</span></li>';
    }).join('');
    if (unused.length > visible.length) {
      note.hidden = false;
      note.textContent = 'Показаны первые ' + visible.length + ' из ' + unused.length + '. Кнопка удалит все найденные неиспользуемые файлы.';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
    $('#unusedSummary').textContent = U.bytes(data.unusedSize || 0);
    button.disabled = false;
    button.textContent = 'Удалить неиспользуемые (' + unused.length + ' · ' + U.bytes(data.unusedSize || 0) + ')';
  }

  function renderStorageHealth(data) {
    state.storageHealthData = data || {};
    const grid = $('#storageHealthGrid');
    if (grid) grid.hidden = false;
    $('#healthJournalSize').textContent = U.bytes(data.journalSize || 0);
    $('#healthShotsSize').textContent = U.bytes(data.screenshotsSize || 0);
    $('#healthBackupsSize').textContent = U.bytes(data.backupsSize || 0);
    $('#healthPreviousSize').textContent = U.bytes(data.previousSize || 0);
    $('#healthShotsMeta').textContent = (data.screenshotsCount || 0) + ' ' + U.plural(data.screenshotsCount || 0, ['файл', 'файла', 'файлов']);
    $('#healthBackupsMeta').textContent = (data.backupsCount || 0) + ' ' + U.plural(data.backupsCount || 0, ['копия', 'копии', 'копий']);

    const parts = [
      'Ссылок на скриншоты в журнале и копиях: ' + (data.referencedCount || 0) + '.'
    ];
    if (data.missingCount) {
      parts.push('Не хватает файлов по ссылкам: ' + data.missingCount + ' — возможно, они были удалены вручную.');
    }
    if (data.unusedCount) {
      parts.push('Найдено неиспользуемых файлов: ' + data.unusedCount + ' на ' + U.bytes(data.unusedSize || 0) + '.');
    } else {
      parts.push('Неиспользуемых скриншотов не найдено.');
    }
    setStorageHealthStatus(parts.join(' '), data.missingCount ? 'warn' : '');
    renderUnusedScreenshots(data);
  }

  async function scanStorageHealth(manual) {
    if (!desktop || typeof desktop.storageHealth !== 'function' || state.storageHealthScanning) return;
    state.storageHealthScanning = true;
    const button = $('#scanStorageBtn');
    if (button) {
      button.disabled = true;
      button.textContent = 'Проверяем…';
    }
    if (manual) setStorageHealthStatus('Проверяем журнал, скриншоты и резервные копии…');
    try {
      const data = await desktop.storageHealth();
      renderStorageHealth(data || {});
      if (manual) toast('Хранилище проверено');
    } catch (err) {
      const message = err && err.message ? err.message : String(err || 'неизвестная ошибка');
      setStorageHealthStatus('Не удалось проверить хранилище: ' + message, 'error');
      if (manual) toast('Не удалось проверить хранилище: ' + message, 'error');
    } finally {
      state.storageHealthScanning = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Проверить';
      }
    }
  }

  function cleanupUnusedScreenshots() {
    if (!desktop || typeof desktop.cleanupUnusedScreenshots !== 'function' || state.storageHealthCleaning) return;
    const data = state.storageHealthData;
    const unused = data && Array.isArray(data.unused) ? data.unused : [];
    if (!unused.length) return;

    askConfirm({
      title: 'Удалить неиспользуемые скриншоты?',
      text: 'Будет удалено ' + unused.length + ' ' + pluralScreenshots(unused.length) + ' на ' + U.bytes(data.unusedSize || 0) + '. Файлы, на которые ссылаются журнал, предыдущая версия или резервные копии, не затрагиваются. Действие нельзя отменить.',
      okLabel: 'Удалить'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      state.storageHealthCleaning = true;
      const button = $('#cleanupScreenshotsBtn');
      if (button) {
        button.disabled = true;
        button.textContent = 'Удаляем…';
      }
      try {
        const result = await desktop.cleanupUnusedScreenshots(unused.map(function (file) { return file.name; }));
        const deleted = result && result.deletedCount ? result.deletedCount : 0;
        const skippedRecent = result && result.skippedRecent ? result.skippedRecent : 0;
        const message = [];
        if (deleted) {
          message.push('Удалено ' + deleted + ' ' + pluralScreenshots(deleted) + ' (' + U.bytes(result.deletedSize || 0) + ').');
        } else if (skippedRecent) {
          message.push('Недавно созданные файлы пока не удаляются — повторите проверку позже.');
        } else {
          message.push('Нечего удалять: файлы уже отсутствуют или используются.');
        }
        if (deleted && skippedRecent) {
          message.push('Пропущено недавно созданных файлов: ' + skippedRecent + '.');
        }
        toast(message.join(' '), deleted ? 'success' : 'warn');
        if (result && Array.isArray(result.failed) && result.failed.length) {
          toast('Не удалось удалить файлов: ' + result.failed.length + '. Проверьте папку данных.', 'error');
        }
        await scanStorageHealth(false);
      } catch (err) {
        const message = err && err.message ? err.message : String(err || 'неизвестная ошибка');
        setStorageHealthStatus('Не удалось удалить скриншоты: ' + message, 'error');
        toast('Не удалось удалить скриншоты: ' + message, 'error');
      } finally {
        state.storageHealthCleaning = false;
        if (state.storageHealthData) {
          renderUnusedScreenshots(state.storageHealthData);
        } else if (button) {
          button.disabled = false;
          button.textContent = 'Удалить неиспользуемые';
        }
      }
    });
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
        if (!(await store.load())) {
          toast('Копия записана в файл, но приложение не смогло её перечитать. Перезапустите приложение.', 'error');
          return;
        }
        await store.migrateScreenshots();
        if (store.needsMigration) await store.save();
        clearAllDrafts();
        applyCurrency();
        state.calCursor = monthStart(new Date());
        state.selectedDay = todayInAccount();
        renderAll();
        refreshDesktopBackups();
        toast('Резервная копия восстановлена');
      } catch (err) {
        toast('Не удалось восстановить копию: ' + (err && err.message ? err.message : err), 'error');
      }
    });
  }

  async function saveSettings(event) {
    event.preventDefault();
    const currency = $('#settingCurrency').value || '$';
    const balance = U.parseNum($('#settingBalance').value);
    const risk = U.parseNum($('#settingRisk').value);
    const daily = U.parseNum($('#settingDailyLimit').value);
    const maxTrades = U.parseNum($('#settingMaxTrades').value);
    const timezone = $('#settingTimezone').value.trim();
    const sessions = readSessionSettings();

    if (balance === null || balance < 0) return toast('Стартовый баланс должен быть неотрицательным числом.', 'error');
    if (risk === null || risk < 0 || risk > 100) return toast('Риск на сделку должен быть от 0 до 100%.', 'error');
    if (daily === null || daily < 0 || daily > 100) return toast('Дневной лимит убытка должен быть от 0 до 100%.', 'error');
    if (maxTrades === null || maxTrades < 0) return toast('Максимум сделок в день должен быть неотрицательным.', 'error');
    if (!U.validTimeZone(timezone)) {
      return toast('Часовой пояс не распознан. Укажите зону IANA, например Europe/Moscow или America/New_York.', 'error');
    }

    const seenNames = new Set();
    const seenStarts = new Set();
    for (const session of sessions) {
      const name = String(session.name || '').trim();
      if (!name) return toast('У каждой торговой сессии должно быть название.', 'error');
      if (seenNames.has(name.toLowerCase())) return toast('Названия торговых сессий должны быть разными.', 'error');
      if (!U.validTimeHM(session.start)) return toast('Укажите время начала для сессии «' + name + '».', 'error');
      if (seenStarts.has(session.start)) return toast('Время начала торговых сессий должно быть разным.', 'error');
      seenNames.add(name.toLowerCase());
      seenStarts.add(session.start);
    }
    sessions.sort(function (a, b) { return a.start.localeCompare(b.start); });

    store.state.settings = {
      currency: currency,
      startBalance: balance,
      riskPercent: risk,
      dailyLossLimit: daily,
      maxTradesPerDay: Math.round(maxTrades),
      timezone: timezone,
      sessions: sessions.map(function (session) {
        return { key: session.key, name: String(session.name).trim(), start: session.start };
      })
    };
    state.selectedDay = todayInAccount();
    store.state.demo = false;
    applyCurrency();
    const ok = await persist();
    renderSidebar();
    renderCurrentView();
    if (ok) {
      $('#settingsSavedAt').textContent = T('Сохранено в') + ' ' + new Date().toLocaleTimeString(U.locale(), { hour: '2-digit', minute: '2-digit' });
      toast('Настройки сохранены');
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const name = $('#profileName').value.trim().slice(0, 40);
    store.state.profile = {
      name: name,
      avatar: state.profileAvatarDraft || ''
    };
    const ok = await persist();
    if (!ok) return;
    state.profileAvatarDraft = store.state.profile.avatar || '';
    renderSidebar();
    renderProfileAvatar();
    $('#profileSavedAt').textContent = T('Сохранено в') + ' ' + new Date().toLocaleTimeString(U.locale(), { hour: '2-digit', minute: '2-digit' });
    toast('Профиль сохранён');
  }

  function compressAvatar(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('Можно загрузить только изображение.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      const image = new Image();
      image.onload = function () {
        const side = Math.min(image.width, image.height);
        if (!side) {
          toast('Не удалось обработать изображение.', 'error');
          return;
        }
        const max = 256;
        const scale = Math.min(1, max / side);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(side * scale));
        canvas.height = Math.max(1, Math.round(side * scale));
        const ctx = canvas.getContext('2d');
        const sx = Math.max(0, (image.width - side) / 2);
        const sy = Math.max(0, (image.height - side) / 2);
        ctx.drawImage(image, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
        try {
          state.profileAvatarDraft = canvas.toDataURL('image/jpeg', 0.84);
          renderProfileAvatar();
          toast('Аватар обновлён — нажмите «Сохранить профиль»');
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

  function openAccountModal(mode) {
    state.accountModalMode = mode === 'rename' ? 'rename' : 'create';
    const account = store.activeAccount();
    const rename = state.accountModalMode === 'rename';
    $('#accountModalTitle').textContent = rename ? 'Переименовать счёт' : 'Новый счёт';
    $('#accountModalHint').textContent = rename ? 'Новое название активного счёта' : 'Дайте счёту понятное название';
    $('#accountName').value = rename && account ? account.name : '';
    $('#saveAccountBtn').textContent = rename ? 'Сохранить название' : 'Создать счёт';
    $('#accountError').hidden = true;
    openModal('accountModal', '#accountName');
  }

  async function saveAccount(event) {
    event.preventDefault();
    const name = $('#accountName').value.trim().slice(0, 40);
    if (!name) {
      $('#accountError').hidden = false;
      $('#accountError').textContent = 'Укажите название счёта.';
      return;
    }
    const rename = state.accountModalMode === 'rename';
    const account = store.activeAccount();
    if (rename) {
      if (!account || !store.renameAccount(account.id, name)) {
        $('#accountError').hidden = false;
        $('#accountError').textContent = 'Не удалось переименовать счёт.';
        return;
      }
    } else {
      store.addAccount(name);
    }
    const ok = await persist();
    if (!ok) {
      $('#accountError').hidden = false;
      $('#accountError').textContent = 'Не удалось сохранить счёт. Проверьте папку данных.';
      return;
    }
    closeModal('accountModal');
    applyCurrency();
    state.calCursor = monthStart(new Date());
    state.selectedDay = todayInAccount();
    renderAll();
    toast(rename ? 'Счёт переименован' : 'Счёт создан');
  }

  async function switchAccount(id) {
    if (!id || id === store.state.activeAccountId) return;
    if (!$('#tradeModal').hidden) {
      if (state.screenshotBusy) {
        toast('Скриншот ещё сохраняется, подождите пару секунд.', 'warn');
        renderSidebarAccounts();
        renderSettings();
        return;
      }
      saveDraftNow();
      closeModal('tradeModal');
    }
    const previous = store.state.activeAccountId;
    if (!store.setActiveAccount(id)) return;
    const ok = await persist();
    if (!ok) {
      store.setActiveAccount(previous);
      renderAll();
      toast('Не удалось переключить счёт: данные не сохранены.', 'error');
      return;
    }
    applyCurrency();
    state.calCursor = monthStart(new Date());
    state.selectedDay = todayInAccount();
    renderAll();
    const account = store.activeAccount();
    toast(T('Активный счёт') + ': ' + (account ? account.name : '—'), 'success', null, { skip: true });
  }

  function deleteActiveAccount() {
    const account = store.activeAccount();
    if (!account) return;
    if (store.state.accounts.length <= 1) {
      toast('Нельзя удалить единственный счёт.', 'warn');
      return;
    }
    askConfirm({
      title: 'Удалить счёт?',
      text: T('Счёт') + ' «' + account.name + '» ' + T('и все его сделки и записи будут удалены. Сразу после удаления действие можно будет отменить.'),
      textReady: true,
      okLabel: 'Удалить'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      const before = JSON.parse(JSON.stringify(store.state));
      const id = account.id;
      if (!store.deleteAccount(id)) {
        toast('Не удалось удалить счёт.', 'error');
        return;
      }
      const ok = await persist();
      if (!ok) {
        await store.replaceData(before);
        renderAll();
        toast('Удаление не сохранено: данные оставлены прежними.', 'error');
        return;
      }
      clearAccountDrafts(id);
      applyCurrency();
      state.calCursor = monthStart(new Date());
      state.selectedDay = todayInAccount();
      renderAll();
      toast('Счёт удалён', 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          applyCurrency();
          state.calCursor = monthStart(new Date());
          state.selectedDay = todayInAccount();
          renderAll();
          toast(restored ? 'Счёт восстановлен' : 'Не удалось восстановить счёт', restored ? 'success' : 'error');
        }
      });
    });
  }

  function readBackupMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function writeBackupMeta(meta) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } catch (err) {
      // Metadata only controls reminders; the journal itself is unaffected.
    }
  }

  function updateBackupMeta(patch) {
    const meta = Object.assign({}, readBackupMeta(), patch);
    writeBackupMeta(meta);
    renderBackupMeta();
    return meta;
  }

  function backupTradeCount() {
    return store.state.accounts.reduce(function (sum, account) {
      return sum + (Array.isArray(account.trades) ? account.trades.length : 0);
    }, 0);
  }

  function formatBackupTime(value) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return '';
    try {
      return new Date(ms).toLocaleString(U.locale(), {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function renderBackupMeta() {
    const el = $('#backupMetaText');
    if (!el) return;
    const meta = readBackupMeta();
    const parts = [];
    const last = formatBackupTime(meta.lastExportAt);
    parts.push(last ? 'Последняя резервная копия: ' + last + '.' : 'Резервная копия ещё не создавалась.');
    const remindLater = Date.parse(meta.remindLaterUntil);
    if (Number.isFinite(remindLater) && remindLater > Date.now()) {
      parts.push('Напоминание отложено до ' + formatBackupTime(meta.remindLaterUntil) + '.');
    }
    el.textContent = parts.join(' ');
  }

  function markBackupExported() {
    updateBackupMeta({
      lastExportAt: new Date().toISOString(),
      remindLaterUntil: null
    });
  }

  function remindBackupLater() {
    updateBackupMeta({
      remindLaterUntil: new Date(Date.now() + U.BACKUP_REMIND_MS).toISOString()
    });
    toast('Напомним о резервной копии позже');
  }

  function maybeRemindBackup() {
    if (desktop) return;
    if (state.backupReminderShown) return;
    state.backupReminderShown = true;
    if (store.state.demo) return;
    if (!U.shouldRemindBackup(readBackupMeta(), Date.now(), backupTradeCount())) return;
    toast('Давно не делали резервную копию журнала. Экспорт JSON — в настройках.', 'warn', {
      label: 'Напомнить позже',
      onClick: remindBackupLater
    });
  }

  async function exportJSON() {
    try {
      const snapshot = await store.exportSnapshot();
      const payload = Object.assign({}, snapshot, {
        app: 'TradeJournal',
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString()
      });
      U.download('tradejournal-' + U.todayISO() + '.json', JSON.stringify(payload, null, 2), 'application/json');
      markBackupExported();
      toast('Резервная копия скачана');
    } catch (err) {
      toast('Не удалось подготовить экспорт: ' + (err && err.message ? err.message : err), 'error');
    }
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

  function plainNumber(value) {
    const num = U.parseNum(value);
    return num === null ? '' : String(num);
  }

  function exitsForCsv(trade) {
    return store.tradeExits(trade).map(function (exit) {
      const date = exit.date && exit.date !== trade.date ? '@' + exit.date : '';
      return plainNumber(exit.qty) + '@' + plainNumber(exit.price) + date;
    }).join('|');
  }

  function exportCSV() {
    const trades = store.sortTrades(store.state.trades, 'desc');
    const headers = [
      'Дата', 'Время', 'Инструмент', 'Направление', 'Вход', 'Выход', 'Стоп при входе',
      'Текущий стоп', 'Тейк', 'Количество', 'Множитель', 'Комиссия', 'Выходы',
      'Остаток', 'Статус', 'P&L', 'R', 'Сетап', 'Эмоция', 'Дисциплина', 'Теги', 'Заметка'
    ];
    const lines = [headers.map(csvCell).join(';')];
    const statusLabels = { closed: 'Закрыта', partial: 'Частично закрыта', open: 'Открыта' };
    trades.forEach(function (trade) {
      const emotion = U.emotionMeta(trade.emotion);
      const pnl = store.hasRealized(trade) ? store.tradePnl(trade) : null;
      const r = store.hasRealized(trade) ? store.tradeR(trade) : null;
      const status = store.tradeStatus(trade);
      const row = [
        csvText(trade.date),
        csvText(trade.time),
        csvText(trade.symbol),
        csvText(trade.side === 'long' ? 'Long' : 'Short'),
        csvNumber(trade.entry, 6),
        store.weightedExit(trade) === null ? '' : csvNumber(store.weightedExit(trade), 6),
        trade.stop === null ? '' : csvNumber(trade.stop, 6),
        trade.currentStop === null ? '' : csvNumber(trade.currentStop, 6),
        trade.target === null ? '' : csvNumber(trade.target, 6),
        csvNumber(trade.qty, 4),
        csvNumber(trade.multiplier, 8),
        csvNumber(trade.fees, 2),
        csvText(exitsForCsv(trade)),
        store.remainingQty(trade) === null ? '' : csvNumber(store.remainingQty(trade), 4),
        csvText(statusLabels[status] || status),
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

  async function exportZIP() {
    try {
      const snapshot = await store.exportSnapshot();
      const exportedAt = new Date().toISOString();
      const payload = Object.assign({}, snapshot, {
        app: 'TradeJournal',
        appVersion: APP_VERSION,
        exportedAt: exportedAt
      });
      const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      const tradeCount = accounts.reduce(function (sum, account) { return sum + (account.trades ? account.trades.length : 0); }, 0);
      const noteCount = accounts.reduce(function (sum, account) { return sum + (account.notes ? account.notes.length : 0); }, 0);
      const shotCount = accounts.reduce(function (sum, account) {
        return sum + (account.trades || []).filter(function (trade) { return !!trade.screenshot; }).length;
      }, 0);
      const readme = [
        'TradeJournal — резервная копия',
        '',
        'Версия приложения: ' + APP_VERSION,
        'Дата экспорта: ' + exportedAt,
        'Счетов: ' + accounts.length + ', сделок: ' + tradeCount + ', записей журнала: ' + noteCount + ', скриншотов: ' + shotCount + '.',
        '',
        'Файл journal.json содержит все счета, сделки, записи и скриншоты.',
        'Скриншоты встроены в JSON, поэтому архив можно перенести на другое устройство.',
        '',
        'Как восстановить:',
        '1. Откройте TradeJournal.',
        '2. Настройки → «Импорт JSON».',
        '3. Выберите journal.json из этого архива.',
        '',
        'Импорт заменяет текущие данные журнала. Перед восстановлением сделайте резервную копию текущего состояния.',
        ''
      ].join('\r\n');
      const archive = NS.zip.create([
        { name: 'journal.json', data: JSON.stringify(payload, null, 2), date: new Date() },
        { name: 'README.txt', data: readme, date: new Date() }
      ]);
      U.downloadBytes('tradejournal-backup-' + U.todayISO() + '.zip', archive, 'application/zip');
      markBackupExported();
      toast('ZIP-архив со скриншотами скачан');
    } catch (err) {
      toast('Не удалось подготовить ZIP-архив: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  function importCSVFile(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast('CSV-файл слишком большой: максимум 15 МБ.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      const text = String(reader.result || '');
      const result = NS.csv.analyze(text, store.state.trades, { timeZone: accountTimeZone() });
      state.csvImport = { fileName: file.name, result: result };
      renderCsvPreview();
      openModal('csvModal', '#confirmCsvImport');
    };
    reader.onerror = function () { toast('Не удалось прочитать CSV-файл.', 'error'); };
    reader.readAsText(file, 'utf-8');
  }

  function renderCsvPreview() {
    const data = state.csvImport;
    const summary = $('#csvSummary');
    const alerts = $('#csvAlerts');
    const body = $('#csvPreviewBody');
    const confirm = $('#confirmCsvImport');
    if (!data) return;
    const result = data.result;
    const stats = result.stats || {};
    const delimiterLabels = { ';': 'точка с запятой', ',': 'запятая', '\t': 'табуляция' };
    summary.innerHTML = [
      ['Файл', data.fileName],
      ['Строк', stats.rows || 0],
      ['К импорту', result.trades.length],
      ['Дубликаты', result.duplicates || 0],
      ['Выходы', stats.exits || 0],
      ['Разделитель', delimiterLabels[result.delimiter] || result.delimiter]
    ].map(function (item) {
      return '<span class="chip"><b>' + U.escapeHtml(item[0]) + ':</b> ' + U.escapeHtml(item[1]) + '</span>';
    }).join('');

    const alertHtml = [];
    if (result.errors.length) {
      alertHtml.push('<div class="csv-alert error"><b>Ошибки (' + result.errors.length + '):</b> ' +
        U.escapeHtml(result.errors.slice(0, 6).join(' ')) +
        (result.errors.length > 6 ? ' …' : '') + '</div>');
    }
    if (result.warnings.length) {
      alertHtml.push('<div class="csv-alert warn"><b>Предупреждения (' + result.warnings.length + '):</b> ' +
        U.escapeHtml(result.warnings.slice(0, 5).join(' ')) +
        (result.warnings.length > 5 ? ' …' : '') + '</div>');
    }
    const account = store.activeAccount();
    alertHtml.push('<div class="csv-alert info">Сделки будут добавлены в активный счёт «<span data-i18n-skip>' +
      U.escapeHtml(account ? account.name : '—') + '</span>». Существующие сделки не изменятся.</div>');
    if (!result.trades.length) {
      alertHtml.push('<div class="csv-alert warn">Нет строк, готовых к импорту. Исправьте файл и попробуйте снова.</div>');
    }
    alerts.innerHTML = alertHtml.join('');

    if (!result.trades.length) {
      body.innerHTML = '<tr><td colspan="8" class="csv-empty">Нет данных для предпросмотра</td></tr>';
    } else {
      body.innerHTML = result.trades.slice(0, 200).map(function (raw) {
        const trade = store.normalizeTrade(raw, { timeZone: accountTimeZone() });
        if (!trade) return '';
        const pnl = store.tradePnl(trade);
        const exitText = store.tradeExits(trade).map(function (exit) {
          return U.qty(exit.qty) + '@' + U.price(exit.price);
        }).join(' | ');
        return '<tr>' +
          '<td>' + U.escapeHtml(U.formatDate(trade.date, 'med')) + '</td>' +
          '<td><b data-i18n-skip>' + U.escapeHtml(trade.symbol) + '</b></td>' +
          '<td><span class="side-badge ' + trade.side + '">' + (trade.side === 'long' ? 'Long' : 'Short') + '</span></td>' +
          '<td class="num">' + U.escapeHtml(U.price(trade.entry)) + '</td>' +
          '<td class="num">' + U.escapeHtml(exitText || '—') + '</td>' +
          '<td class="num">' + U.escapeHtml(U.qty(trade.qty)) + '</td>' +
          '<td class="num ' + (pnl !== null ? toneClass(pnl) : '') + '">' + (pnl !== null ? U.escapeHtml(U.money(pnl, { sign: true })) : '—') + '</td>' +
          '<td data-i18n-skip>' + U.escapeHtml(trade.setup || '—') + '</td>' +
          '</tr>';
      }).join('') + (result.trades.length > 200 ? '<tr><td colspan="8" class="csv-empty">Показаны первые 200 из ' + result.trades.length + ' строк</td></tr>' : '');
    }
    if (confirm) {
      confirm.disabled = !result.trades.length;
      confirm.textContent = result.trades.length ? 'Импортировать ' + result.trades.length : 'Импортировать';
    }
  }

  async function confirmCsvImport() {
    const data = state.csvImport;
    if (!data || !data.result.trades.length) return;
    const account = store.activeAccount();
    if (!account) return;
    const before = JSON.parse(JSON.stringify(store.state));
    const existing = new Set(account.trades.map(function (trade) { return NS.csv.fingerprint(trade); }).filter(Boolean));
    let added = 0;
    let skipped = 0;
    data.result.trades.forEach(function (raw) {
      const trade = store.normalizeTrade(raw, { timeZone: accountTimeZone() });
      if (!trade) return;
      const fingerprint = NS.csv.fingerprint(trade);
      if (fingerprint && existing.has(fingerprint)) {
        skipped++;
        return;
      }
      if (fingerprint) existing.add(fingerprint);
      account.trades.push(trade);
      added++;
    });
    if (!added) {
      toast('Новые сделки не найдены: все строки уже есть в журнале.', 'warn');
      closeModal('csvModal');
      return;
    }
    store.state.demo = false;
    const ok = await persist();
    if (!ok) {
      await store.replaceData(before);
      renderAll();
      toast('Импорт не сохранён: журнал оставлен прежним.', 'error');
      return;
    }
    closeModal('csvModal');
    state.csvImport = null;
    state.page = 1;
    applyCurrency();
    renderAll();
    toast('Импортировано сделок: ' + added + (skipped ? '. Пропущено дубликатов: ' + skipped : ''), 'success', {
      label: 'Отменить',
      onClick: async function () {
        const restored = await store.replaceData(before);
        applyCurrency();
        renderAll();
        toast(restored ? 'Импорт CSV отменён' : 'Не удалось отменить импорт', restored ? 'success' : 'error');
      }
    });
  }

  function importJSONFile(file) {
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) {
      toast('Файл слишком большой: максимум 200 МБ.', 'error');
      return;
    }
    const reader = new FileReader();
    if (file.name.toLowerCase().slice(-4) === '.zip') {
      reader.onload = function () {
        const buffer = reader.result;
        if (!(buffer instanceof ArrayBuffer)) {
          toast('Не удалось прочитать файл.', 'error');
          return;
        }
        importZipArchive(buffer);
      };
      reader.onerror = function () { toast('Не удалось открыть файл.', 'error'); };
      reader.readAsArrayBuffer(file);
      return;
    }
    reader.onload = function () {
      let data;
      try {
        data = JSON.parse(String(reader.result || ''));
      } catch (err) {
        toast('Не удалось прочитать файл: это не корректный JSON.', 'error');
        return;
      }
      importJSONData(data);
    };
    reader.onerror = function () { toast('Не удалось открыть файл.', 'error'); };
    reader.readAsText(file);
  }

  async function importZipArchive(arrayBuffer) {
    let data;
    try {
      data = await NS.zip.readJournal(arrayBuffer);
    } catch (err) {
      toast('Не удалось открыть ZIP-архив: ' + (err && err.message ? err.message : err), 'error');
      return;
    }
    importJSONData(data);
  }

  function importJSONData(data) {
    if (!store.isJournalData(data)) {
      toast('В файле нет корректных массивов сделок и записей. Похоже, это резервная копия другого формата.', 'error');
      return;
    }
    const currentTrades = store.state.accounts.reduce(function (sum, account) { return sum + account.trades.length; }, 0);
    const currentNotes = store.state.accounts.reduce(function (sum, account) { return sum + account.notes.length; }, 0);
    const stats = store.analyzeImport(data);
    const dropReasons = [];
    if (stats.missingSymbols) dropReasons.push('без символа: ' + stats.missingSymbols);
    if (stats.invalidDates) dropReasons.push('битая дата: ' + stats.invalidDates);
    const replacementSummary = 'Будет заменено ' + currentTrades + ' ' + pluralTrades(currentTrades) +
      ', ' + stats.tradesDropped + ' ' + pluralTrades(stats.tradesDropped) + ' отброшено' +
      (dropReasons.length ? ' (' + dropReasons.join(', ') + ')' : '') + '.';
    const details = [
      'Все счета, сделки и записи будут заменены данными из файла. Рекомендуем сначала сделать экспорт текущего журнала.',
      replacementSummary,
      'Сейчас: счетов ' + store.state.accounts.length + ', сделок ' + currentTrades + ', записей ' + currentNotes + '.',
      'В файле: счетов ' + stats.accounts + ', сделок ' + stats.trades + ', записей ' + stats.notes + ', скриншотов ' + stats.screenshots + '.',
      'Будет импортировано: сделок ' + stats.tradesAccepted + ', записей ' + stats.notesAccepted + ', скриншотов ' + stats.screenshotsAccepted + '.'
    ];
    if (stats.tradesDropped) {
      details.push('Отброшенные сделки не попадут в журнал: без символа импортировать нельзя, а битую дату не подменяем сегодняшней.');
    }
    if (stats.notesDropped) {
      details.push('Не будет импортировано записей: ' + stats.notesDropped + '.');
    }
    if (stats.screenshotsDropped) {
      const dropped = stats.screenshotsDropped;
      const singular = dropped % 10 === 1 && dropped % 100 !== 11;
      const reasons = [];
      if (stats.screenshotsTooLarge) reasons.push('слишком большой размер: ' + stats.screenshotsTooLarge);
      if (stats.screenshotsInvalid) reasons.push('неподдерживаемый формат: ' + stats.screenshotsInvalid);
      details.push('Внимание: ' + dropped + ' ' + pluralScreenshots(dropped) + (singular ? ' не будет импортирован' : ' не будут импортированы') + (reasons.length ? ' (' + reasons.join(', ') + ')' : '') + '. Эти скриншоты будут потеряны.');
    }
    if (stats.fileScreenshots) {
      details.push('Скриншотов-ссылок на файлы: ' + stats.fileScreenshots + '. Они откроются только на ПК, где создан бэкап.');
    }
    details.push('Сразу после импорта действие можно будет отменить.');

    askConfirm({
      title: 'Импортировать данные?',
      text: details.join(' '),
      okLabel: 'Импортировать'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      const before = JSON.parse(JSON.stringify(store.state));
      const ok = await store.replaceData(data, { strictDate: true });
      if (!ok) {
        await store.replaceData(before);
        applyCurrency();
        renderAll();
        toast('Импорт не сохранён: не удалось записать данные. Журнал оставлен прежним.', 'error');
        return;
      }
      await store.migrateScreenshots();
      clearAllDrafts();
      applyCurrency();
      state.calCursor = monthStart(new Date());
      state.selectedDay = todayInAccount();
      renderAll();
      const importedAccounts = store.state.accounts.length;
      const importedTrades = store.state.accounts.reduce(function (sum, account) { return sum + account.trades.length; }, 0);
      const importedNotes = store.state.accounts.reduce(function (sum, account) { return sum + account.notes.length; }, 0);
      let importedMessage = 'Импортировано: счетов ' + importedAccounts + ', сделок ' + importedTrades + ', записей ' + importedNotes;
      if (stats.screenshotsDropped) {
        importedMessage += '. Не импортировано скриншотов: ' + stats.screenshotsDropped;
      }
      toast(importedMessage, stats.screenshotsDropped ? 'warn' : 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          clearAllDrafts();
          applyCurrency();
          state.calCursor = monthStart(new Date());
          state.selectedDay = todayInAccount();
          renderAll();
          toast(restored ? 'Импорт отменён, прежние данные восстановлены' : 'Не удалось сохранить откат', restored ? 'success' : 'error');
        }
      });
    });
  }

  function loadDemoData() {
    askConfirm({
      title: 'Загрузить демо-данные?',
      text: 'Текущие сделки и записи активного счёта будут заменены примерами. В настройках счёт можно очистить в любой момент.',
      okLabel: 'Загрузить демо'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      const before = JSON.parse(JSON.stringify(store.state));
      const ok = await store.setDemo(NS.sample.generate());
      if (!ok) {
        await store.replaceData(before);
        renderAll();
        toast('Демо не сохранено: не удалось записать данные. Журнал оставлен прежним.', 'error');
        return;
      }
      clearAccountDrafts(store.state.activeAccountId);
      applyCurrency();
      state.calCursor = monthStart(new Date());
      state.selectedDay = todayInAccount();
      renderAll();
      toast('Демо-данные загружены', 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          clearAccountDrafts(store.state.activeAccountId);
          applyCurrency();
          state.calCursor = monthStart(new Date());
          state.selectedDay = todayInAccount();
          renderAll();
          toast(restored ? 'Демо-данные убраны, прежние восстановлены' : 'Не удалось сохранить откат', restored ? 'success' : 'error');
        }
      });
    });
  }

  function resetJournalData() {
    askConfirm({
      title: 'Очистить все данные?',
      text: 'Все сделки и записи активного счёта будут удалены. Настройки счёта и стартовый баланс сохранятся. Сразу после очистки действие можно будет отменить.',
      okLabel: 'Очистить всё'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      const before = JSON.parse(JSON.stringify(store.state));
      const ok = await store.resetData(true);
      if (!ok) {
        await store.replaceData(before);
        renderAll();
        toast('Очистка не сохранена: не удалось записать данные. Журнал оставлен прежним.', 'error');
        return;
      }
      clearAccountDrafts(store.state.activeAccountId);
      applyCurrency();
      state.calCursor = monthStart(new Date());
      state.selectedDay = todayInAccount();
      renderAll();
      toast('Журнал очищен. Начинаем с чистого листа.', 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          clearAccountDrafts(store.state.activeAccountId);
          applyCurrency();
          state.calCursor = monthStart(new Date());
          state.selectedDay = todayInAccount();
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

  const TRADE_FIELD_KEYS = ['date', 'time', 'symbol', 'entry', 'stop', 'currentStop', 'target', 'qty', 'multiplier', 'fees', 'setup', 'emotion', 'discipline', 'tags', 'notes', 'side', 'exits'];

  function tradeDraftKey(accountId, tradeId) {
    return DRAFT_PREFIX + String(accountId || '') + '.' + (tradeId || 'new');
  }

  function isScreenshotValue(value) {
    if (typeof value !== 'string' || value.length > 3000000) return false;
    return /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(value)
      || /^file:screenshots\/[a-z0-9_-]{1,80}\.(?:jpe?g|png|webp)$/i.test(value)
      || /^idb:screenshots\/[a-z0-9-]{1,80}$/i.test(value);
  }

  function normalizeExitRows(rows) {
    const result = [];
    (Array.isArray(rows) ? rows : []).slice(0, store.MAX_EXITS || 50).forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      const qty = row.qty === null || row.qty === undefined ? '' : String(row.qty).slice(0, 40);
      const price = row.price === null || row.price === undefined ? '' : String(row.price).slice(0, 40);
      const date = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
      result.push({
        id: row.id ? String(row.id) : U.uid(),
        qty: qty,
        price: price,
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
      });
    });
    return result;
  }

  function exitsFromField(value) {
    if (!value) return [];
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return normalizeExitRows(parsed);
    } catch (err) {
      return [];
    }
  }

  function exitsToField(rows) {
    return JSON.stringify(normalizeExitRows(rows).map(function (row) {
      return { qty: row.qty, price: row.price, date: row.date };
    }));
  }

  function tradeFieldsFromTrade(trade, presetDate) {
    const timeZone = accountTimeZone();
    return {
      date: trade ? trade.date : (presetDate || U.todayISO(timeZone)),
      time: trade ? (trade.time || '') : U.nowTime(timeZone),
      symbol: trade ? trade.symbol : '',
      entry: trade && trade.entry !== null && trade.entry !== undefined ? String(trade.entry) : '',
      stop: trade && trade.stop !== null && trade.stop !== undefined ? String(trade.stop) : '',
      currentStop: trade && trade.currentStop !== null && trade.currentStop !== undefined ? String(trade.currentStop) : '',
      target: trade && trade.target !== null && trade.target !== undefined ? String(trade.target) : '',
      qty: trade && trade.qty !== null && trade.qty !== undefined ? String(trade.qty) : '',
      multiplier: String(trade && trade.multiplier !== null && trade.multiplier !== undefined ? trade.multiplier : 1),
      fees: trade && trade.fees !== null && trade.fees !== undefined ? String(trade.fees) : '',
      setup: trade ? (trade.setup || '') : '',
      emotion: trade ? (trade.emotion || '') : '',
      discipline: String(trade ? (trade.discipline || 0) : 0),
      tags: trade ? trade.tags.join(', ') : '',
      notes: trade ? (trade.notes || '') : '',
      side: trade ? trade.side : 'long',
      exits: exitsToField(trade ? store.tradeExits(trade) : [])
    };
  }

  function readTradeFields() {
    return {
      date: $('#tradeDate').value,
      time: $('#tradeTime').value,
      symbol: $('#tradeSymbol').value,
      entry: $('#tradeEntry').value,
      stop: $('#tradeStop').value,
      currentStop: $('#tradeCurrentStop').value,
      target: $('#tradeTarget').value,
      qty: $('#tradeQty').value,
      multiplier: $('#tradeMultiplier').value,
      fees: $('#tradeFees').value,
      setup: $('#tradeSetup').value,
      emotion: $('#tradeEmotion').value,
      discipline: $('#tradeDiscipline').value,
      tags: $('#tradeTags').value,
      notes: $('#tradeNotes').value,
      side: $('#tradeSide').value,
      exits: exitsToField(state.tradeExits)
    };
  }

  function sameTradeFields(left, right) {
    return TRADE_FIELD_KEYS.every(function (key) {
      return String(left[key] === undefined || left[key] === null ? '' : left[key])
        === String(right[key] === undefined || right[key] === null ? '' : right[key]);
    });
  }

  function normalizeDraftFields(fields, baseline) {
    const result = Object.assign({}, baseline);
    if (!fields || typeof fields !== 'object') return result;
    TRADE_FIELD_KEYS.forEach(function (key) {
      if (typeof fields[key] !== 'string') return;
      const max = key === 'notes' ? 20000 : (key === 'tags' ? 2000 : (key === 'exits' ? 20000 : 200));
      result[key] = fields[key].slice(0, max);
    });
    result.exits = exitsToField(exitsFromField(result.exits));
    result.multiplier = result.multiplier || '1';
    result.side = result.side === 'short' ? 'short' : 'long';
    result.discipline = String(U.clamp(Math.round(U.parseNum(result.discipline) || 0), 0, 5));
    return result;
  }

  function setTradeExits(rows) {
    state.tradeExits = normalizeExitRows(rows);
  }

  function renderExitsEditor() {
    const editor = $('#exitsEditor');
    if (!editor) return;
    if (!state.tradeExits.length) {
      editor.innerHTML = '<div class="exits-empty">Выходов пока нет — позиция открыта</div>';
      updateExitsSummary();
      return;
    }
    editor.innerHTML = state.tradeExits.map(function (row, index) {
      return '<div class="exit-row" data-exit-index="' + index + '">' +
        '<input type="number" step="any" min="0" inputmode="decimal" data-exit-field="qty" value="' + U.escapeHtml(row.qty) + '" placeholder="Количество" aria-label="Количество выхода ' + (index + 1) + '">' +
        '<input type="number" step="any" inputmode="decimal" data-exit-field="price" value="' + U.escapeHtml(row.price) + '" placeholder="Цена выхода" aria-label="Цена выхода ' + (index + 1) + '">' +
        '<input type="date" data-exit-field="date" data-exit-date value="' + U.escapeHtml(row.date) + '" aria-label="Дата выхода ' + (index + 1) + '">' +
        '<button type="button" class="icon-btn exit-remove" data-remove-exit="' + index + '" title="Удалить выход" aria-label="Удалить выход">×</button>' +
        '</div>';
    }).join('');
    updateExitsSummary();
  }

  function exitRowsTotals() {
    let qty = 0;
    const quantity = U.parseNum($('#tradeQty') ? $('#tradeQty').value : null);
    state.tradeExits.forEach(function (row) {
      const value = U.parseNum(row.qty);
      if (value !== null && value > 0) qty += value;
    });
    const fees = U.parseNum($('#tradeFees') ? $('#tradeFees').value : null) || 0;
    return { qty: qty, remaining: quantity === null ? null : quantity - qty, fees: fees };
  }

  function updateExitsSummary() {
    const hint = $('#exitsHint');
    const closeButton = $('#closeRemainingBtn');
    if (!hint) return;
    const totals = exitRowsTotals();
    const quantity = U.parseNum($('#tradeQty') ? $('#tradeQty').value : null);
    const epsilon = store.QTY_EPSILON || 1e-9;
    let text;
    if (!state.tradeExits.length) {
      text = 'Выходов нет — позиция открыта. Добавьте один или несколько частичных выходов; комиссия распределится по объёму выходов.';
    } else if (quantity === null || quantity <= 0) {
      text = 'Укажите количество в сделке, чтобы рассчитать остаток позиции.';
    } else if (totals.qty > quantity + epsilon) {
      text = 'Сумма выходов ' + U.qty(totals.qty) + ' больше количества ' + U.qty(quantity) + '. Уменьшите объём выходов.';
    } else if (totals.remaining <= epsilon) {
      text = 'Позиция закрыта полностью: ' + U.qty(totals.qty) + ' из ' + U.qty(quantity) + '.';
    } else {
      text = 'Закрыто ' + U.qty(totals.qty) + ' из ' + U.qty(quantity) + ', остаток ' + U.qty(totals.remaining) + '. Сделка останется частично открытой.';
    }
    if (totals.fees > 0 && state.tradeExits.length) {
      if (quantity !== null && quantity > 0 && totals.remaining <= epsilon) {
        text += ' Комиссия ' + U.money(totals.fees) + ' распределится между выходами пропорционально количеству.';
      } else {
        text += ' Комиссия ' + U.money(totals.fees) + ' распределится по закрытому объёму: спишется только доля выходов, остаток — при следующем выходе.';
      }
    }
    hint.textContent = text;
    if (closeButton) {
      closeButton.disabled = quantity === null || quantity <= 0 || totals.remaining <= epsilon;
    }
  }

  function applyTradeFields(fields) {
    $('#tradeDate').value = fields.date || '';
    $('#tradeTime').value = fields.time || '';
    $('#tradeSymbol').value = fields.symbol || '';
    $('#tradeEntry').value = fields.entry || '';
    $('#tradeStop').value = fields.stop || '';
    $('#tradeCurrentStop').value = fields.currentStop || '';
    $('#tradeTarget').value = fields.target || '';
    $('#tradeQty').value = fields.qty || '';
    $('#tradeMultiplier').value = fields.multiplier || '1';
    $('#tradeFees').value = fields.fees || '';
    $('#tradeSetup').value = fields.setup || '';
    $('#tradeEmotion').value = fields.emotion || '';
    $('#tradeTags').value = fields.tags || '';
    $('#tradeNotes').value = fields.notes || '';
    setTradeExits(exitsFromField(fields.exits));
    renderExitsEditor();
    setSide(fields.side);
    setDiscipline(Number(fields.discipline) || 0);
  }

  function addExitRow(qty, price) {
    if (state.tradeExits.length >= (store.MAX_EXITS || 50)) {
      toast('Слишком много выходов: максимум ' + (store.MAX_EXITS || 50) + '.', 'warn');
      return;
    }
    state.tradeExits.push({
      id: U.uid(),
      qty: qty === undefined || qty === null ? '' : String(qty),
      price: price === undefined || price === null ? '' : String(price),
      date: $('#tradeDate').value || U.todayISO(accountTimeZone())
    });
    renderExitsEditor();
    const row = $('#exitsEditor .exit-row:last-child');
    const target = row && row.querySelector(qty === undefined ? '[data-exit-field="qty"]' : '[data-exit-field="price"]');
    if (target) target.focus();
    updateTradePreview();
    syncTradeDirty();
  }

  function closeRemainingExit() {
    const quantity = U.parseNum($('#tradeQty').value);
    if (quantity === null || quantity <= 0) {
      toast('Сначала укажите количество в сделке.', 'warn');
      return;
    }
    const totals = exitRowsTotals();
    const epsilon = store.QTY_EPSILON || 1e-9;
    if (totals.remaining <= epsilon) {
      toast('Позиция уже закрыта полностью.', 'warn');
      return;
    }
    const lastPrice = state.tradeExits.length ? state.tradeExits[state.tradeExits.length - 1].price : '';
    addExitRow(totals.remaining, lastPrice);
  }

  function removeExitRow(index) {
    if (index < 0 || index >= state.tradeExits.length) return;
    state.tradeExits.splice(index, 1);
    renderExitsEditor();
    updateTradePreview();
    syncTradeDirty();
  }

  function updateDraftUi() {
    const badge = $('#draftBadge');
    const reset = $('#discardDraftBtn');
    if (badge) badge.hidden = !state.tradeDirty;
    if (reset) reset.classList.toggle('hidden', !state.tradeDirty);
  }

  function syncTradeDirty() {
    if (state.tradeInitializing || !state.tradeBaseline) return;
    const dirty = !sameTradeFields(readTradeFields(), state.tradeBaseline)
      || (state.screenshot || '') !== (state.tradeBaselineScreenshot || '');
    state.tradeDirty = dirty;
    updateDraftUi();
    if (dirty) scheduleTradeDraft();
    else clearCurrentTradeDraft();
  }

  function scheduleTradeDraft() {
    clearTimeout(state.tradeDraftTimer);
    state.tradeDraftTimer = setTimeout(writeTradeDraft, 450);
  }

  function writeTradeDraft() {
    if (!state.tradeBaseline || state.tradeInitializing) return;
    if (!state.tradeDirty) {
      clearCurrentTradeDraft();
      return;
    }
    const accountId = state.tradeAccountId || store.state.activeAccountId;
    if (!accountId) return;
    const payload = {
      savedAt: new Date().toISOString(),
      accountId: accountId,
      tradeId: state.tradeId || '',
      fields: readTradeFields(),
      screenshot: state.screenshot || ''
    };

    let serialized = JSON.stringify(payload);
    state.draftScreenshotOmitted = false;
    if (serialized.length > DRAFT_MAX_CHARS && payload.screenshot) {
      payload.screenshot = '';
      payload.screenshotOmitted = true;
      state.draftScreenshotOmitted = true;
      serialized = JSON.stringify(payload);
      if (!state.draftShotWarned) {
        state.draftShotWarned = true;
        toast('Скриншот слишком большой для черновика: если закрыть форму, он не сохранится. Сохраните сделку, чтобы не потерять изображение.', 'warn');
      }
    }

    if (serialized.length > DRAFT_MAX_CHARS) {
      if (!state.draftQuotaWarned) {
        state.draftQuotaWarned = true;
        toast('Не удалось сохранить черновик: данных слишком много для хранилища браузера.', 'warn');
      }
      return;
    }

    try {
      localStorage.setItem(tradeDraftKey(accountId, state.tradeId), serialized);
      state.draftQuotaWarned = false;
    } catch (err) {
      if (!state.draftQuotaWarned) {
        state.draftQuotaWarned = true;
        toast('Не удалось сохранить черновик: хранилище браузера заполнено.', 'warn');
      }
    }
  }

  function saveDraftNow() {
    clearTimeout(state.tradeDraftTimer);
    state.tradeDraftTimer = null;
    writeTradeDraft();
  }

  function readTradeDraft(accountId, tradeId) {
    try {
      const raw = localStorage.getItem(tradeDraftKey(accountId, tradeId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.fields || typeof parsed.fields !== 'object') return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function clearTradeDraft(tradeId, accountId) {
    const id = accountId || state.tradeAccountId || store.state.activeAccountId;
    if (!id) return;
    try { localStorage.removeItem(tradeDraftKey(id, tradeId)); } catch (err) { /* ignore */ }
  }

  function clearCurrentTradeDraft() {
    clearTradeDraft(state.tradeId, state.tradeAccountId);
    if (state.tradeOriginalId !== state.tradeId) {
      clearTradeDraft(state.tradeOriginalId, state.tradeAccountId);
    }
  }

  function clearAccountDrafts(accountId) {
    if (!accountId) return;
    const prefix = DRAFT_PREFIX + String(accountId) + '.';
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.indexOf(prefix) === 0) keys.push(key);
      }
      keys.forEach(function (key) { localStorage.removeItem(key); });
    } catch (err) { /* ignore */ }
  }

  function clearAllDrafts() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.indexOf(DRAFT_PREFIX) === 0) keys.push(key);
      }
      keys.forEach(function (key) { localStorage.removeItem(key); });
    } catch (err) { /* ignore */ }
  }

  function openTradeModal(id, presetDate) {
    closeShotLightbox();
    $('#shotField').classList.remove('is-dragover');
    const accountId = store.state.activeAccountId;
    const trade = id ? store.state.trades.find(function (t) { return t.id === id; }) : null;

    state.tradeInitializing = true;
    state.tradeAccountId = accountId;
    state.tradeId = trade ? trade.id : null;
    state.tradeOriginalId = trade ? trade.id : null;
    state.tradeBaseline = tradeFieldsFromTrade(trade, presetDate);
    state.tradeBaselineScreenshot = trade && trade.screenshot ? trade.screenshot : '';
    state.screenshot = state.tradeBaselineScreenshot;
    state.screenshotPreview = '';
    state.tradeDirty = false;
    state.tradeSaving = false;
    state.screenshotBusy = false;
    state.draftShotWarned = false;
    state.draftScreenshotOmitted = false;

    $('#tradeModalTitleText').textContent = trade ? 'Редактировать сделку' : 'Новая сделка';
    applyTradeFields(state.tradeBaseline);

    let restored = false;
    const draft = readTradeDraft(accountId, trade ? trade.id : null);
    if (draft) {
      const fields = normalizeDraftFields(draft.fields, state.tradeBaseline);
      const draftShot = isScreenshotValue(draft.screenshot) ? draft.screenshot : state.tradeBaselineScreenshot;
      if (!sameTradeFields(fields, state.tradeBaseline) || draftShot !== state.tradeBaselineScreenshot) {
        applyTradeFields(fields);
        state.screenshot = draftShot;
        restored = true;
      } else {
        clearTradeDraft(trade ? trade.id : null, accountId);
      }
    }

    $('#tradeError').hidden = true;
    $('#deleteTradeBtn').classList.toggle('hidden', !trade);
    $('#saveTradeBtn').textContent = trade ? 'Сохранить изменения' : 'Сохранить сделку';
    $('#saveTradeBtn').disabled = false;
    $('#tradeShot').value = '';
    state.tradeInitializing = false;
    renderShotPreview();
    updateTradePreview();
    syncTradeDirty();
    openModal('tradeModal', '#tradeSymbol');
    if (restored) {
      toast(
        draft && draft.screenshotOmitted
          ? 'Черновик восстановлен без скриншота: изображение слишком большое для автосохранения.'
          : 'Черновик восстановлен',
        draft && draft.screenshotOmitted ? 'warn' : 'success'
      );
    }
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

  let shotPreviewToken = 0;
  let shotLightboxToken = 0;

  function renderShotPreview() {
    const box = $('#shotPreview');
    const remove = $('#removeShot');
    if (!box || !remove) return;
    const token = ++shotPreviewToken;
    box.innerHTML = '';
    state.screenshotPreview = '';

    if (!state.screenshot) {
      box.classList.remove('has');
      remove.classList.add('hidden');
      return;
    }

    box.classList.add('has');
    remove.classList.remove('hidden');
    const loading = document.createElement('span');
    loading.className = 'shot-loading';
    loading.textContent = 'Загрузка…';
    box.appendChild(loading);

    store.screenshotSource(state.screenshot).then(function (source) {
      if (token !== shotPreviewToken) return;
      box.innerHTML = '';
      if (!source) {
        const missing = document.createElement('span');
        missing.className = 'shot-loading';
        missing.textContent = 'Файл скриншота не найден';
        box.appendChild(missing);
        return;
      }
      state.screenshotPreview = source;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'shot-open';
      button.title = 'Открыть скриншот на весь экран';
      button.setAttribute('aria-label', 'Открыть скриншот в полном размере');
      button.addEventListener('click', openShotLightbox);
      const image = document.createElement('img');
      image.src = source;
      image.alt = 'Скриншот сделки';
      button.appendChild(image);
      box.appendChild(button);
    }).catch(function () {
      if (token !== shotPreviewToken) return;
      box.innerHTML = '<span class="shot-loading">Не удалось загрузить скриншот</span>';
    });
  }

  function openScreenshotLightbox(value, focusElement) {
    if (!value) return;
    const lightbox = $('#shotLightbox');
    const image = $('#shotLightboxImage');
    if (!lightbox || !image) return;
    state.shotFocus = focusElement || document.activeElement;
    const token = ++shotLightboxToken;
    image.removeAttribute('src');
    image.alt = 'Загрузка скриншота';
    lightbox.hidden = false;
    $('#shotLightboxClose').focus();
    store.screenshotSource(value).then(function (source) {
      if (token !== shotLightboxToken || lightbox.hidden || !source) return;
      image.src = source;
      image.alt = 'Скриншот сделки';
    });
  }

  function openShotLightbox() {
    if (!state.screenshot) return;
    if (state.screenshotPreview) {
      const lightbox = $('#shotLightbox');
      const image = $('#shotLightboxImage');
      if (!lightbox || !image) return;
      state.shotFocus = document.activeElement;
      shotLightboxToken++;
      image.src = state.screenshotPreview;
      image.alt = 'Скриншот сделки';
      lightbox.hidden = false;
      $('#shotLightboxClose').focus();
      return;
    }
    openScreenshotLightbox(state.screenshot, document.activeElement);
  }

  function openTradeScreenshot(tradeId, focusElement) {
    const trade = store.state.trades.find(function (item) { return item.id === tradeId; });
    if (!trade || !trade.screenshot) return;
    openScreenshotLightbox(trade.screenshot, focusElement);
  }

  function closeShotLightbox() {
    shotLightboxToken++;
    const lightbox = $('#shotLightbox');
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    $('#shotLightboxImage').removeAttribute('src');
    let focus = state.shotFocus;
    state.shotFocus = null;
    if (!focus || focus === document.body || !document.contains(focus)) {
      focus = $('#shotPreview .shot-open');
    }
    if (focus && document.contains(focus)) {
      try { focus.focus(); } catch (err) { /* ignore */ }
    }
  }

  async function applyScreenshot(dataUrl) {
    if (state.screenshotBusy) return;
    state.screenshotBusy = true;
    const saveButton = $('#saveTradeBtn');
    if (saveButton) saveButton.disabled = true;
    try {
      state.screenshot = await store.saveScreenshot(dataUrl);
      renderShotPreview();
      syncTradeDirty();
      toast('Скриншот добавлен');
    } catch (err) {
      toast(err && err.message ? err.message : 'Не удалось сохранить скриншот.', 'error');
    } finally {
      state.screenshotBusy = false;
      if (saveButton && !state.tradeSaving) saveButton.disabled = false;
    }
  }

  let webpEncodeSupport = null;

  function supportsWebpEncoding() {
    if (webpEncodeSupport === null) {
      try {
        webpEncodeSupport = document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0;
      } catch (err) {
        webpEncodeSupport = false;
      }
    }
    return webpEncodeSupport;
  }

  function encodeLossyScreenshot(canvas, maxChars) {
    const mime = supportsWebpEncoding() ? 'image/webp' : 'image/jpeg';
    let quality = SHOT_LOSSY_QUALITY;
    let dataUrl = canvas.toDataURL(mime, quality);
    while (dataUrl.length > maxChars && quality > 0.56) {
      quality = Math.max(0.56, quality - 0.06);
      dataUrl = canvas.toDataURL(mime, quality);
    }
    return dataUrl;
  }

  function encodeScreenshot(canvas) {
    if (!desktop) return encodeLossyScreenshot(canvas, SHOT_MAX_CHARS_WEB);
    const png = canvas.toDataURL('image/png');
    if (png.length <= SHOT_PNG_MAX_CHARS_DESKTOP) return png;
    return encodeLossyScreenshot(canvas, SHOT_MAX_CHARS_DESKTOP);
  }

  function compressScreenshot(file) {
    if (!file) return;
    if (state.screenshotBusy) {
      toast('Дождитесь окончания сохранения скриншота.', 'warn');
      return;
    }
    if (!/^image\//.test(file.type)) {
      toast('Можно прикрепить только изображение.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = function () {
      const image = new Image();
      image.onload = function () {
        const maxSide = desktop ? SHOT_MAX_SIDE_DESKTOP : SHOT_MAX_SIDE_WEB;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
          applyScreenshot(encodeScreenshot(canvas));
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

  async function pasteScreenshotFromClipboard() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      toast('Нажмите Ctrl+V, чтобы вставить скриншот из буфера.', 'warn');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(function (value) { return value.indexOf('image/') === 0; });
        if (!type) continue;
        const blob = await item.getType(type);
        compressScreenshot(new File([blob], 'clipboard.' + (type.split('/')[1] || 'png'), { type: type }));
        return;
      }
      toast('В буфере обмена нет изображения.', 'warn');
    } catch (err) {
      toast('Не удалось прочитать буфер. Нажмите Ctrl+V.', 'warn');
    }
  }

  function handleScreenshotPaste(event) {
    if (event.defaultPrevented) return;
    if (isTyping(event.target)) return;
    const modal = $('#tradeModal');
    if (!modal || modal.hidden) return;
    const data = event.clipboardData;
    if (!data) return;
    let file = null;
    if (data.items) {
      for (const item of data.items) {
        if (item.kind === 'file' && item.type.indexOf('image/') === 0) {
          file = item.getAsFile();
          if (file) break;
        }
      }
    }
    if (!file && data.files) {
      file = Array.prototype.find.call(data.files, function (item) {
        return item.type.indexOf('image/') === 0;
      }) || null;
    }
    if (!file) return;
    event.preventDefault();
    compressScreenshot(file);
  }

  function updateTradePreview() {
    const side = $('#tradeSide').value;
    const entry = U.parseNum($('#tradeEntry').value);
    const stop = U.parseNum($('#tradeStop').value);
    const target = U.parseNum($('#tradeTarget').value);
    const qty = U.parseNum($('#tradeQty').value);
    const multiplier = store.normalizeMultiplier($('#tradeMultiplier').value);
    const fees = U.parseNum($('#tradeFees').value) || 0;
    const exits = [];
    state.tradeExits.forEach(function (row) {
      const exitQty = U.parseNum(row.qty);
      const exitPrice = U.parseNum(row.price);
      if (exitQty !== null && exitQty > 0 && exitPrice !== null) {
        exits.push({ qty: exitQty, price: exitPrice, date: row.date || '' });
      }
    });

    const preview = {
      side: side,
      entry: entry,
      exit: null,
      stop: stop,
      target: target,
      qty: qty,
      multiplier: multiplier,
      fees: fees,
      exits: exits.map(function (exit) { return Object.assign({}, exit); })
    };
    store.allocateExitFees(preview.exits, fees, qty);
    const pnl = store.tradePnl(preview);
    const risk = store.tradeRisk(preview);
    const r = pnl !== null && risk !== null && risk > 0 ? pnl / risk : null;
    const rr = store.plannedRR(preview);
    const remaining = qty !== null ? qty - exits.reduce(function (sum, exit) { return sum + exit.qty; }, 0) : null;

    const pnlEl = $('#previewPnl');
    if (!exits.length) {
      pnlEl.textContent = entry !== null && qty !== null ? 'Открыта' : '—';
      pnlEl.className = entry !== null && qty !== null ? 'neutral' : '';
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

    $('#previewRR').textContent = rr !== null ? '1 : ' + decimal(rr, 2) : '—';
    $('#previewRR').className = '';

    const remainingEl = $('#previewRemaining');
    if (remainingEl) {
      const epsilon = store.QTY_EPSILON || 1e-9;
      if (qty === null || qty <= 0) remainingEl.textContent = '—';
      else if (!exits.length) remainingEl.textContent = U.qty(qty) + ' открыто';
      else if (remaining <= epsilon) remainingEl.textContent = 'Закрыта';
      else remainingEl.textContent = U.qty(remaining) + ' остаток';
      remainingEl.className = remaining !== null && remaining > epsilon && exits.length ? 'neutral' : '';
    }
    updateExitsSummary();
  }

  function collectExitRows(tradeDate) {
    const exits = [];
    for (let i = 0; i < state.tradeExits.length; i++) {
      const row = state.tradeExits[i];
      const qtyRaw = String(row.qty === undefined || row.qty === null ? '' : row.qty).trim();
      const priceRaw = String(row.price === undefined || row.price === null ? '' : row.price).trim();
      if (!qtyRaw && !priceRaw && !row.date) continue;
      const qty = U.parseNum(qtyRaw);
      const price = U.parseNum(priceRaw);
      if (qty === null || qty <= 0) return { error: 'Выход ' + (i + 1) + ': количество должно быть больше нуля.' };
      if (price === null) return { error: 'Выход ' + (i + 1) + ': укажите цену выхода.' };
      exits.push({
        id: row.id,
        qty: qty,
        price: price,
        date: row.date || tradeDate
      });
    }
    return { exits: exits };
  }

  async function saveTrade(event) {
    event.preventDefault();
    if (state.tradeSaving) return;
    if (state.screenshotBusy) {
      toast('Скриншот ещё сохраняется, подождите пару секунд.', 'warn');
      return;
    }

    const date = $('#tradeDate').value;
    const symbol = $('#tradeSymbol').value.trim().toUpperCase();
    const entry = U.parseNum($('#tradeEntry').value);
    const qty = U.parseNum($('#tradeQty').value);
    const multiplierRaw = $('#tradeMultiplier').value.trim();
    const multiplier = multiplierRaw === '' ? 1 : U.parseNum(multiplierRaw);
    const stopRaw = $('#tradeStop').value.trim();
    const currentStopRaw = $('#tradeCurrentStop').value.trim();
    const targetRaw = $('#tradeTarget').value.trim();
    const stop = stopRaw === '' ? null : U.parseNum(stopRaw);
    const currentStop = currentStopRaw === '' ? null : U.parseNum(currentStopRaw);
    const target = targetRaw === '' ? null : U.parseNum(targetRaw);
    const fees = U.parseNum($('#tradeFees').value) || 0;
    const side = $('#tradeSide').value === 'short' ? 'short' : 'long';
    const collected = collectExitRows(date);
    const exits = collected.exits || [];

    let error = collected.error || '';
    if (!error && !date) error = 'Укажите дату сделки.';
    else if (!error && !symbol) error = 'Укажите инструмент (например, EURUSD).';
    else if (!error && entry === null) error = 'Укажите цену входа.';
    else if (!error && (qty === null || qty <= 0)) error = 'Количество должно быть больше нуля.';
    else if (!error && (multiplier === null || multiplier <= 0)) error = 'Множитель контракта должен быть больше нуля.';
    else if (!error && fees < 0) error = 'Комиссия не может быть отрицательной.';
    else if (!error && stop !== null && Math.abs(stop - entry) < 1e-12) error = 'Стоп при входе не может совпадать с ценой входа.';
    else if (!error && stop !== null && side === 'long' && stop > entry) error = 'Для Long стоп при входе должен быть ниже цены входа.';
    else if (!error && stop !== null && side === 'short' && stop < entry) error = 'Для Short стоп при входе должен быть выше цены входа.';
    else if (!error && target !== null && side === 'long' && target <= entry) error = 'Для Long тейк-профит должен быть выше цены входа.';
    else if (!error && target !== null && side === 'short' && target >= entry) error = 'Для Short тейк-профит должен быть ниже цены входа.';
    else if (!error && exits.reduce(function (sum, exit) { return sum + exit.qty; }, 0) > qty + (store.QTY_EPSILON || 1e-9)) {
      error = 'Сумма частичных выходов больше количества в сделке.';
    }

    if (error) {
      $('#tradeError').hidden = false;
      $('#tradeError').textContent = error;
      return;
    }

    const accountId = state.tradeAccountId || store.state.activeAccountId;
    const draftTradeId = state.tradeId;
    const existing = state.tradeId ? store.state.trades.find(function (t) { return t.id === state.tradeId; }) : null;
    const saveButton = $('#saveTradeBtn');
    state.tradeSaving = true;
    if (saveButton) saveButton.disabled = true;

    try {
      if (!existing) {
        const limitWarning = dailyLimitWarning(date);
        if (limitWarning) {
          const proceed = await askConfirm({
            title: limitWarning.title,
            text: limitWarning.text,
            okLabel: 'Добавить всё равно',
            danger: false
          });
          if (!proceed) return;
        }
      }

      let screenshot = state.screenshot || '';
      if (desktop && screenshot && !/^file:screenshots\//i.test(screenshot)) {
        screenshot = await store.saveScreenshot(screenshot);
        state.screenshot = screenshot;
        renderShotPreview();
      }

      const trade = store.normalizeTrade({
        id: existing ? existing.id : U.uid(),
        date: date,
        time: $('#tradeTime').value,
        symbol: symbol,
        side: side,
        entry: entry,
        exit: null,
        stop: stop,
        currentStop: currentStop,
        target: target,
        qty: qty,
        multiplier: multiplier,
        fees: fees,
        exits: exits,
        setup: $('#tradeSetup').value.trim(),
        emotion: $('#tradeEmotion').value,
        discipline: Number($('#tradeDiscipline').value) || 0,
        tags: splitTags($('#tradeTags').value),
        notes: $('#tradeNotes').value.trim(),
        screenshot: screenshot
      }, { timeZone: accountTimeZone() });
      if (!trade) throw new Error('Не удалось подготовить сделку к сохранению.');

      if (existing) {
        const index = store.state.trades.findIndex(function (t) { return t.id === existing.id; });
        if (index !== -1) store.state.trades[index] = trade;
      } else {
        store.state.trades.push(trade);
        state.tradeId = trade.id;
        $('#tradeModalTitleText').textContent = 'Редактировать сделку';
        $('#deleteTradeBtn').classList.remove('hidden');
        $('#saveTradeBtn').textContent = 'Сохранить изменения';
      }

      store.state.demo = false;
      const ok = await persist();
      if (!ok) {
        $('#tradeError').hidden = false;
        $('#tradeError').textContent = 'Сделка добавлена в текущую сессию, но сохранить её не удалось. Проверьте свободное место и папку данных, затем попробуйте ещё раз.';
        saveDraftNow();
        return;
      }

      clearTradeDraft(draftTradeId, accountId);
      clearTradeDraft(state.tradeOriginalId, accountId);
      clearTradeDraft(trade.id, accountId);
      state.tradeDirty = false;
      state.tradeBaseline = tradeFieldsFromTrade(trade);
      state.tradeBaselineScreenshot = trade.screenshot || '';
      state.screenshot = trade.screenshot || '';
      state.tradeId = trade.id;
      updateDraftUi();
      closeModal('tradeModal');
      renderAll();
      toast(existing ? 'Сделка обновлена' : 'Сделка добавлена');
    } catch (err) {
      $('#tradeError').hidden = false;
      $('#tradeError').textContent = err && err.message ? err.message : 'Не удалось сохранить сделку.';
      saveDraftNow();
    } finally {
      state.tradeSaving = false;
      if (saveButton) saveButton.disabled = false;
    }
  }

  function requestCloseTradeModal() {
    const modal = $('#tradeModal');
    if (!modal || modal.hidden) return;
    if (state.tradeSaving) return;
    if (state.screenshotBusy) {
      toast('Скриншот ещё сохраняется, подождите пару секунд.', 'warn');
      return;
    }
    if (!state.tradeDirty) {
      clearCurrentTradeDraft();
      closeModal('tradeModal');
      return;
    }
    saveDraftNow();
    askConfirm({
      title: 'Закрыть форму сделки?',
      text: state.draftScreenshotOmitted
        ? 'Текст будет сохранён как черновик. Скриншот слишком большой для черновика и не сохранится — сохраните сделку, чтобы не потерять изображение.'
        : 'Введённые данные сохранены как черновик. Они восстановятся, когда вы снова откроете эту сделку.',
      okLabel: 'Закрыть',
      danger: false
    }).then(function (confirmed) {
      if (!confirmed) return;
      closeModal('tradeModal');
    });
  }

  function discardTradeDraft() {
    if (state.tradeSaving || state.tradeInitializing) return;
    clearCurrentTradeDraft();
    state.screenshot = state.tradeBaselineScreenshot || '';
    state.screenshotPreview = '';
    applyTradeFields(state.tradeBaseline || tradeFieldsFromTrade(null));
    state.tradeDirty = false;
    updateDraftUi();
    renderShotPreview();
    updateTradePreview();
    toast('Черновик сброшен');
  }

  function handleTradeFormChanged() {
    if (state.tradeInitializing) return;
    updateTradePreview();
    syncTradeDirty();
  }

  function deleteTrade() {
    if (!state.tradeId) return;
    const trade = store.state.trades.find(function (t) { return t.id === state.tradeId; });
    if (!trade) return;
    askConfirm({
      title: 'Удалить сделку?',
      text: 'Сделка ' + trade.symbol + ' от ' + U.formatDate(trade.date, 'long') + ' будет удалена. Сразу после удаления действие можно будет отменить.',
      okLabel: 'Удалить'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      const index = store.state.trades.findIndex(function (t) { return t.id === trade.id; });
      store.state.trades = store.state.trades.filter(function (t) { return t.id !== trade.id; });
      const ok = await persist();
      if (!ok) {
        store.state.trades.splice(Math.max(0, index), 0, trade);
        renderAll();
        toast('Не удалось удалить сделку: данные не сохранены.', 'error');
        return;
      }
      clearTradeDraft(trade.id, state.tradeAccountId || store.state.activeAccountId);
      closeModal('tradeModal');
      renderAll();
      toast('Сделка удалена', 'success', {
        label: 'Отменить',
        onClick: async function () {
          if (!store.state.trades.some(function (t) { return t.id === trade.id; })) {
            store.state.trades.splice(Math.min(Math.max(0, index), store.state.trades.length), 0, trade);
          }
          const restored = await persist();
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
        '<span class="m-emoji">' + mood.emoji + '</span>' + U.escapeHtml(U.moodMeta(key).label) + '</button>';
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
    $('#noteModalTitle').textContent = note ? T('Редактировать запись') : T('Новая запись');
    $('#noteDate').value = note ? note.date : (presetDate || todayInAccount());
    $('#noteTitle').value = note ? (note.title || '') : '';
    $('#noteText').value = note ? note.text : '';
    $('#noteTags').value = note ? note.tags.join(', ') : '';
    setNoteMood(note ? note.mood : 'neutral');
    $('#noteError').hidden = true;
    $('#deleteNoteBtn').classList.toggle('hidden', !note);
    $('#saveNoteBtn').textContent = note ? 'Сохранить изменения' : 'Сохранить запись';
    openModal('noteModal', '#noteText');
  }

  async function saveNote(event) {
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
      $('#noteModalTitle').textContent = T(note ? 'Редактировать запись' : 'Новая запись');
      $('#deleteNoteBtn').classList.remove('hidden');
      $('#saveNoteBtn').textContent = 'Сохранить изменения';
    }

    store.state.demo = false;
    const ok = await persist();
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
    }).then(async function (confirmed) {
      if (!confirmed) return;
      const index = store.state.notes.findIndex(function (n) { return n.id === id; });
      store.state.notes = store.state.notes.filter(function (n) { return n.id !== id; });
      const ok = await persist();
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
        onClick: async function () {
          if (!store.state.notes.some(function (n) { return n.id === note.id; })) {
            store.state.notes.splice(Math.min(Math.max(0, index), store.state.notes.length), 0, note);
          }
          const restored = await persist();
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
      $('#confirmTitle').textContent = T(options.title || 'Подтвердите действие');
      $('#confirmText').textContent = options.textReady ? (options.text || '') : T(options.text || '');
      $('#confirmOk').textContent = T(options.okLabel || 'Подтвердить');
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
    document.addEventListener('paste', handleScreenshotPaste);
    window.addEventListener('beforeunload', function () {
      if (!$('#tradeModal').hidden) saveDraftNow();
    });
    window.addEventListener('hashchange', function () {
      const view = String(location.hash || '').replace('#', '');
      if (VIEW_META[view] && view !== state.view) navigate(view, { push: false });
    });
    window.addEventListener('resize', U.debounce(function () {
      if (state.view === 'dashboard') renderDashboard();
    }, 220));
    window.addEventListener('tj:download-error', function (event) {
      toast(event.detail || 'Не удалось сохранить файл.', 'error');
    });

    $('#installUpdateBtn').addEventListener('click', function () {
      if (desktop && typeof desktop.installUpdate === 'function') installDesktopUpdate();
      else if (NS.pwa && typeof NS.pwa.applyUpdate === 'function') NS.pwa.applyUpdate();
    });
    $('#dismissUpdateBtn').addEventListener('click', function () {
      $('#updateBanner').hidden = true;
    });

    $('#newTradeBtn').addEventListener('click', function () { openTradeModal(); });
    $('#newNoteBtn').addEventListener('click', function () { openNoteModal(); });
    $('#emptyNewTrade').addEventListener('click', function () { openTradeModal(); });
    $('#emptyDemo').addEventListener('click', loadDemoData);
    $('#menuBtn').addEventListener('click', openSidebar);
    $('#sidebarOverlay').addEventListener('click', closeSidebar);
    $('#avatarBtn').addEventListener('click', function () { navigate('settings'); });
    $('#sidebarAccountSelect').addEventListener('change', function (event) { switchAccount(event.target.value); });
    $('#periodSelect').addEventListener('change', function (event) {
      state.period = event.target.value;
      renderCurrentView();
    });

    $('#keepDemoBtn').addEventListener('click', async function () {
      store.state.demo = false;
      await persist();
      renderDashboard();
      renderSidebar();
      toast('Демо-режим отключён, данные остались в журнале');
    });
    $('#clearDemoBtn').addEventListener('click', function () {
      askConfirm({
        title: 'Начать с чистого листа?',
        text: 'Демо-сделки и записи активного счёта будут удалены. Настройки счёта сохранятся.',
        okLabel: 'Очистить демо'
      }).then(async function (confirmed) {
        if (!confirmed) return;
        const ok = await store.resetData(true);
        if (!ok) {
          toast('Не удалось сохранить очистку демо-данных.', 'error');
          return;
        }
        clearAccountDrafts(store.state.activeAccountId);
        state.calCursor = monthStart(new Date());
        state.selectedDay = todayInAccount();
        renderAll();
        toast('Демо-данные удалены. Добро пожаловать в собственный журнал!');
      });
    });

    $('#tradeSearch').addEventListener('input', U.debounce(function (event) {
      state.filters.search = event.target.value.trim().toLowerCase();
      state.page = 1;
      renderTrades();
    }, 160));
    $('#filterSide').addEventListener('change', function (event) { state.filters.side = event.target.value; state.page = 1; renderTrades(); });
    $('#filterResult').addEventListener('change', function (event) { state.filters.result = event.target.value; state.page = 1; renderTrades(); });
    $('#filterSetup').addEventListener('change', function (event) { state.filters.setup = event.target.value; state.page = 1; renderTrades(); });
    $('#clearFilters').addEventListener('click', resetFilters);
    $('#tradesTable').querySelector('thead').addEventListener('click', function (event) {
      const th = event.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else { state.sort.key = key; state.sort.dir = 'desc'; }
      state.page = 1;
      renderTrades();
    });
    $('#tradesFooter').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-page]');
      if (!button || button.disabled) return;
      state.page = Math.max(1, Number(button.dataset.page) || 1);
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
    $('#exportZipBtn').addEventListener('click', exportZIP);
    $('#backupRemindLaterBtn').addEventListener('click', remindBackupLater);
    $('#importCsvBtn').addEventListener('click', function () { $('#importCsvFile').click(); });
    $('#importCsvBtn2').addEventListener('click', function () { $('#importCsvFile2').click(); });
    $('#importCsvFile').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      importCSVFile(file);
      event.target.value = '';
    });
    $('#importCsvFile2').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      importCSVFile(file);
      event.target.value = '';
    });
    $('#confirmCsvImport').addEventListener('click', confirmCsvImport);

    $('#calPrev').addEventListener('click', function () { changeMonth(-1); });
    $('#calNext').addEventListener('click', function () { changeMonth(1); });
    $('#calToday').addEventListener('click', function () {
      state.calCursor = monthStart(new Date());
      state.selectedDay = todayInAccount();
      renderCalendar();
    });

    $('#calcForm').addEventListener('input', calcUpdate);
    $('#calcReset').addEventListener('click', resetCalculator);

    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#languageSegmented').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-lang-option]');
      if (!button) return;
      const lang = button.dataset.langOption === 'en' ? 'en' : 'ru';
      if (NS.prefs && NS.prefs.get().lang === lang) return;
      if (NS.i18n && NS.i18n.setLanguage) NS.i18n.setLanguage(lang, { reload: true });
      else { saveAppearance({ lang: lang }); location.reload(); }
    });
    $('#themeSegmented').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-theme-option]');
      if (!button) return;
      saveAppearance({ theme: button.dataset.themeOption === 'light' ? 'light' : 'dark' }, true);
    });
    $('#accentSwatches').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-accent-value]');
      if (!button) return;
      saveAppearance({ accent: button.dataset.accentValue }, true);
    });
    $('#accentColor').addEventListener('input', function (event) {
      saveAppearance({ accent: event.target.value }, false);
    });
    $('#accentColor').addEventListener('change', function () { renderCurrentView(); });
    $('#bgColor').addEventListener('input', function (event) {
      saveAppearance({ bg: event.target.value }, false);
    });
    $('#bgColor').addEventListener('change', function () { renderCurrentView(); });
    $('#panelColor').addEventListener('input', function (event) {
      saveAppearance({ panel: event.target.value }, false);
    });
    $('#panelColor').addEventListener('change', function () { renderCurrentView(); });
    $('#resetAppearanceBtn').addEventListener('click', function () {
      if (!NS.prefs) return;
      NS.prefs.reset({ keepLanguage: true });
      renderAppearance();
      renderCurrentView();
    });
    $('#profileName').addEventListener('input', function () {
      if (!state.profileAvatarDraft) renderProfileAvatar();
    });
    $('#profileAvatarInput').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      compressAvatar(file);
      event.target.value = '';
    });
    $('#removeAvatarBtn').addEventListener('click', function () {
      state.profileAvatarDraft = '';
      renderProfileAvatar();
      toast('Аватар будет удалён после сохранения профиля', 'warn');
    });
    $('#accountSelect').addEventListener('change', function (event) { switchAccount(event.target.value); });
    $('#newAccountBtn').addEventListener('click', function () { openAccountModal('create'); });
    $('#renameAccountBtn').addEventListener('click', function () { openAccountModal('rename'); });
    $('#deleteAccountBtn').addEventListener('click', deleteActiveAccount);
    $('#accountForm').addEventListener('submit', saveAccount);
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
      if (!button) return;
      setSide(button.dataset.side);
      syncTradeDirty();
    });
    $('#addExitBtn').addEventListener('click', function () { addExitRow(); });
    $('#closeRemainingBtn').addEventListener('click', closeRemainingExit);
    $('#exitsEditor').addEventListener('input', function (event) {
      const row = event.target.closest('[data-exit-index]');
      const field = event.target.dataset.exitField;
      if (!row || !field) return;
      const index = Number(row.dataset.exitIndex);
      if (!state.tradeExits[index]) return;
      state.tradeExits[index][field] = event.target.value;
      updateTradePreview();
      syncTradeDirty();
    });
    $('#exitsEditor').addEventListener('change', function (event) {
      const row = event.target.closest('[data-exit-index]');
      const field = event.target.dataset.exitField;
      if (!row || !field) return;
      const index = Number(row.dataset.exitIndex);
      if (!state.tradeExits[index]) return;
      state.tradeExits[index][field] = event.target.value;
      updateTradePreview();
      syncTradeDirty();
    });
    $('#exitsEditor').addEventListener('click', function (event) {
      const button = event.target.closest('[data-remove-exit]');
      if (!button) return;
      removeExitRow(Number(button.dataset.removeExit));
    });
    $('#disciplineStars').addEventListener('click', function (event) {
      const star = event.target.closest('.star');
      if (!star) return;
      const value = Number(star.dataset.star);
      const current = Number($('#tradeDiscipline').value) || 0;
      setDiscipline(current === value ? 0 : value);
      syncTradeDirty();
    });
    $('#tradeShot').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      compressScreenshot(file);
      event.target.value = '';
    });
    $('#pasteShot').addEventListener('click', pasteScreenshotFromClipboard);
    $('#removeShot').addEventListener('click', function () {
      if (state.screenshotBusy) {
        toast('Скриншот ещё сохраняется, подождите пару секунд.', 'warn');
        return;
      }
      state.screenshot = '';
      state.screenshotPreview = '';
      renderShotPreview();
      syncTradeDirty();
    });
    $('#shotLightboxClose').addEventListener('click', closeShotLightbox);
    $('#shotLightboxBackdrop').addEventListener('click', closeShotLightbox);

    const shotField = $('#shotField');
    ['dragenter', 'dragover'].forEach(function (type) {
      shotField.addEventListener(type, function (event) {
        if (!event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types, 'Files') === -1) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        shotField.classList.add('is-dragover');
      });
    });
    shotField.addEventListener('dragleave', function (event) {
      const next = event.relatedTarget;
      if (!next || next.nodeType !== 1 || !shotField.contains(next)) {
        shotField.classList.remove('is-dragover');
      }
    });
    shotField.addEventListener('drop', function (event) {
      event.preventDefault();
      shotField.classList.remove('is-dragover');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) compressScreenshot(file);
    });
    $('#tradeForm').addEventListener('input', handleTradeFormChanged);
    $('#tradeForm').addEventListener('change', handleTradeFormChanged);
    $('#tradeForm').addEventListener('submit', saveTrade);
    $('#deleteTradeBtn').addEventListener('click', deleteTrade);
    $('#discardDraftBtn').addEventListener('click', discardTradeDraft);

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
      if (closeEl.dataset.close === 'tradeModal') {
        requestCloseTradeModal();
      } else {
        closeModal(closeEl.dataset.close);
      }
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

    const shotEl = event.target.closest('[data-open-shot]');
    if (shotEl) {
      event.preventDefault();
      openTradeScreenshot(shotEl.dataset.openShot, shotEl);
      return;
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
    const key = event.key;
    const withModifier = event.ctrlKey || event.metaKey;
    const open = $$('.modal').filter(function (modal) { return !modal.hidden; });
    const topModal = open.length ? open[open.length - 1].id : '';
    const lightbox = $('#shotLightbox');
    const lightboxOpen = !!(lightbox && !lightbox.hidden);

    if (!lightboxOpen && topModal === 'tradeModal' && withModifier
      && (key === 'Enter' || key.toLowerCase() === 's')) {
      event.preventDefault();
      $('#tradeForm').requestSubmit();
      return;
    }

    if (key === 'Escape') {
      if (lightboxOpen) {
        closeShotLightbox();
        return;
      }
      if (open.length) {
        if (topModal === 'tradeModal') {
          requestCloseTradeModal();
          return;
        }
        closeModal(topModal);
        return;
      }
      closeSidebar();
      return;
    }

    if (isTyping(event.target) || open.length) return;

    if (key === 'n' || key === 'N' || key === 'т' || key === 'Т') {
      event.preventDefault();
      openTradeModal();
      return;
    }

    if (key === '/' && state.view === 'trades') {
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

  function start() {
    init().catch(function (err) {
      console.error('TradeJournal: не удалось запустить приложение', err);
      toast('Не удалось запустить приложение: ' + (err && err.message ? err.message : err), 'error');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
