(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;
  const store = NS.store;
  const desktop = window.tradeJournalDesktop || null;
  const APP_VERSION = '2.5.2';
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
    dateMode: 'entry',
    periodFrom: '',
    periodTo: '',
    filters: { search: '', side: 'all', result: 'all', setup: 'all' },
    journalFilters: { search: '', mood: 'all', tag: 'all' },
    sort: { key: 'date', dir: 'desc' },
    page: 1,
    pageSize: 25,
    calCursor: monthStart(new Date()),
    selectedDay: U.todayISO(),
    tradeId: null,
    tradeOriginalId: null,
    tradeAccountId: null,
    tradeBaseline: null,
    tradeBaselineScreenshots: [],
    tradeEntries: [],
    tradeExits: [],
    tradeChecklist: [],
    csvImport: null,
    tradeDirty: false,
    tradeSaving: false,
    tradeInitializing: false,
    tradeDraftTimer: null,
    draftQuotaWarned: false,
    draftShotWarned: false,
    draftScreenshotOmitted: false,
    noteId: null,
    screenshots: [],
    screenshotPreviews: {},
    lightboxItems: [],
    lightboxIndex: 0,
    screenshotBusy: false,
    shotFocus: null,
    noteMood: 'neutral',
    profileAvatarDraft: '',
    accountModalMode: 'create',
    confirmResolver: null,
    focusStack: [],
    storageHealthData: null,
    storageHealthScanning: false,
    storageHealthCleaning: false,
    backupReminderShown: false
  };

  const EMOTION_OPTIONS = NS.EMOTIONS;

  // Popular trading zones are listed first; every other IANA zone follows.
  const COMMON_TIMEZONES = [
    'UTC',
    'Europe/London',
    'Europe/Dublin',
    'Europe/Lisbon',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Zurich',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Amsterdam',
    'Europe/Stockholm',
    'Europe/Warsaw',
    'Europe/Kiev',
    'Europe/Moscow',
    'Europe/Istanbul',
    'Africa/Johannesburg',
    'Africa/Lagos',
    'Asia/Dubai',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Almaty',
    'Asia/Bangkok',
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Australia/Perth',
    'Australia/Sydney',
    'Pacific/Auckland',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Toronto',
    'America/Mexico_City',
    'America/Sao_Paulo'
  ];

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
    state.calCursor = accountMonthStart();
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
      downloadBtn.addEventListener('click', async function () {
        const result = await U.download('tradejournal-corrupt-' + U.todayISO() + '.json', rawData, 'application/json');
        if (!result || result.canceled || !result.ok) return;
        downloadBtn.textContent = T('Файл скачан');
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

  function accountMonthStart() {
    return monthStart(U.parseISO(todayInAccount()) || new Date());
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

  function cssVar(name, fallback) {
    try {
      if (typeof getComputedStyle === 'function') {
        const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (val) return val;
      }
    } catch (err) { /* ignore */ }
    return fallback;
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
      state.calCursor = state.calCursor ? monthStart(state.calCursor) : accountMonthStart();
      if (!state.selectedDay) state.selectedDay = todayInAccount();
    }

    renderCurrentView();
    if (desktop && view === 'settings' && !state.storageHealthScanning) {
      scanStorageHealth(false);
    }
    if (options.scroll !== false) window.scrollTo(0, 0);
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
      case 'custom': {
        let from = U.validDateISO(state.periodFrom);
        let to = U.validDateISO(state.periodTo);
        if (from && to && from > to) { const tmp = from; from = to; to = tmp; }
        return { from: from || null, to: to || null };
      }
      default: return { from: null, to: null };
    }
  }

  function dateInRange(dateStr, range) {
    if (!range || (!range.from && !range.to)) return true;
    return (!range.from || dateStr >= range.from) && (!range.to || dateStr <= range.to);
  }

  function projectTradeByExitRange(trade, range) {
    const exits = store.tradeExits(trade);
    if (!exits.length) return null;
    if (!range || (!range.from && !range.to)) {
      const lastDate = exits.reduce(function (maxD, ex) {
        const d = ex.date || trade.date || '';
        return d > maxD ? d : maxD;
      }, trade.date || '');
      return lastDate && lastDate !== trade.date
        ? Object.assign({}, trade, { date: lastDate })
        : trade;
    }
    const matchingExits = exits.filter(function (ex) {
      return dateInRange(ex.date || trade.date || '', range);
    });
    if (!matchingExits.length) return null;
    const latestExitDate = matchingExits.reduce(function (maxD, ex) {
      const d = ex.date || trade.date || '';
      return d > maxD ? d : maxD;
    }, '');
    const qtySum = matchingExits.reduce(function (s, ex) { return s + (U.parseNum(ex.qty) || 0); }, 0);
    if (matchingExits.length === exits.length) {
      return latestExitDate && latestExitDate !== trade.date
        ? Object.assign({}, trade, { date: latestExitDate })
        : trade;
    }
    return Object.assign({}, trade, {
      date: latestExitDate || trade.date,
      exit: null,
      exits: matchingExits,
      fees: matchingExits.reduce(function (s, ex) { return s + Math.max(0, U.parseNum(ex.fees) || 0); }, 0),
      qty: qtySum > 0 ? qtySum : trade.qty
    });
  }

  function filterByRange(trades, range) {
    if (state.dateMode === 'exit') {
      const projected = [];
      (trades || []).forEach(function (trade) {
        const item = projectTradeByExitRange(trade, range);
        if (item) projected.push(item);
      });
      return store.sortTrades(projected, 'asc');
    }
    if (!range || (!range.from && !range.to)) return trades;
    return trades.filter(function (trade) {
      return dateInRange(trade.date, range);
    });
  }

  function buildPeriodMetrics() {
    const settings = store.state.settings;
    const range = currentRange();
    const closedAll = store.sortTrades(store.state.trades.filter(store.hasRealized), 'asc');
    const filtered = filterByRange(closedAll, range);
    let beforePnl = 0;
    if (range.from) {
      if (state.dateMode === 'exit') {
        closedAll.forEach(function (trade) {
          store.tradePnlEvents(trade).forEach(function (ev) {
            if ((ev.date || trade.date || '') < range.from) beforePnl += ev.pnl;
          });
        });
      } else {
        closedAll.forEach(function (trade) {
          if (trade.date < range.from) {
            const pnl = store.tradePnl(trade);
            if (pnl !== null) beforePnl += pnl;
          }
        });
      }
    }
    const base = (U.parseNum(settings.startBalance) || 0) + beforePnl;
    const m = store.metrics(filtered, base);
    return { range: range, closedAll: closedAll, filtered: filtered, base: base, m: m };
  }

  function renderPeriodControls() {
    const sel = $('#periodSelect');
    if (sel && sel.value !== state.period) sel.value = state.period;
    const customBox = $('#customPeriodRange');
    if (customBox) customBox.hidden = state.period !== 'custom';
    const fromEl = $('#periodFrom');
    const toEl = $('#periodTo');
    if (fromEl && fromEl.value !== (state.periodFrom || '')) fromEl.value = state.periodFrom || '';
    if (toEl && toEl.value !== (state.periodTo || '')) toEl.value = state.periodTo || '';
    $$('#dateModeSegmented [data-date-mode]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.dateMode === state.dateMode);
    });
  }

  /* ============================================================
     Dashboard
     ============================================================ */

  let lastDashboardCharts = null;

  function redrawDashboardCharts() {
    if (!lastDashboardCharts) {
      renderDashboard();
      return;
    }
    NS.charts.equity($('#equityChart'), lastDashboardCharts.points, { emptyText: T('Нет закрытых сделок за период') });
    NS.charts.donut($('#donutChart'), [
      { value: lastDashboardCharts.wins, color: cssVar('--green', '#31e3aa') },
      { value: lastDashboardCharts.losses, color: cssVar('--red', '#ff6b81') },
      { value: lastDashboardCharts.be, color: cssVar('--muted-2', '#7c8fa6') }
    ]);
    NS.charts.bars($('#dailyChart'), lastDashboardCharts.daily, { emptyText: T('За этот период сделок не было') });
  }

  function renderDashboard() {
    $('#welcomeBanner').hidden = !store.state.demo;

    const data = buildPeriodMetrics();
    const m = data.m;
    renderKpis(m, data.base);

    const points = buildEquityPoints(data.filtered, data.base);
    NS.charts.equity($('#equityChart'), points, { emptyText: T('Нет закрытых сделок за период') });

    const roi = data.base > 0 ? (m.net / data.base) * 100 : 0;
    const chip = $('#equityChip');
    chip.textContent = m.count ? (roi > 0 ? '+' : '') + U.percent(roi, 1) : 'нет сделок';
    chip.className = 'chip ' + toneClass(m.net);

    const winColor = cssVar('--green', '#31e3aa');
    const lossColor = cssVar('--red', '#ff6b81');
    const beColor = cssVar('--muted-2', '#7c8fa6');
    NS.charts.donut($('#donutChart'), [
      { value: m.wins, color: winColor },
      { value: m.losses, color: lossColor },
      { value: m.be, color: beColor }
    ]);
    $('#donutRate').textContent = m.count ? U.percent(m.winRate, 0) : '—';

    const legend = [
      { label: 'Прибыльные', count: m.wins, color: 'var(--green)' },
      { label: 'Убыточные', count: m.losses, color: 'var(--red)' },
      { label: 'Безубыток', count: m.be, color: 'var(--muted-2)' }
    ];
    $('#donutLegend').innerHTML = legend.map(function (item) {
      const pct = m.count ? U.percent((item.count / m.count) * 100, 0) : '—';
      return '<div class="legend-row"><span class="legend-dot" style="background:' + item.color + '"></span>' +
        U.escapeHtml(item.label) + '<b>' + item.count + '</b><span class="legend-pct">' + pct + '</span></div>';
    }).join('');

    const daily = dailySeries(data.filtered, 30);
    NS.charts.bars($('#dailyChart'), daily, { emptyText: T('За этот период сделок не было') });
    lastDashboardCharts = {
      points: points,
      wins: m.wins,
      losses: m.losses,
      be: m.be,
      daily: daily
    };
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
    const openRisk = store.openPortfolioRisk(store.state.trades, store.balanceAll());
    const openRiskTone = openRisk.unprotectedCount > 0
      ? 'warn'
      : (openRisk.riskPct > (store.state.settings.dailyLossLimit || 3) ? 'neg' : (openRisk.totalRisk > 0 ? 'neutral' : ''));
    const openSub = openRisk.openCount
      ? T('{pct} счёта · {count} открытых')
        .replace('{pct}', U.percent(openRisk.riskPct, 1))
        .replace('{count}', openRisk.openCount) +
        (openRisk.unprotectedCount ? ' · ' + T('{count} без стопа').replace('{count}', openRisk.unprotectedCount) : '')
      : T('Нет открытых позиций');
    const beTone = m.beWinRate !== null
      ? (m.winRate >= m.beWinRate ? 'pos' : 'neg')
      : '';
    const rSub = hasR
      ? T('Итого {total} · {count} с R').replace('{total}', U.rfmt(m.totalR, { sign: true })).replace('{count}', m.rCount) +
        (m.returnOnClosedRisk !== null ? ' · ' + (m.returnOnClosedRisk > 0 ? '+' : '') + U.percent(m.returnOnClosedRisk, 1) + ' RoR' : '')
      : T('Добавьте стоп при входе к сделкам');

    const cards = [
      {
        label: 'Чистый P&L',
        value: m.count ? U.money(m.net, { sign: true }) : '—',
        tone: toneClass(m.net),
        sub: m.count
          ? 'ROI ' + (roi > 0 ? '+' : '') + U.percent(roi, 1) + ' · ' + m.count + ' ' + pluralTrades(m.count)
          : T('Нет закрытых сделок')
      },
      {
        label: 'Винрейт',
        value: m.count ? U.percent(m.winRate, 0) : '—',
        tone: m.count ? (m.winRate >= 50 ? 'pos' : '') : '',
        sub: m.count ? m.wins + 'W · ' + m.losses + 'L · ' + m.be + 'BE' : T('Нужны закрытые сделки')
      },
      {
        label: 'Безубыточный WR',
        value: m.beWinRate !== null ? U.percent(m.beWinRate, 0) : '—',
        tone: beTone,
        sub: m.payoffRatio !== null
          ? T('под средний R:R 1 : {rr}').replace('{rr}', decimal(m.payoffRatio, 2))
          : T('Нужны прибыли и убытки')
      },
      {
        label: 'Профит-фактор',
        value: m.count ? pf : '—',
        tone: m.count ? (m.profitFactor > 1 ? 'pos' : (m.profitFactor < 1 ? 'neg' : '')) : '',
        sub: m.count ? T('Прибыль / убыток') : T('Отношение валовой прибыли к убытку')
      },
      {
        label: 'Средний R',
        value: hasR ? U.rfmt(m.avgR, { sign: true }) : '—',
        tone: hasR ? toneClass(m.avgR) : '',
        sub: rSub
      },
      {
        label: 'Открытый риск',
        value: openRisk.openCount ? U.money(openRisk.totalRisk) : '—',
        tone: openRiskTone,
        sub: openSub
      },
      {
        label: 'Макс. просадка, $',
        value: m.count ? U.money(m.maxDD) : '—',
        tone: m.maxDD > 0.004 ? 'neg' : '',
        sub: m.count
          ? T('Макс. просадка, %: {pct} от пика счёта').replace('{pct}', U.percent(m.maxDDPct, 1))
          : T('Пока без просадок')
      },
      {
        label: 'Серия',
        value: streak,
        tone: m.currentStreak ? (m.currentStreak.type === 'win' ? 'pos' : 'neg') : '',
        sub: m.count ? T('Макс. {w}W / {l}L').replace('{w}', m.maxWinStreak).replace('{l}', m.maxLossStreak) : T('Текущая серия')
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
    const points = [{ label: T('Старт'), value: balance, meta: T('Начало периода') }];
    store.pnlEventRows(closedAsc).forEach(function (event) {
      balance += event.pnl;
      points.push({
        label: event.date,
        value: balance,
        meta: (event.trade ? event.trade.symbol : '') + ' · ' + U.money(event.pnl, { sign: true })
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
    const dayMap = store.dayPnlMap(store.state.trades);
    const todayInfo = dayMap.get(today);
    const dayPnl = todayInfo ? todayInfo.pnl : 0;

    let netBeforeToday = 0;
    dayMap.forEach(function (info, day) {
      if (day < today) netBeforeToday += info.pnl;
    });
    const startOfDayBalance = Math.max(0, (U.parseNum(settings.startBalance) || 0) + netBeforeToday);
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
      messages.push(
        T('Убыток за сегодня: {loss} при лимите {limit}.')
          .replace('{loss}', U.money(-snapshot.dayPnl))
          .replace('{limit}', U.money(snapshot.lossLimit))
      );
    }
    if (snapshot.maxTrades > 0 && snapshot.todayTrades.length >= snapshot.maxTrades) {
      if (messages.length) title = 'Дневные лимиты превышены';
      else title = 'Лимит сделок на день достигнут';
      messages.push(
        T('Сегодня уже {count} {unit} при лимите {max}.')
          .replace('{count}', snapshot.todayTrades.length)
          .replace('{unit}', pluralTrades(snapshot.todayTrades.length))
          .replace('{max}', snapshot.maxTrades)
      );
    }
    if (!messages.length) return null;

    return {
      title: title,
      text: messages.join(' ') + ' ' + T('Добавить сделку вне плана?'),
      textReady: true
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
    if (lossLimit > 0 && dayPnl <= -lossLimit) {
      statusTone = 'bad';
      statusText = 'Дневной лимит убытка достигнут. Остановитесь на сегодня.';
    } else if (maxTrades > 0 && todayTrades.length >= maxTrades) {
      statusTone = 'warn';
      statusText = 'Лимит сделок на день исчерпан. Больше не входите.';
    } else if (!todayTrades.length) {
      statusText = 'Сделок сегодня ещё нет — можно работать по плану.';
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
        : (status === 'partial' ? T('частично · остаток {qty}').replace('{qty}', U.qty(store.remainingQty(trade))) : T('без выхода'));
      return '<div class="mini-row" role="button" data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
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

  let collatorLocale = '';
  let textCollator = null;

  function getCollator() {
    const loc = U.locale();
    if (!textCollator || collatorLocale !== loc) {
      collatorLocale = loc;
      textCollator = new Intl.Collator(loc);
    }
    return textCollator;
  }

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
        const pnl = store.tradePnl(trade);
        if (pnl === null) return false;
        if (filters.result === 'win') return pnl > 0.004;
        if (filters.result === 'loss') return pnl < -0.004;
        return Math.abs(pnl) <= 0.004;
      });
    }

    const key = state.sort.key;
    const dir = state.sort.dir === 'asc' ? 1 : -1;
    if (key === 'date') {
      const decorated = list.map(function (trade) {
        return { trade: trade, val: (trade.date || '') + ' ' + (trade.time || '00:00') };
      });
      decorated.sort(function (a, b) {
        return (a.val < b.val ? -1 : (a.val > b.val ? 1 : 0)) * dir;
      });
      return decorated.map(function (item) { return item.trade; });
    }
    if (key === 'session') {
      const sessions = store.state.settings.sessions;
      const decorated = list.map(function (trade) {
        const info = U.sessionInfo(trade.time, sessions);
        return {
          trade: trade,
          start: info ? timeToMinutes(info.start) : null,
          dt: (trade.date || '') + ' ' + (trade.time || '')
        };
      });
      decorated.sort(function (a, b) {
        if (a.start === null && b.start === null) return 0;
        if (a.start === null) return 1;
        if (b.start === null) return -1;
        if (a.start !== b.start) return (a.start - b.start) * dir;
        return (a.dt < b.dt ? -1 : (a.dt > b.dt ? 1 : 0)) * dir;
      });
      return decorated.map(function (item) { return item.trade; });
    }
    if (key === 'symbol' || key === 'setup') {
      const collator = getCollator();
      const decorated = list.map(function (trade) {
        return { trade: trade, val: String(trade[key] || '').toLowerCase() };
      });
      decorated.sort(function (a, b) {
        return collator.compare(a.val, b.val) * dir;
      });
      return decorated.map(function (item) { return item.trade; });
    }

    const decorated = list.map(function (trade) {
      let val;
      if (key === 'pnl') val = store.tradePnl(trade);
      else if (key === 'r') val = store.tradeR(trade);
      else if (key === 'exit') val = store.weightedExit(trade);
      else val = U.parseNum(trade[key]);
      return { trade: trade, val: val };
    });
    decorated.sort(function (a, b) {
      if (a.val === null && b.val === null) return 0;
      if (a.val === null) return 1;
      if (b.val === null) return -1;
      return (a.val - b.val) * dir;
    });
    return decorated.map(function (item) { return item.trade; });
  }

  let lastSetupsSelect = null;
  let lastSetupsKey = '';

  function populateSetupFilter() {
    const select = $('#filterSetup');
    const collator = getCollator();
    const setups = Array.from(new Set(store.state.trades.map(function (t) { return t.setup; }).filter(function (s) { return !!s; })))
      .sort(function (a, b) { return collator.compare(a, b); });
    const cacheKey = U.locale() + '\u0000' + setups.join('\u0000');
    const current = state.filters.setup;
    if (lastSetupsSelect !== select || lastSetupsKey !== cacheKey) {
      let html = '<option value="all">Все сетапы</option>';
      setups.forEach(function (setup) {
        html += '<option data-i18n-skip value="' + U.escapeHtml(setup) + '">' + U.escapeHtml(setup) + '</option>';
      });
      select.innerHTML = html;
      lastSetupsSelect = select;
      lastSetupsKey = cacheKey;
    }
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
    const session = U.sessionInfo(trade.time, store.state.settings.sessions);
    const weighted = store.weightedExit(trade);
    const remaining = store.remainingQty(trade);
    const exitHtml = status === 'open'
      ? '<span class="open-badge">' + T('Открыта') + '</span>'
      : '<span class="exit-value">' + U.escapeHtml(U.price(weighted)) + '</span>' +
        (status === 'partial' ? '<small class="exit-remain">' + U.escapeHtml(T('ост. {qty}').replace('{qty}', U.qty(remaining))) + '</small>' : '');
    const pnlHtml = pnl === null
      ? '<span class="muted">—</span>'
      : '<span class="' + toneClass(pnl) + '">' + U.escapeHtml(U.money(pnl, { sign: true })) + '</span>' +
        (status === 'partial' ? '<small class="exit-remain">' + T('реализовано') + '</small>' : '');
    const shots = store.tradeScreenshots(trade);
    const hasShot = shots.length > 0;
    const statusHtml = status === 'partial'
      ? '<span class="partial-badge">' + T('частично') + '</span>'
      : (status === 'open' ? '<span class="open-badge">' + T('открыта') + '</span>' : '');
    return '<tr data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
      '<td><div class="cell-date"><strong>' + U.escapeHtml(U.formatDate(trade.date, 'med')) + '</strong><span>' + U.escapeHtml(trade.time || '—') + '</span></div></td>' +
      '<td>' + (session ? '<span class="session-chip" data-i18n-skip>' + U.escapeHtml(session.label) + '</span>' : '<span class="muted">—</span>') + '</td>' +
      '<td><div class="symbol-cell"><div class="symbol-main">' +
      '<button type="button" class="symbol-thumb' + (hasShot ? ' has-shot' : '') + '"' +
      (hasShot ? ' data-open-shot="' + U.escapeHtml(trade.id) + '" title="' + U.escapeHtml(T('Открыть скриншот')) + '"' : ' tabindex="-1" aria-hidden="true"') + '>' +
      '<span class="thumb-empty"></span>' +
      (shots.length > 1 ? '<span class="thumb-count">' + shots.length + '</span>' : '') +
      '</button>' +
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
      const shots = store.tradeScreenshots(trade);
      if (!shots.length) return;
      store.screenshotSource(shots[0].src).then(function (source) {
        if (token !== thumbHydrationToken || !source || !document.contains(button)) return;
        const image = document.createElement('img');
        image.src = source;
        image.alt = '';
        image.loading = 'lazy';
        button.innerHTML = '';
        button.appendChild(image);
        if (shots.length > 1) {
          const badge = document.createElement('span');
          badge.className = 'thumb-count';
          badge.textContent = String(shots.length);
          button.appendChild(badge);
        }
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
      if (th.dataset.sort === state.sort.key) {
        th.dataset.dir = state.sort.dir;
        th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('data-dir');
        th.setAttribute('aria-sort', 'none');
      }
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
    $('#tradesFooter').innerHTML = '<span>' + U.escapeHtml(T('Показано {from}–{to} из {total}').replace('{from}', from).replace('{to}', to).replace('{total}', list.length)) + '</span>' +
      '<span class="dot-sep">·</span><span>' + U.escapeHtml(T('Итого по фильтру:')) + ' <b class="' + toneClass(net) + '">' + U.escapeHtml(U.money(net, { sign: true })) + '</b></span>' +
      (realizedCount !== list.length ? '<span class="dot-sep">·</span><span>' + U.escapeHtml(T('с результатом:')) + ' <b>' + realizedCount + '</b></span>' : '') +
      (rCount ? '<span class="dot-sep">·</span><span>' + U.escapeHtml(T('Средний R')) + ': <b class="' + toneClass(rSum / rCount) + '">' + U.escapeHtml(U.rfmt(rSum / rCount, { sign: true })) + '</b></span>' : '') +
      pagerHtml(state.page, totalPages) +
      '<span class="table-foot-hint">' + U.escapeHtml(T('Клик по строке — редактирование')) + '</span>';
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
    $('#calWeekdays').innerHTML = U.weekdayLabels().map(function (label) { return '<span>' + label + '</span>'; }).join('');

    const dayMap = store.dayPnlMap(store.state.trades);
    const monthTradePnl = new Map();
    store.state.trades.forEach(function (trade) {
      let tradeMonthPnl = 0;
      let hasMonthEvent = false;
      store.tradePnlEvents(trade).forEach(function (event) {
        if ((event.date || '').slice(0, 7) !== prefix) return;
        tradeMonthPnl += event.pnl;
        hasMonthEvent = true;
      });
      if (hasMonthEvent) monthTradePnl.set(trade.id, tradeMonthPnl);
    });
    const monthTradeValues = Array.from(monthTradePnl.values());
    const monthTradeCount = monthTradeValues.length;
    const monthWins = monthTradeValues.filter(function (value) { return value > 0.004; }).length;
    const monthWinRate = monthTradeCount ? (monthWins / monthTradeCount) * 100 : 0;

    const monthKeys = Array.from(dayMap.keys()).filter(function (key) {
      return key.slice(0, 7) === prefix && dayMap.get(key).realizedCount > 0;
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

    const dayValues = monthKeys.map(function (key) { return dayMap.get(key).pnl; });

    $('#calSummary').innerHTML =
      '<span class="chip ' + toneClass(monthPnl) + '">' + U.escapeHtml(U.money(monthPnl, { sign: true })) + '</span>' +
      '<span class="chip">' + monthTradeCount + ' ' + pluralTrades(monthTradeCount) + '</span>' +
      '<span class="chip">' + U.escapeHtml(T('Винрейт {wr}').replace('{wr}', monthTradeCount ? U.percent(monthWinRate, 0) : '—')) + '</span>' +
      (bestDay && bestDay.value > 0.004 ? '<span class="chip pos">' + U.escapeHtml(T('Лучший день +{val}').replace('{val}', U.money(bestDay.value))) + '</span>' : '');

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
      const realizedCount = dayInfo ? (dayInfo.realizedCount || 0) : 0;
      const hasNote = notesByDate[iso] && notesByDate[iso].length > 0;
      const ratio = maxAbs > 0 ? Math.abs(dayPnl) / maxAbs : 0;

      const classes = ['cal-day'];
      if (!inMonth) classes.push('other');
      if (iso === today) classes.push('today');
      if (iso === state.selectedDay) classes.push('selected');

      let style = '';
      if (realizedCount > 0 && (dayPnl > 0.004 || dayPnl < -0.004)) {
        classes.push(dayPnl > 0 ? 'pos' : 'neg');
        style = '--heat:' + ratio.toFixed(3);
      }

      const titleParts = [U.formatDate(iso, 'full')];
      if (realizedCount > 0) titleParts.push(U.money(dayPnl, { sign: true }) + ' · ' + count + ' ' + pluralTrades(count));
      else if (count) titleParts.push(count + ' ' + pluralTrades(count) + ' (' + T('открыта') + ')');
      if (hasNote) titleParts.push(T('есть запись в журнале'));

      html += '<button type="button" class="' + classes.join(' ') + '" data-date="' + iso + '"' +
        (style ? ' style="' + style + '"' : '') + ' title="' + U.escapeHtml(titleParts.join(' · ')) + '">' +
        '<span class="cal-num">' + date.getDate() + '</span>' +
        (realizedCount > 0 ? '<span class="cal-pnl ' + toneClass(dayPnl) + '">' + U.escapeHtml(U.compactMoney(dayPnl, { sign: true })) + '</span>' : '') +
        (count || hasNote
          ? '<span class="cal-meta">' + (count ? count + ' ' + pluralTrades(count) : '') +
            (hasNote ? '<span class="cal-note-dot" title="' + U.escapeHtml(T('Есть запись')) + '"></span>' : '') + '</span>'
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

    const dayInfo = store.dayPnlMap(store.state.trades).get(day) || { pnl: 0, count: 0, realizedCount: 0 };
    const dayPnl = dayInfo.pnl;
    const dayEventPnl = store.dayEventPnlMap(store.state.trades, day);
    const dayTrades = store.state.trades
      .filter(function (trade) {
        return trade.date === day || dayEventPnl.has(trade.id);
      })
      .sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
    const closedTrades = dayTrades.filter(function (trade) { return dayEventPnl.has(trade.id); });

    const dayNotes = store.state.notes
      .filter(function (note) { return note.date === day; })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

    const wins = closedTrades.filter(function (trade) { return dayEventPnl.get(trade.id) > 0.004; }).length;
    const losses = closedTrades.filter(function (trade) { return dayEventPnl.get(trade.id) < -0.004; }).length;
    const be = closedTrades.length - wins - losses;

    let tradesHtml;
    if (!dayTrades.length) {
      tradesHtml = '<div class="day-empty">В этот день сделок нет.<br>Можно добавить сделку или записать наблюдение.</div>';
    } else {
      tradesHtml = '<div class="day-sub">Сделки дня</div>' + dayTrades.map(function (trade) {
        const status = store.tradeStatus(trade);
        const hasEvent = dayEventPnl.has(trade.id);
        const pnl = hasEvent ? dayEventPnl.get(trade.id) : null;
        return '<div class="day-trade" role="button" data-open-trade="' + U.escapeHtml(trade.id) + '" tabindex="0">' +
          '<span class="day-trade-symbol" data-i18n-skip>' + U.escapeHtml(trade.symbol) +
          ' <span class="day-trade-side">' + (trade.side === 'long' ? 'long' : 'short') + '</span>' +
          (status === 'partial' ? ' <span class="partial-badge">' + T('частично') + '</span>' : '') + '</span>' +
          '<span class="day-trade-pnl ' + (hasEvent ? toneClass(pnl) : 'neutral') + '">' +
          (hasEvent ? U.escapeHtml(U.money(pnl, { sign: true })) : (status === 'open' ? T('открыта') : T('выход в другой день'))) + '</span></div>';
      }).join('');
    }

    let notesHtml = '';
    if (dayNotes.length) {
      const note = dayNotes[0];
      const mood = U.moodMeta(note.mood);
      notesHtml = '<div class="day-sub">Запись в журнале</div>' +
        '<div class="day-note"><div class="day-note-head">' + mood.emoji + ' <span data-i18n-skip>' + U.escapeHtml(note.title || mood.label) + '</span></div>' +
        '<p data-i18n-skip>' + U.escapeHtml(U.truncate(note.text, 180)) + '</p>' +
        '<div style="margin-top:6px"><button type="button" class="link-btn" data-edit-note="' + U.escapeHtml(note.id) + '">' + U.escapeHtml(T('Открыть запись')) + '</button>' +
        (dayNotes.length > 1 ? '<span class="muted small"> · ' + U.escapeHtml(T('ещё {count}').replace('{count}', dayNotes.length - 1)) + '</span>' : '') + '</div></div>';
    }

    const closedInfo = closedTrades.length
      ? closedTrades.length + ' ' + pluralTrades(closedTrades.length) + ' · ' + wins + 'W / ' + losses + 'L' + (be ? ' / ' + be + 'BE' : '')
      : T('закрытых сделок нет');

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
    if (!state.calCursor) state.calCursor = accountMonthStart();
    state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() + delta, 1);
    state.selectedDay = defaultDayForMonth(state.calCursor);
    renderCalendar();
  }

  function defaultDayForMonth(cursor) {
    const today = todayInAccount();
    const todayDate = U.parseISO(today);
    if (todayDate && cursor.getFullYear() === todayDate.getFullYear() && cursor.getMonth() === todayDate.getMonth()) return today;
    const prefix = cursor.getFullYear() + '-' + pad2(cursor.getMonth() + 1);
    const days = Array.from(store.dayPnlMap(store.state.trades).keys())
      .filter(function (day) { return day.slice(0, 7) === prefix; })
      .sort();
    return days[0] || prefix + '-01';
  }

  /* ============================================================
     Analytics
     ============================================================ */

  let lastAnalyticsDrawdown = null;

  function redrawAnalyticsCharts() {
    const canvas = $('#drawdownChart');
    if (!canvas || !NS.charts) return;
    if (!lastAnalyticsDrawdown) {
      renderAnalytics();
      return;
    }
    NS.charts.drawdown(canvas, lastAnalyticsDrawdown.points, { emptyText: T('Нет данных о просадках за период') });
  }

  function renderAnalytics() {
    const data = buildPeriodMetrics();
    const m = data.m;
    const rows = m.rows;
    const hasR = m.rCount > 0;

    const ddSeries = store.drawdownSeries(data.filtered, data.base);
    lastAnalyticsDrawdown = ddSeries;
    if (NS.charts && $('#drawdownChart')) {
      NS.charts.drawdown($('#drawdownChart'), ddSeries.points, { emptyText: T('Нет данных о просадках за период') });
    }
    const ddChip = $('#drawdownChip');
    if (ddChip) {
      if (!ddSeries.points.length || ddSeries.maxDD <= 0.004) {
        ddChip.textContent = m.count ? T('Без просадок') : '—';
        ddChip.className = 'chip ' + (m.count ? 'pos' : '');
      } else {
        ddChip.textContent = T('-{pct} · макс. {days} дн. ({trades} сд.)')
          .replace('{pct}', U.percent(ddSeries.maxDDPct, 1))
          .replace('{days}', ddSeries.maxDurationDays)
          .replace('{trades}', ddSeries.maxDurationTrades);
        ddChip.className = 'chip neg';
      }
    }

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
        sub: hasR
          ? T('Всего {total} · {count} с R').replace('{total}', U.rfmt(m.totalR, { sign: true })).replace('{count}', m.rCount)
          : T('Нужны стопы при входе')
      },
      {
        label: 'Винрейт',
        value: m.count ? U.percent(m.winRate, 0) : '—',
        tone: m.count ? (m.winRate >= 50 ? 'pos' : '') : '',
        sub: m.count
          ? T('{wins} прибыльных · {losses} убыточных').replace('{wins}', m.wins).replace('{losses}', m.losses)
          : T('Нет данных')
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

    renderBreakdown($('#setupBreakdown'), store.groupRows(rows, function (t) { return t.setup || '__EMPTY__'; }), {
      labelSkip: function (key) { return key !== '__EMPTY__'; },
      labelFn: function (key) { return key === '__EMPTY__' ? T('Без сетапа') : key; },
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
    renderBreakdown($('#sessionBreakdown'), sessionGroups, { preserveOrder: true, labelSkip: true, empty: 'Нет сделок за период' });

    renderQuality(m);
    renderSetupTable(rows);
    renderMonthTable(rows);
    renderTagTable(rows);
  }

  function buildInsights(m) {
    if (!m.count) {
      return [{ tone: '', icon: '💡', text: T('Пока нет закрытых сделок за выбранный период. Добавьте сделки — и здесь появятся закономерности вашей торговли.') }];
    }
    const out = [];
    const rows = m.rows;
    const setups = store.groupRows(rows, function (t) { return t.setup || T('Без сетапа'); })
      .filter(function (g) { return g.count >= 3; })
      .sort(function (a, b) { return b.pnl - a.pnl; });

    if (setups.length) {
      const best = setups[0];
      if (best.pnl > 0.004) {
        out.push({
          tone: 'pos', icon: '★',
          text: T('Лучший сетап — <b>{setup}</b>: <b class="pos">{pnl}</b> за {count} {unit}, винрейт {wr}.')
            .replace('{setup}', U.escapeHtml(best.key))
            .replace('{pnl}', U.escapeHtml(U.money(best.pnl, { sign: true })))
            .replace('{count}', best.count)
            .replace('{unit}', pluralTrades(best.count))
            .replace('{wr}', U.percent(best.winRate, 0))
        });
      }
      if (setups.length > 1) {
        const worst = setups[setups.length - 1];
        if (worst.pnl < -0.004) {
          out.push({
            tone: 'neg', icon: '!',
            text: T('Проблемный сетап — <b>{setup}</b>: <b class="neg">{pnl}</b> за {count} {unit}. Стоит пересмотреть условия входа.')
              .replace('{setup}', U.escapeHtml(worst.key))
              .replace('{pnl}', U.escapeHtml(U.money(worst.pnl, { sign: true })))
              .replace('{count}', worst.count)
              .replace('{unit}', pluralTrades(worst.count))
          });
        }
      }
    }

    const weekdayMap = new Map();
    rows.forEach(function (row) {
      const trade = row && row.trade ? row.trade : row;
      if (!trade) return;
      store.tradePnlEvents(trade).forEach(function (event) {
        if (!event.date || !U.validDateISO(event.date)) return;
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
        const weekdayLabels = U.weekdayLabels();
        out.push({
          tone: 'warn', icon: '◷',
          text: T('Самый слабый день — <b>{day}</b>: <b class="neg">{pnl}</b> за {count} {unit}. Возможно, стоит торговать в этот день меньшим объёмом.')
            .replace('{day}', weekdayLabels[Number(worstDay.key)])
            .replace('{pnl}', U.escapeHtml(U.money(worstDay.pnl, { sign: true })))
            .replace('{count}', worstDay.count)
            .replace('{unit}', pluralTrades(worstDay.count))
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
          text: T('Эмоция <b>{emotion}</b> стоит вам <b class="neg">{pnl}</b> за {count} {unit}. Замечайте её до входа.')
            .replace('{emotion}', U.escapeHtml(meta.label))
            .replace('{pnl}', U.escapeHtml(U.money(worstEmotion.pnl, { sign: true })))
            .replace('{count}', worstEmotion.count)
            .replace('{unit}', pluralTrades(worstEmotion.count))
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
          text: T('Сильнее работает направление <b>{side}</b>: <b class="pos">{pnl}</b> и винрейт {wr} против {otherWr} у противоположного.')
            .replace('{side}', label)
            .replace('{pnl}', U.escapeHtml(U.money(better.pnl, { sign: true })))
            .replace('{wr}', U.percent(better.winRate, 0))
            .replace('{otherWr}', U.percent((better === longGroup ? shortGroup : longGroup).winRate, 0))
        });
      }
    }

    if (out.length < 3 && m.avgDiscipline > 0) {
      if (m.avgDiscipline < 3.5) {
        out.push({
          tone: 'warn', icon: '◎',
          text: T('Средняя дисциплина <b>{score} / 5</b>. Сделки вне плана заметно ухудшают результат — начните с чек-листа перед входом.')
            .replace('{score}', decimal(m.avgDiscipline, 1))
        });
      } else if (m.avgDiscipline >= 4.2) {
        out.push({
          tone: 'pos', icon: '✓',
          text: T('Средняя дисциплина <b>{score} / 5</b>. Вы стабильно следуете плану — это важнее отдельной прибыльной сделки.')
            .replace('{score}', decimal(m.avgDiscipline, 1))
        });
      }
    }

    if (!out.length && m.best) {
      out.push({
        tone: 'pos', icon: '★',
        text: T('Лучшая сделка периода — <b>{symbol}</b> на <b class="pos">{pnl}</b>. Продолжайте собирать статистику: для выводов нужно больше сделок.')
          .replace('{symbol}', U.escapeHtml(m.best.trade.symbol))
          .replace('{pnl}', U.escapeHtml(U.money(m.best.pnl, { sign: true })))
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
        '<sub>' + U.escapeHtml(T('{count} {unit} · винрейт {wr}').replace('{count}', group.count).replace('{unit}', pluralTrades(group.count)).replace('{wr}', group.count ? U.percent(group.winRate, 0) : '—')) + '</sub>' +
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
      const skip = typeof options.labelSkip === 'function' ? options.labelSkip(group.key) : !!options.labelSkip;
      const width = group.pnl === 0 ? 0 : Math.max(3, Math.abs(group.pnl) / max * 100);
      return '<div class="hb-row" title="' + U.escapeHtml(T('{count} {unit} · винрейт {wr}').replace('{count}', group.count).replace('{unit}', pluralTrades(group.count)).replace('{wr}', U.percent(group.winRate, 0))) + '">' +
        '<div class="hb-top"><span class="hb-label"' + (skip ? ' data-i18n-skip' : '') + '>' + U.escapeHtml(label) +
        '<small>' + group.count + '</small></span>' +
        '<span class="hb-value ' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</span></div>' +
        '<div class="hb-track"><div class="hb-fill ' + (group.pnl < 0 ? 'neg' : '') + '" style="width:' + width + '%"></div></div></div>';
    }).join('');
  }

  function renderQuality(m) {
    const withR = m.rows.filter(function (row) { return row.r !== null; }).length;
    const discipline = m.avgDiscipline > 0 ? decimal(m.avgDiscipline, 1) + ' / 5' : '—';
    const totalR = withR ? U.rfmt(m.totalR, { sign: true }) : '—';
    const beWr = m.beWinRate !== null ? U.percent(m.beWinRate, 0) : '—';
    const beTone = m.beWinRate !== null ? (m.winRate >= m.beWinRate ? 'pos' : 'neg') : '';
    const ror = m.returnOnClosedRisk !== null
      ? (m.returnOnClosedRisk > 0 ? '+' : '') + U.percent(m.returnOnClosedRisk, 1)
      : '—';
    $('#qualityBlock').innerHTML =
      '<div class="quality-row"><span>Всего R</span><b class="' + (withR ? toneClass(m.totalR) : '') + '">' + U.escapeHtml(totalR) + '</b></div>' +
      '<div class="quality-row"><span>Безубыточный винрейт (мин.)</span><b class="' + beTone + '">' + U.escapeHtml(beWr) + '</b></div>' +
      '<div class="quality-row"><span>Доходность на закрытый риск</span><b class="' + (m.returnOnClosedRisk !== null ? toneClass(m.returnOnClosedRisk) : '') + '">' + U.escapeHtml(ror) + '</b></div>' +
      '<div class="quality-row"><span>Сделок с рассчитанным R</span><b>' + U.escapeHtml(T('{withR} из {total}').replace('{withR}', withR).replace('{total}', m.count)) + '</b></div>' +
      '<div class="quality-row"><span>Средняя дисциплина</span><b>' + discipline + '</b></div>' +
      '<div class="quality-row"><span>Комиссии и издержки</span><b class="neg">' + U.escapeHtml(U.money(-m.fees)) + '</b></div>' +
      '<div class="quality-row"><span>Средняя прибыль</span><b class="pos">' + U.escapeHtml(U.money(m.avgWin)) + '</b></div>' +
      '<div class="quality-row"><span>Средний убыток</span><b class="neg">' + U.escapeHtml(U.money(-m.avgLoss)) + '</b></div>' +
      '<div class="quality-row"><span>Серия побед</span><b>' + m.maxWinStreak + '</b></div>' +
      '<div class="quality-row"><span>Серия поражений</span><b>' + m.maxLossStreak + '</b></div>';
  }

  function renderStatsTable(tbody, groups, emptyMessage, labelOpts) {
    if (!tbody) return;
    labelOpts = labelOpts || {};
    if (!groups.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted-2);padding:24px">' + U.escapeHtml(T(emptyMessage || 'Нет данных за период')) + '</td></tr>';
      return;
    }
    tbody.innerHTML = groups.map(function (group) {
      const pf = group.profitFactor === Infinity ? '∞' : decimal(group.profitFactor, 2);
      const hasR = group.rCount > 0;
      const isEmpty = group.key === '__EMPTY__';
      const label = labelOpts.format
        ? labelOpts.format(group.key, isEmpty)
        : (isEmpty ? T(labelOpts.emptyKeyLabel || 'Без категории') : group.key);
      const skip = typeof labelOpts.skip === 'function' ? labelOpts.skip(group.key, isEmpty) : !isEmpty;
      return '<tr><td' + (skip ? ' data-i18n-skip' : '') + '>' + U.escapeHtml(label) + '</td>' +
        '<td class="num">' + group.count + '</td>' +
        '<td class="num">' + U.percent(group.winRate, 0) + '</td>' +
        '<td class="num ' + (hasR ? toneClass(group.avgR) : '') + '">' + (hasR ? U.escapeHtml(U.rfmt(group.avgR, { sign: true })) : '—') + '</td>' +
        '<td class="num ' + toneClass(group.pnl) + '">' + U.escapeHtml(U.money(group.pnl, { sign: true })) + '</td>' +
        '<td class="num">' + pf + '</td></tr>';
    }).join('');
  }

  function formatMonthKey(key) {
    if (!/^\d{4}-\d{2}$/.test(key || '')) return key || '—';
    const parts = key.split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, 1));
    const locale = NS.i18n && NS.i18n.locale ? NS.i18n.locale() : 'ru-RU';
    try {
      return U.capitalize(new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dt));
    } catch (err) {
      return key;
    }
  }

  function renderSetupTable(rows) {
    const groups = store.groupRows(rows, function (t) { return t.setup || '__EMPTY__'; })
      .sort(function (a, b) { return b.pnl - a.pnl; });
    renderStatsTable($('#setupTableBody'), groups, 'Нет данных за период', { emptyKeyLabel: 'Без сетапа' });
  }

  function renderMonthTable(rows) {
    const groups = store.groupRows(rows, function (t) { return (t.date || '').slice(0, 7) || '__EMPTY__'; })
      .sort(function (a, b) { return b.key.localeCompare(a.key); });
    renderStatsTable($('#monthTableBody'), groups, 'Нет данных за период', {
      emptyKeyLabel: 'Без даты',
      format: function (key, isEmpty) { return isEmpty ? T('Без даты') : formatMonthKey(key); },
      skip: function (key, isEmpty) { return !isEmpty; }
    });
  }

  function renderTagTable(rows) {
    const groups = store.groupRows(rows, function (t) {
      return t.tags && t.tags.length ? t.tags : ['__EMPTY__'];
    }).sort(function (a, b) { return b.pnl - a.pnl; });
    renderStatsTable($('#tagTableBody'), groups, 'Нет данных за период', { emptyKeyLabel: 'Без тега' });
  }

  /* ============================================================
     Journal
     ============================================================ */

  function fillJournalFilterOptions(notes) {
    const moodSel = $('#journalMoodFilter');
    if (moodSel) {
      const currentMood = state.journalFilters.mood;
      const moods = Object.keys(NS.MOODS || {});
      moodSel.innerHTML = '<option value="all">' + T('Все настроения') + '</option>' + moods.map(function (key) {
        const meta = U.moodMeta(key);
        return '<option value="' + U.escapeHtml(key) + '">' + U.escapeHtml(meta.emoji + ' ' + meta.label) + '</option>';
      }).join('');
      moodSel.value = (currentMood !== 'all' && moods.indexOf(currentMood) !== -1) ? currentMood : 'all';
      state.journalFilters.mood = moodSel.value;
    }

    const tagSel = $('#journalTagFilter');
    if (tagSel) {
      const currentTag = state.journalFilters.tag;
      const tagsSet = new Set();
      (notes || []).forEach(function (note) {
        (note.tags || []).forEach(function (tag) { if (tag) tagsSet.add(tag); });
      });
      const tags = Array.from(tagsSet).sort();
      tagSel.innerHTML = '<option value="all">' + T('Все теги') + '</option>' + tags.map(function (tag) {
        return '<option data-i18n-skip value="' + U.escapeHtml(tag) + '">' + U.escapeHtml(tag) + '</option>';
      }).join('');
      if (currentTag !== 'all' && tags.indexOf(currentTag) === -1) {
        state.journalFilters.tag = 'all';
        tagSel.value = 'all';
      } else {
        tagSel.value = currentTag;
      }
    }
  }

  function getFilteredNotes(notes) {
    const sorted = (notes || store.state.notes).slice().sort(function (a, b) {
      return (b.date + String(b.createdAt)).localeCompare(a.date + String(a.createdAt));
    });
    const q = (state.journalFilters.search || '').trim().toLowerCase();
    const mood = state.journalFilters.mood;
    const tag = state.journalFilters.tag;
    return sorted.filter(function (note) {
      if (mood !== 'all' && note.mood !== mood) return false;
      if (tag !== 'all' && (!Array.isArray(note.tags) || note.tags.indexOf(tag) === -1)) return false;
      if (q) {
        const hay = ((note.title || '') + ' ' + (note.text || '') + ' ' + ((note.tags || []).join(' '))).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function resetJournalFilters() {
    state.journalFilters = { search: '', mood: 'all', tag: 'all' };
    if ($('#journalSearch')) $('#journalSearch').value = '';
    if ($('#journalMoodFilter')) $('#journalMoodFilter').value = 'all';
    if ($('#journalTagFilter')) $('#journalTagFilter').value = 'all';
    renderJournal();
  }

  function renderJournal() {
    const notes = store.state.notes.slice().sort(function (a, b) {
      return (b.date + String(b.createdAt)).localeCompare(a.date + String(a.createdAt));
    });
    fillJournalFilterOptions(notes);
    const filtered = getFilteredNotes(notes);
    const countLabel = $('#journalCountLabel');
    if (countLabel) {
      countLabel.textContent = notes.length
        ? T('Показано {shown} из {total}').replace('{shown}', filtered.length).replace('{total}', notes.length)
        : '';
    }

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

    if (!filtered.length) {
      container.innerHTML = '<div class="card empty-state" style="grid-column:1/-1">' +
        '<div class="empty-icon">🔍</div><h3>' + T('По заданным фильтрам записей нет') + '</h3>' +
        '<p>' + T('Попробуйте изменить поисковый запрос, настроение или тег.') + '</p>' +
        '<div class="empty-actions"><button class="btn btn-ghost" data-action="clear-journal-filters">' + T('Сбросить фильтры') + '</button></div></div>';
      return;
    }

    const dayStats = store.dayPnlMap(store.state.trades);

    container.innerHTML = filtered.map(function (note) {
      const mood = U.moodMeta(note.mood);
      const day = dayStats.get(note.date) || { pnl: 0, count: 0 };
      return '<article class="note-card" style="--mood:' + mood.color + '">' +
        '<div class="note-head"><span class="note-date">' + U.escapeHtml(U.formatDate(note.date, 'long')) +
        '<span>' + U.escapeHtml(U.formatDate(note.date, 'weekday')) + '</span></span>' +
        '<span class="mood-chip">' + mood.emoji + ' ' + U.escapeHtml(mood.label) + '</span></div>' +
        (day.realizedCount ? '<span class="note-daypnl ' + toneClass(day.pnl) + '">' + U.escapeHtml(U.money(day.pnl, { sign: true })) + ' · ' + day.count + ' ' + pluralTrades(day.count) + '</span>' : '') +
        '<h3 data-i18n-skip>' + U.escapeHtml(note.title || T('Без заголовка')) + '</h3>' +
        '<p class="note-text" data-i18n-skip>' + U.escapeHtml(note.text) + '</p>' +
        (note.tags.length ? '<div class="note-tags" data-i18n-skip>' + note.tags.map(function (tag) { return '<span class="tag">' + U.escapeHtml(tag) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="note-foot"><span>' + U.escapeHtml(day.count ? T('{count} {unit} в этот день').replace('{count}', day.count).replace('{unit}', pluralTrades(day.count)) : T('без сделок')) + '</span>' +
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

    const distance = entry !== null && stop !== null ? Math.abs(entry - stop) : null;

    let error = '';
    if (balance !== null && balance <= 0) error = 'Укажите баланс счёта больше нуля.';
    else if (riskPct !== null && (riskPct < 0 || riskPct > 100)) error = 'Риск на сделку должен быть от 0 до 100%.';
    else if (pointValue !== null && pointValue <= 0) error = 'Стоимость пункта должна быть больше нуля.';
    else if (entry !== null && entry <= 0) error = 'Цена входа должна быть больше нуля.';
    else if (stop !== null && stop < 0) error = 'Стоп-лосс не может быть отрицательным.';
    else if (target !== null && target < 0) error = 'Тейк-профит не может быть отрицательным.';
    else if (entry !== null && stop !== null && Math.abs(entry - stop) < 1e-12) error = 'Стоп-лосс не может совпадать с ценой входа.';
    else if (entry !== null && stop !== null && target !== null && distance > 0 && (target - entry) * (stop - entry) > 0) {
      error = 'Стоп и тейк должны находиться по разные стороны от входа.';
    }

    const riskAmount = !error && balance !== null && riskPct !== null ? balance * riskPct / 100 : null;
    let quantity = null;
    let notional = null;

    if (!error && riskAmount !== null && distance !== null && distance > 0 && pointValue !== null && pointValue > 0) {
      quantity = riskAmount / (distance * pointValue);
      if (entry !== null) notional = quantity * entry * pointValue;
    }

    let rr = null;
    if (!error && entry !== null && stop !== null && target !== null && distance > 0) {
      rr = Math.abs(target - entry) / distance;
    }
    const potentialProfit = rr !== null && riskAmount !== null ? riskAmount * rr : null;

    $('#calcQtyValue').textContent = !error && quantity !== null ? U.qty(quantity) : '—';
    $('#calcNotional').textContent = T('Номинал') + ': ' + (!error && notional !== null ? U.money(notional) : '—');
    $('#calcRiskAmount').textContent = !error && riskAmount !== null ? U.money(riskAmount) : '—';
    $('#calcLoss').textContent = !error && riskAmount !== null ? U.money(-riskAmount) : '—';
    $('#calcProfit').textContent = !error && potentialProfit !== null ? U.money(potentialProfit, { sign: true }) : '—';
    $('#calcRR').textContent = !error && rr !== null ? '1 : ' + decimal(rr, 2) : '—';

    $('#calcError').hidden = !error;
    if (error) $('#calcError').textContent = T(error);

    const visual = $('#rrVisual');
    if (!error && rr !== null && rr > 0 && riskAmount !== null) {
      visual.hidden = false;
      const riskShare = (1 / (1 + rr)) * 100;
      $('#rrRisk').style.flexBasis = riskShare + '%';
      $('#rrReward').style.flexBasis = (100 - riskShare) + '%';
      $('#rrRisk span').textContent = T('Риск') + ' ' + U.money(riskAmount);
      $('#rrReward span').textContent = T('Прибыль') + ' ' + U.money(potentialProfit);
    } else {
      visual.hidden = true;
    }

    let hint = T('Заполните вход и стоп, чтобы увидеть размер позиции.');
    if (error) {
      hint = '';
    } else if (quantity !== null) {
      hint = T('При риске {pct} ({risk}) и стопе {stop} размер позиции — {qty}. Убыток по стопу ограничен {risk}.')
        .replace('{pct}', U.percent(riskPct, 1))
        .replace(/\{risk\}/g, U.money(riskAmount))
        .replace('{stop}', U.price(stop))
        .replace('{qty}', U.qty(quantity));
    } else if (balance === null || riskPct === null) {
      hint = T('Укажите баланс и риск на сделку.');
    }
    $('#calcHint').textContent = hint;
    $('#calcHint').style.display = hint ? '' : 'none';
  }

  /* ============================================================
     Settings & data
     ============================================================ */

  let tzOptionsCache = null;

  function fillTimezoneOptions(selected) {
    const select = $('#settingTimezone');
    if (!select) return;
    const hourKey = U.locale() + '|' + Math.floor(Date.now() / 3600000);
    if (!tzOptionsCache || tzOptionsCache.key !== hourKey) {
      let supported = [];
      try {
        if (typeof Intl.supportedValuesOf === 'function') supported = Intl.supportedValuesOf('timeZone');
      } catch (err) { supported = []; }
      const common = COMMON_TIMEZONES.filter(function (zone) { return U.validTimeZone(zone); });
      const seen = new Set();
      const all = [];
      common.concat(supported).forEach(function (zone) {
        if (!zone || seen.has(zone) || !U.validTimeZone(zone)) return;
        seen.add(zone);
        all.push(zone);
      });
      const commonSet = new Set(common);
      const rest = all.filter(function (zone) { return !commonSet.has(zone); });
      const now = new Date();
      const offsetLabel = function (zone) {
        return U.escapeHtml(zone + ' · ' + U.timeZoneOffsetLabel(zone, now));
      };
      const option = function (zone) {
        return '<option value="' + U.escapeHtml(zone) + '">' + offsetLabel(zone) + '</option>';
      };
      tzOptionsCache = {
        key: hourKey,
        zones: seen,
        select: null,
        html:
          '<optgroup label="' + U.escapeHtml(T('Популярные')) + '">' + common.map(option).join('') + '</optgroup>' +
          (rest.length ? '<optgroup label="' + U.escapeHtml(T('Все часовые пояса')) + '">' + rest.map(option).join('') + '</optgroup>' : '')
      };
    }
    const extraNeeded = !!(selected && U.validTimeZone(selected) && !tzOptionsCache.zones.has(selected));
    if (tzOptionsCache.select !== select || extraNeeded || tzOptionsCache.extra !== (extraNeeded ? selected : '')) {
      let html = tzOptionsCache.html;
      if (extraNeeded) {
        html += '<option value="' + U.escapeHtml(selected) + '">' +
          U.escapeHtml(selected + ' · ' + U.timeZoneOffsetLabel(selected, new Date())) + '</option>';
      }
      select.innerHTML = html;
      tzOptionsCache.select = select;
      tzOptionsCache.extra = extraNeeded ? selected : '';
    }
    if (selected && U.validTimeZone(selected)) select.value = selected;
  }

  function sessionRowHtml(session) {
    return '<div class="session-setting-row" data-session-key="' + U.escapeHtml(session.key) + '">' +
      '<input type="text" data-session-name data-i18n-skip maxlength="24" value="' + U.escapeHtml(session.name) + '" aria-label="' + T('Название сессии') + '" autocomplete="off">' +
      '<span class="session-dash">' + T('с') + '</span>' +
      '<input type="time" data-session-start value="' + U.escapeHtml(session.start) + '" aria-label="' + T('Начало сессии') + '">' +
      '<button type="button" class="session-remove" data-remove-session aria-label="' + T('Удалить сессию') + '" title="' + T('Удалить сессию') + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>' +
      '</button></div>';
  }

  function syncSessionRemoveButtons() {
    const rows = $$('#sessionSettings .session-setting-row');
    rows.forEach(function (row) {
      const button = row.querySelector('[data-remove-session]');
      if (button) button.disabled = rows.length <= 1;
    });
  }

  const STARTER_CHECKLIST_RULES = [
    'Соответствует тренду и структуре рынка',
    'Соотношение R:R не ниже 1 : 2',
    'Определён уровень стоп-лосса и объём',
    'Нет важных новостей и эмоционального тильта'
  ];

  function checklistRuleRowHtml(text, index) {
    return '<div class="checklist-setting-row">' +
      '<input type="text" data-checklist-rule="' + index + '" maxlength="120" value="' + U.escapeHtml(text) + '" placeholder="' + U.escapeHtml(T('Текст правила…')) + '" aria-label="' + U.escapeHtml(T('Правило чек-листа')) + ' ' + (index + 1) + '">' +
      '<button type="button" class="icon-btn" data-remove-rule="' + index + '" title="' + U.escapeHtml(T('Удалить правило')) + '" aria-label="' + U.escapeHtml(T('Удалить правило')) + '">×</button>' +
      '</div>';
  }

  function renderChecklistSettings(rules) {
    const box = $('#checklistSettings');
    if (!box) return;
    const list = Array.isArray(rules) ? rules : (store.state.settings.checklist || []);
    if (!list.length) {
      box.innerHTML = '<div class="checklist-empty">' + T('Правила пока не добавлены. Нажмите «+ Добавить правило» или загрузите базовый набор.') + '</div>';
      return;
    }
    box.innerHTML = list.map(checklistRuleRowHtml).join('');
  }

  function readChecklistSettings() {
    const inputs = $$('#checklistSettings [data-checklist-rule]');
    const out = [];
    const seen = new Set();
    inputs.forEach(function (input) {
      if (out.length >= (store.MAX_CHECKLIST || 20)) return;
      const text = String(input.value || '').trim().slice(0, 120);
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    });
    return out;
  }

  function addChecklistRuleRow(text) {
    const existing = readChecklistSettings();
    const max = store.MAX_CHECKLIST || 20;
    if (existing.length >= max) {
      toast(T('Слишком много правил: максимум {max}.').replace('{max}', max), 'warn', null, { skip: true });
      return;
    }
    const list = existing.concat([text || '']);
    renderChecklistSettings(list);
    const inputs = $$('#checklistSettings [data-checklist-rule]');
    const last = inputs[inputs.length - 1];
    if (last && !text) last.focus();
  }

  function loadStarterChecklistRules() {
    const existing = readChecklistSettings();
    const seen = new Set(existing.map(function (r) { return r.toLowerCase(); }));
    const merged = existing.slice();
    STARTER_CHECKLIST_RULES.forEach(function (rule) {
      const translated = T(rule);
      if (seen.has(translated.toLowerCase()) || merged.length >= (store.MAX_CHECKLIST || 20)) return;
      seen.add(translated.toLowerCase());
      merged.push(translated);
    });
    renderChecklistSettings(merged);
    toast('Базовые правила загружены в список');
  }

  function renderSessionSettings() {
    const box = $('#sessionSettings');
    if (!box) return;
    const sessions = store.state.settings.sessions || U.normalizeSessions();
    box.innerHTML = sessions.map(sessionRowHtml).join('');
    syncSessionRemoveButtons();
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

  function timeToMinutes(time) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function nextSessionStart(sessions) {
    const starts = new Set(sessions.map(function (session) { return session.start; }));
    if (!sessions.length) return '00:00';
    const sorted = sessions.slice().sort(function (a, b) { return a.start.localeCompare(b.start); });
    let minutes = (timeToMinutes(sorted[sorted.length - 1].start) + 60) % 1440;
    for (let i = 0; i < 48; i++) {
      const value = pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
      if (!starts.has(value)) return value;
      minutes = (minutes + 30) % 1440;
    }
    return '00:00';
  }

  function nextSessionName(sessions) {
    const base = T('Сессия');
    const names = new Set(sessions.map(function (session) { return session.name.toLowerCase(); }));
    let index = sessions.length + 1;
    let name = base + ' ' + index;
    while (names.has(name.toLowerCase())) {
      index += 1;
      name = base + ' ' + index;
    }
    return name;
  }

  function addSessionRow() {
    const box = $('#sessionSettings');
    if (!box) return;
    const sessions = readSessionSettings();
    const session = {
      key: U.newSessionKey(),
      name: nextSessionName(sessions),
      start: nextSessionStart(sessions)
    };
    box.insertAdjacentHTML('beforeend', sessionRowHtml(session));
    syncSessionRemoveButtons();
    const rows = $$('#sessionSettings .session-setting-row');
    const input = rows[rows.length - 1].querySelector('[data-session-name]');
    if (input) input.focus();
    renderClockSettings();
  }

  function renderClockSettings() {
    const select = $('#settingTimezone');
    const zone = select && U.validTimeZone(select.value) ? select.value : U.systemTimeZone();
    const now = new Date();
    const zoned = U.utcToZoned(now.toISOString(), zone);
    const offset = U.timeZoneOffsetLabel(zone, now);
    const nowLabel = $('#timezoneNow');
    if (nowLabel) nowLabel.textContent = T('Сейчас') + ': ' + (zoned ? zoned.time : '—') + ' · ' + offset;

    const nameLabel = $('#sessionNowName');
    const metaLabel = $('#sessionNowMeta');
    if (!nameLabel || !metaLabel) return;
    const sessions = U.normalizeSessions(readSessionSettings());
    const info = zoned ? U.sessionInfo(zoned.time, sessions) : null;
    if (!info) {
      nameLabel.textContent = '—';
      metaLabel.textContent = '';
      return;
    }
    nameLabel.textContent = info.label;
    if (sessions.length > 1) {
      const index = sessions.findIndex(function (session) { return session.key === info.key; });
      const next = sessions[(index + 1) % sessions.length];
      metaLabel.textContent = T('до') + ' ' + next.start;
    } else {
      metaLabel.textContent = T('круглосуточно');
    }
  }

  function renderSettings() {
    const settings = store.state.settings;
    const account = store.activeAccount();
    const profile = store.state.profile || {};

    fillTimezoneOptions(settings.timezone || U.systemTimeZone());
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
    renderClockSettings();
    renderChecklistSettings();
    $('#settingsSavedAt').textContent = '';
    setVersionLabel(APP_VERSION);

    renderStorageMeter(store.storageSize(), (desktop || store.usesIdbJournal) ? 100 * 1024 * 1024 : 5 * 1024 * 1024);
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

    const presetBox = $('#themePresets');
    if (presetBox) {
      const activeId = prefs.preset || findMatchingPresetId(prefs.theme, accent, bg, panel);
      presetBox.innerHTML = NS.prefs.PRESETS.map(function (item) {
        const active = item.id === activeId;
        const preview = '--preset-bg:' + item.bg + ';--preset-panel:' + item.panel + ';--preset-accent:' + item.accent;
        return '<button type="button" class="preset-card' + (active ? ' active' : '') + '"' +
          ' data-preset-id="' + item.id + '" aria-pressed="' + (active ? 'true' : 'false') + '"' +
          ' title="' + U.escapeHtml(T(item.label)) + '" style="' + preview + '">' +
          '<span class="preset-preview" aria-hidden="true"><i></i><i></i><i></i></span>' +
          '<span class="preset-name"><span>' + U.escapeHtml(T(item.label)) + '</span>' +
          '<svg class="preset-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
          '</span></button>';
      }).join('');
    }
  }

  // Resolved colors can match a preset even when the saved id was cleared
  // (for example after switching theme back to a preset's values).
  function findMatchingPresetId(theme, accent, bg, panel) {
    const found = NS.prefs.PRESETS.filter(function (item) {
      return item.theme === theme &&
        item.accent.toLowerCase() === accent.toLowerCase() &&
        item.bg.toLowerCase() === bg.toLowerCase() &&
        item.panel.toLowerCase() === panel.toLowerCase();
    });
    return found.length ? found[0].id : '';
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
    const idbJournal = store.usesIdbJournal;
    note.textContent = T(idbJournal
      ? 'Журнал и скриншоты хранятся в IndexedDB. Считаем размер хранилища…'
      : 'Скриншоты хранятся в IndexedDB. Считаем размер хранилища…');
    Promise.all([store.storageEstimate(), store.isStoragePersisted()]).then(function (results) {
      if (!note.isConnected) return;
      const data = results[0];
      const persisted = results[1] === true;
      if (!data) {
        note.textContent = T(idbJournal
          ? 'Журнал и скриншоты хранятся в IndexedDB. Браузер не сообщает точный размер хранилища.'
          : 'Скриншоты хранятся в IndexedDB. Браузер не сообщает точный размер хранилища.') +
          (persisted ? ' ' + T('Постоянное хранилище включено.') : '');
        return;
      }
      renderStorageMeter(data.usage, data.quota);
      const pct = data.usage / data.quota * 100;
      note.textContent = T(idbJournal
        ? 'Оценка браузера: {used} из {quota} ({pct}). Журнал и скриншоты хранятся в IndexedDB.'
        : 'Оценка браузера: {used} из {quota} ({pct}). Скриншоты хранятся в IndexedDB.')
        .replace('{used}', U.bytes(data.usage))
        .replace('{quota}', U.bytes(data.quota))
        .replace('{pct}', U.percent(pct, 1)) +
        (persisted ? ' ' + T('Постоянное хранилище включено.') : '');
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
    button.textContent = T('Скачать и установить');
  }

  async function checkDesktopUpdate(manual) {
    if (!desktop || typeof desktop.checkUpdate !== 'function' || desktopUpdate.checking || desktopUpdate.installing) return;
    if (desktop.platform === 'darwin') {
      setDesktopUpdateStatus(T('Для macOS обновления устанавливаются вручную: скачайте новый DMG со страницы релизов.'));
      return;
    }
    desktopUpdate.checking = true;
    const button = $('#checkUpdateBtn');
    if (button) {
      button.disabled = true;
      button.textContent = T('Проверяем…');
    }
    if (manual) setDesktopUpdateStatus(T('Проверяем обновления…'));
    try {
      const info = await desktop.checkUpdate();
      const current = info && info.currentVersion ? String(info.currentVersion) : APP_VERSION;
      setDesktopVersionLabel(current);
      desktopUpdate.available = !!(info && info.available);
      desktopUpdate.version = info && info.version ? String(info.version) : '';
      if (desktopUpdate.available) {
        setDesktopUpdateStatus(T('Доступна версия {version}. Можно скачать и установить её здесь.').replace('{version}', desktopUpdate.version || '—'), 'pos');
        setDownloadUpdateButton(true);
        showUpdateBanner(
          T('Доступно обновление TradeJournal'),
          T('Версия {version} готова к установке. Приложение скачает обновление и перезапустится.').replace('{version}', desktopUpdate.version || ''),
          T('Установить')
        );
      } else {
        setDesktopUpdateStatus(T('Установлена последняя версия ({version}).').replace('{version}', current), 'pos');
        setDownloadUpdateButton(false);
      }
    } catch (err) {
      const message = err && err.message ? err.message : T('неизвестная ошибка');
      setDesktopUpdateStatus(T('Не удалось проверить обновления: {error}').replace('{error}', message), 'neg');
    } finally {
      desktopUpdate.checking = false;
      if (button) {
        button.disabled = false;
        button.textContent = T('Проверить обновления');
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
      bannerButton.textContent = T('Устанавливаем…');
    }
    if (downloadButton) {
      downloadButton.disabled = true;
      downloadButton.textContent = T('Скачиваем…');
    }
    if (checkButton) checkButton.disabled = true;
    setDesktopUpdateStatus(T('Скачиваем и устанавливаем обновление…'));
    try {
      await desktop.installUpdate();
      desktopUpdate.available = false;
      setDesktopUpdateStatus(T('Обновление установлено. Приложение перезапустится.'), 'pos');
      const banner = $('#updateBanner');
      if (banner) banner.hidden = true;
      setDownloadUpdateButton(false);
      toast('Обновление установлено. Приложение перезапустится.');
    } catch (err) {
      const message = err && err.message ? err.message : T('неизвестная ошибка');
      setDesktopUpdateStatus(T('Не удалось установить обновление: {error}').replace('{error}', message), 'neg');
      toast(T('Не удалось установить обновление: {error}').replace('{error}', message), 'error', null, { skip: true });
      if (bannerButton) {
        bannerButton.disabled = false;
        bannerButton.textContent = T('Установить');
      }
      if (downloadButton) {
        downloadButton.disabled = false;
        downloadButton.textContent = T('Скачать и установить');
      }
    } finally {
      desktopUpdate.installing = false;
      if (checkButton) checkButton.disabled = false;
      if (bannerButton && desktopUpdate.available) {
        bannerButton.disabled = false;
        bannerButton.textContent = T('Установить');
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
      const badge = document.querySelector('.desktop-badge');
      if (badge && info && info.platform) {
        const labels = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
        badge.textContent = labels[info.platform] || 'Desktop';
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
        ? '<p class="muted small">' + U.escapeHtml(T('Показаны последние {visible} из {total} копий. Остальные лежат в папке backups.').replace('{visible}', visible.length).replace('{total}', backups.length)) + '</p>'
        : '');
    } catch (err) {
      list.innerHTML = '<p class="muted small">' + U.escapeHtml(T('Не удалось прочитать список резервных копий. Откройте папку данных вручную.')) + '</p>';
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
      note.textContent = T('Показаны первые {visible} из {total}. Кнопка удалит все найденные неиспользуемые файлы.')
        .replace('{visible}', visible.length)
        .replace('{total}', unused.length);
    } else {
      note.hidden = true;
      note.textContent = '';
    }
    $('#unusedSummary').textContent = U.bytes(data.unusedSize || 0);
    button.disabled = false;
    button.textContent = T('Удалить неиспользуемые ({count} · {size})')
      .replace('{count}', unused.length)
      .replace('{size}', U.bytes(data.unusedSize || 0));
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

    const translateMsg = desktop && typeof desktop.translateMessage === 'function'
      ? desktop.translateMessage
      : T;
    const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean).map(translateMsg) : [];
    const parts = [
      T('Ссылок на скриншоты в журнале и копиях: {count}.').replace('{count}', data.referencedCount || 0)
    ];
    if (warnings.length) {
      parts.push(warnings.join(' '));
    }
    if (data.missingCount) {
      parts.push(T('Не хватает файлов по ссылкам: {count} — возможно, они были удалены вручную.').replace('{count}', data.missingCount));
    }
    if (data.unusedCount) {
      parts.push(
        T('Найдено неиспользуемых файлов: {count} на {size}.')
          .replace('{count}', data.unusedCount)
          .replace('{size}', U.bytes(data.unusedSize || 0))
      );
    } else if (warnings.length) {
      parts.push(T('Очистка неиспользуемых файлов отключена, пока есть повреждённые файлы.'));
    } else {
      parts.push(T('Неиспользуемых скриншотов не найдено.'));
    }
    setStorageHealthStatus(parts.join(' '), (warnings.length || data.missingCount) ? 'warn' : '');
    renderUnusedScreenshots(data);
  }

  async function scanStorageHealth(manual) {
    if (!desktop || typeof desktop.storageHealth !== 'function' || state.storageHealthScanning) return;
    state.storageHealthScanning = true;
    const button = $('#scanStorageBtn');
    if (button) {
      button.disabled = true;
      button.textContent = T('Проверяем…');
    }
    if (manual) setStorageHealthStatus(T('Проверяем журнал, скриншоты и резервные копии…'));
    try {
      const data = await desktop.storageHealth();
      renderStorageHealth(data || {});
      if (manual) toast('Хранилище проверено');
    } catch (err) {
      const message = err && err.message ? err.message : T('неизвестная ошибка');
      setStorageHealthStatus(T('Не удалось проверить хранилище: {error}').replace('{error}', message), 'error');
      if (manual) toast(T('Не удалось проверить хранилище: {error}').replace('{error}', message), 'error', null, { skip: true });
    } finally {
      state.storageHealthScanning = false;
      if (button) {
        button.disabled = false;
        button.textContent = T('Проверить');
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
      text: T('Будет удалено {count} {unit} на {size}. Файлы, на которые ссылаются журнал, предыдущая версия или резервные копии, не затрагиваются. Действие нельзя отменить.')
        .replace('{count}', unused.length)
        .replace('{unit}', pluralScreenshots(unused.length))
        .replace('{size}', U.bytes(data.unusedSize || 0)),
      textReady: true,
      okLabel: 'Удалить'
    }).then(async function (confirmed) {
      if (!confirmed) return;
      state.storageHealthCleaning = true;
      const button = $('#cleanupScreenshotsBtn');
      if (button) {
        button.disabled = true;
        button.textContent = T('Удаляем…');
      }
      try {
        const result = await desktop.cleanupUnusedScreenshots(unused.map(function (file) { return file.name; }));
        const deleted = result && result.deletedCount ? result.deletedCount : 0;
        const skippedRecent = result && result.skippedRecent ? result.skippedRecent : 0;
        const message = [];
        if (deleted) {
          message.push(
            T('Удалено {count} {unit} ({size}).')
              .replace('{count}', deleted)
              .replace('{unit}', pluralScreenshots(deleted))
              .replace('{size}', U.bytes(result.deletedSize || 0))
          );
        } else if (skippedRecent) {
          message.push(T('Недавно созданные файлы пока не удаляются — повторите проверку позже.'));
        } else {
          message.push(T('Нечего удалять: файлы уже отсутствуют или используются.'));
        }
        if (deleted && skippedRecent) {
          message.push(T('Пропущено недавно созданных файлов: {count}.').replace('{count}', skippedRecent));
        }
        toast(message.join(' '), deleted ? 'success' : 'warn', null, { skip: true });
        if (result && Array.isArray(result.failed) && result.failed.length) {
          toast(T('Не удалось удалить файлов: {count}. Проверьте папку данных.').replace('{count}', result.failed.length), 'error', null, { skip: true });
        }
        await scanStorageHealth(false);
      } catch (err) {
        const message = err && err.message ? err.message : T('неизвестная ошибка');
        setStorageHealthStatus(T('Не удалось удалить скриншоты: {error}').replace('{error}', message), 'error');
        toast(T('Не удалось удалить скриншоты: {error}').replace('{error}', message), 'error', null, { skip: true });
      } finally {
        state.storageHealthCleaning = false;
        if (state.storageHealthData) {
          renderUnusedScreenshots(state.storageHealthData);
        } else if (button) {
          button.disabled = false;
          button.textContent = T('Удалить неиспользуемые');
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
      toast(T('Не удалось создать резервную копию: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
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
      toast(T('Не удалось открыть папку данных: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
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
        state.calCursor = accountMonthStart();
        state.selectedDay = todayInAccount();
        renderAll();
        refreshDesktopBackups();
        toast('Резервная копия восстановлена');
      } catch (err) {
        toast(T('Не удалось восстановить копию: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
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

    if (!sessions.length) return toast('Добавьте хотя бы одну торговую сессию.', 'error');

    const seenNames = new Set();
    const seenStarts = new Set();
    const seenKeys = new Set();
    const cleaned = [];
    for (const session of sessions) {
      const name = String(session.name || '').trim().slice(0, 24);
      if (!name) return toast('У каждой торговой сессии должно быть название.', 'error');
      if (seenNames.has(name.toLowerCase())) return toast('Названия торговых сессий должны быть разными.', 'error');
      const start = U.validTimeHM(session.start);
      if (!start) return toast(T('Укажите время начала для сессии «{name}».').replace('{name}', name), 'error', null, { skip: true });
      if (seenStarts.has(start)) return toast('Время начала торговых сессий должно быть разным.', 'error');
      let key = String(session.key || '').trim();
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || seenKeys.has(key)) key = U.newSessionKey();
      seenNames.add(name.toLowerCase());
      seenStarts.add(start);
      seenKeys.add(key);
      cleaned.push({ key: key, name: name, start: start });
    }
    cleaned.sort(function (a, b) { return a.start.localeCompare(b.start); });

    store.state.settings = {
      currency: currency,
      startBalance: balance,
      riskPercent: risk,
      dailyLossLimit: daily,
      maxTradesPerDay: Math.round(maxTrades),
      timezone: timezone,
      sessions: cleaned,
      feePresets: store.state.settings.feePresets || [],
      checklist: readChecklistSettings()
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
        const keepAlpha = /^image\/(png|webp|gif|svg\+xml)$/i.test(file.type);
        const mime = keepAlpha ? (supportsWebpEncoding() ? 'image/webp' : 'image/png') : 'image/jpeg';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        if (!keepAlpha) {
          ctx.fillStyle = cssVar('--panel', '#101822');
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(image, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
        try {
          state.profileAvatarDraft = mime === 'image/png' ? canvas.toDataURL(mime) : canvas.toDataURL(mime, 0.84);
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
    state.calCursor = accountMonthStart();
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
    state.calCursor = accountMonthStart();
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
      text: T('Счёт «{name}» и все его сделки и записи будут удалены. Сразу после удаления действие можно будет отменить.').replace('{name}', account.name),
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
      state.calCursor = accountMonthStart();
      state.selectedDay = todayInAccount();
      renderAll();
      toast('Счёт удалён', 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          applyCurrency();
          state.calCursor = accountMonthStart();
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
    parts.push(last ? T('Последняя резервная копия: {date}.').replace('{date}', last) : T('Резервная копия ещё не создавалась.'));
    const remindLater = Date.parse(meta.remindLaterUntil);
    if (Number.isFinite(remindLater) && remindLater > Date.now()) {
      parts.push(T('Напоминание отложено до {date}.').replace('{date}', formatBackupTime(meta.remindLaterUntil)));
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
      const result = await U.download('tradejournal-' + U.todayISO() + '.json', JSON.stringify(payload, null, 2), 'application/json');
      if (!result || result.canceled || !result.ok) return;
      markBackupExported();
      toast('Резервная копия скачана');
    } catch (err) {
      toast(T('Не удалось подготовить экспорт: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
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

  function legsForCsv(legs, tradeDate) {
    return (legs || []).map(function (leg) {
      const date = leg.date && leg.date !== tradeDate ? '@' + leg.date : '';
      return plainNumber(leg.qty) + '@' + plainNumber(leg.price) + date;
    }).join('|');
  }

  function entriesForCsv(trade) {
    return trade && Array.isArray(trade.entries) && trade.entries.length > 1
      ? legsForCsv(trade.entries, trade.date)
      : '';
  }

  function exitsForCsv(trade) {
    return legsForCsv(store.tradeExits(trade), trade.date);
  }

  async function exportCSV() {
    const trades = store.sortTrades(store.state.trades, 'desc');
    const english = NS.i18n && typeof NS.i18n.lang === 'function' && NS.i18n.lang() === 'en';
    const headers = english
      ? [
        'Date', 'Time', 'Symbol', 'Side', 'Entry', 'Exit', 'Initial Stop',
        'Current Stop', 'Target', 'Qty', 'Multiplier', 'Fees', 'Entries', 'Exits',
        'Remaining', 'Status', 'P&L', 'R', 'Setup', 'Emotion', 'Discipline', 'Tags', 'Notes'
      ]
      : [
        'Дата', 'Время', 'Инструмент', 'Направление', 'Вход', 'Выход', 'Стоп при входе',
        'Текущий стоп', 'Тейк', 'Количество', 'Множитель', 'Комиссия', 'Входы', 'Выходы',
        'Остаток', 'Статус', 'P&L', 'R', 'Сетап', 'Эмоция', 'Дисциплина', 'Теги', 'Заметка'
      ];
    const lines = [headers.map(csvCell).join(';')];
    const statusLabels = english
      ? { closed: 'Closed', partial: 'Partially closed', open: 'Open' }
      : { closed: 'Закрыта', partial: 'Частично закрыта', open: 'Открыта' };
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
        csvText(entriesForCsv(trade)),
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
    const result = await U.download('tradejournal-trades-' + U.todayISO() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    if (!result || result.canceled || !result.ok) return;
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
        return sum + (account.trades || []).reduce(function (tSum, trade) {
          return tSum + store.tradeScreenshots(trade).length;
        }, 0);
      }, 0);
      const readme = [
        T('TradeJournal — резервная копия'),
        '',
        T('Версия приложения: {version}').replace('{version}', APP_VERSION),
        T('Дата экспорта: {date}').replace('{date}', exportedAt),
        T('Счетов: {accounts}, сделок: {trades}, записей журнала: {notes}, скриншотов: {shots}.')
          .replace('{accounts}', accounts.length)
          .replace('{trades}', tradeCount)
          .replace('{notes}', noteCount)
          .replace('{shots}', shotCount),
        '',
        T('Файл journal.json содержит все счета, сделки, записи и скриншоты.'),
        T('Скриншоты встроены в JSON, поэтому архив можно перенести на другое устройство.'),
        '',
        T('Как восстановить:'),
        T('1. Откройте TradeJournal.'),
        T('2. Настройки → «Импорт JSON / ZIP».'),
        T('3. Выберите journal.json из этого архива.'),
        '',
        T('Импорт заменяет текущие данные журнала. Перед восстановлением сделайте резервную копию текущего состояния.'),
        ''
      ].join('\r\n');
      const archive = NS.zip.create([
        { name: 'journal.json', data: JSON.stringify(payload, null, 2), date: new Date() },
        { name: 'README.txt', data: readme, date: new Date() }
      ]);
      const result = await U.downloadBytes('tradejournal-backup-' + U.todayISO() + '.zip', archive, 'application/zip');
      if (!result || result.canceled || !result.ok) return;
      markBackupExported();
      toast('ZIP-архив со скриншотами скачан');
    } catch (err) {
      toast(T('Не удалось подготовить ZIP-архив: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
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
    const delimiterLabels = { ';': T('точка с запятой'), ',': T('запятая'), '\t': T('табуляция') };
    summary.innerHTML = [
      [T('Файл'), data.fileName],
      [T('Строк'), stats.rows || 0],
      [T('К импорту'), result.trades.length],
      [T('Дубликаты'), result.duplicates || 0],
      [T('Выходы'), stats.exits || 0],
      [T('Разделитель'), delimiterLabels[result.delimiter] || result.delimiter]
    ].map(function (item) {
      return '<span class="chip"><b>' + U.escapeHtml(item[0]) + ':</b> <span data-i18n-skip>' + U.escapeHtml(item[1]) + '</span></span>';
    }).join('');

    const alertHtml = [];
    if (result.errors.length) {
      alertHtml.push('<div class="csv-alert error"><b>' + U.escapeHtml(T('Ошибки ({count}):').replace('{count}', result.errors.length)) + '</b> <span data-i18n-skip>' +
        U.escapeHtml(result.errors.slice(0, 6).join(' ')) +
        (result.errors.length > 6 ? ' …' : '') + '</span></div>');
    }
    if (result.warnings.length) {
      alertHtml.push('<div class="csv-alert warn"><b>' + U.escapeHtml(T('Предупреждения ({count}):').replace('{count}', result.warnings.length)) + '</b> <span data-i18n-skip>' +
        U.escapeHtml(result.warnings.slice(0, 5).join(' ')) +
        (result.warnings.length > 5 ? ' …' : '') + '</span></div>');
    }
    const account = store.activeAccount();
    alertHtml.push('<div class="csv-alert info">' +
      T('Сделки будут добавлены в активный счёт «{name}». Существующие сделки не изменятся.')
        .replace('{name}', '<span data-i18n-skip>' + U.escapeHtml(account ? account.name : '—') + '</span>') +
      '</div>');
    if (!result.trades.length) {
      alertHtml.push('<div class="csv-alert warn">' + U.escapeHtml(T('Нет строк, готовых к импорту. Исправьте файл и попробуйте снова.')) + '</div>');
    }
    alerts.innerHTML = alertHtml.join('');

    if (!result.trades.length) {
      body.innerHTML = '<tr><td colspan="8" class="csv-empty">' + U.escapeHtml(T('Нет данных для предпросмотра')) + '</td></tr>';
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
      }).join('') + (result.trades.length > 200 ? '<tr><td colspan="8" class="csv-empty">' + U.escapeHtml(T('Показаны первые 200 из {count} строк').replace('{count}', result.trades.length)) + '</td></tr>' : '');
    }
    if (confirm) {
      confirm.disabled = !result.trades.length;
      confirm.textContent = result.trades.length ? T('Импортировать {count}').replace('{count}', result.trades.length) : T('Импортировать');
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
    toast(
      T('Импортировано сделок: {added}').replace('{added}', added) +
        (skipped ? '. ' + T('Пропущено дубликатов: {skipped}').replace('{skipped}', skipped) : ''),
      'success',
      {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          applyCurrency();
          renderAll();
          toast(restored ? 'Импорт CSV отменён' : 'Не удалось отменить импорт', restored ? 'success' : 'error');
        }
      },
      { skip: true }
    );
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
        data = JSON.parse(String(reader.result || '').replace(/^\uFEFF/, ''));
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
      toast(T('Не удалось открыть ZIP-архив: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
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
    if (stats.missingSymbols) dropReasons.push(T('без символа: {count}').replace('{count}', stats.missingSymbols));
    if (stats.invalidDates) dropReasons.push(T('битая дата: {count}').replace('{count}', stats.invalidDates));
    const replacementSummary = T('Будет заменено {replaced} {replacedUnit}, {dropped} {droppedUnit} отброшено{reasons}.')
      .replace('{replaced}', currentTrades)
      .replace('{replacedUnit}', pluralTrades(currentTrades))
      .replace('{dropped}', stats.tradesDropped)
      .replace('{droppedUnit}', pluralTrades(stats.tradesDropped))
      .replace('{reasons}', dropReasons.length ? ' (' + dropReasons.join(', ') + ')' : '');
    const details = [
      T('Все счета, сделки и записи будут заменены данными из файла. Рекомендуем сначала сделать экспорт текущего журнала.'),
      replacementSummary,
      T('Сейчас: счетов {accounts}, сделок {trades}, записей {notes}.')
        .replace('{accounts}', store.state.accounts.length)
        .replace('{trades}', currentTrades)
        .replace('{notes}', currentNotes),
      T('В файле: счетов {accounts}, сделок {trades}, записей {notes}, скриншотов {shots}.')
        .replace('{accounts}', stats.accounts)
        .replace('{trades}', stats.trades)
        .replace('{notes}', stats.notes)
        .replace('{shots}', stats.screenshots),
      T('Будет импортировано: сделок {trades}, записей {notes}, скриншотов {shots}.')
        .replace('{trades}', stats.tradesAccepted)
        .replace('{notes}', stats.notesAccepted)
        .replace('{shots}', stats.screenshotsAccepted)
    ];
    if (stats.tradesDropped) {
      details.push(T('Отброшенные сделки не попадут в журнал: без символа импортировать нельзя, а битую дату не подменяем сегодняшней.'));
    }
    if (stats.notesDropped) {
      details.push(T('Не будет импортировано записей: {count}.').replace('{count}', stats.notesDropped));
    }
    if (stats.screenshotsDropped) {
      const dropped = stats.screenshotsDropped;
      const singular = dropped % 10 === 1 && dropped % 100 !== 11;
      const reasons = [];
      if (stats.screenshotsTooLarge) reasons.push(T('слишком большой размер: {count}').replace('{count}', stats.screenshotsTooLarge));
      if (stats.screenshotsInvalid) reasons.push(T('неподдерживаемый формат: {count}').replace('{count}', stats.screenshotsInvalid));
      details.push(
        T(singular
          ? 'Внимание: {count} {unit} не будет импортирован{reasons}. Эти скриншоты будут потеряны.'
          : 'Внимание: {count} {unit} не будут импортированы{reasons}. Эти скриншоты будут потеряны.')
          .replace('{count}', dropped)
          .replace('{unit}', pluralScreenshots(dropped))
          .replace('{reasons}', reasons.length ? ' (' + reasons.join(', ') + ')' : '')
      );
    }
    if (stats.fileScreenshots) {
      details.push(T('Скриншотов-ссылок на файлы: {count}. Они откроются только на ПК, где создан бэкап.').replace('{count}', stats.fileScreenshots));
    }
    details.push(T('Сразу после импорта действие можно будет отменить.'));

    askConfirm({
      title: 'Импортировать данные?',
      text: details.join(' '),
      textReady: true,
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
      clearAllDrafts();
      applyCurrency();
      state.calCursor = accountMonthStart();
      state.selectedDay = todayInAccount();
      renderAll();
      const importedAccounts = store.state.accounts.length;
      const importedTrades = store.state.accounts.reduce(function (sum, account) { return sum + account.trades.length; }, 0);
      const importedNotes = store.state.accounts.reduce(function (sum, account) { return sum + account.notes.length; }, 0);
      let importedMessage = T('Импортировано: счетов {accounts}, сделок {trades}, записей {notes}')
        .replace('{accounts}', importedAccounts)
        .replace('{trades}', importedTrades)
        .replace('{notes}', importedNotes);
      if (stats.screenshotsDropped) {
        importedMessage += '. ' + T('Не импортировано скриншотов: {count}').replace('{count}', stats.screenshotsDropped);
      }
      toast(importedMessage, stats.screenshotsDropped ? 'warn' : 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          clearAllDrafts();
          applyCurrency();
          state.calCursor = accountMonthStart();
          state.selectedDay = todayInAccount();
          renderAll();
          toast(restored ? 'Импорт отменён, прежние данные восстановлены' : 'Не удалось сохранить откат', restored ? 'success' : 'error');
        }
      }, { skip: true });
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
      state.calCursor = accountMonthStart();
      state.selectedDay = todayInAccount();
      renderAll();
      toast('Демо-данные загружены', 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          clearAccountDrafts(store.state.activeAccountId);
          applyCurrency();
          state.calCursor = accountMonthStart();
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
      state.calCursor = accountMonthStart();
      state.selectedDay = todayInAccount();
      renderAll();
      toast('Журнал очищен. Начинаем с чистого листа.', 'success', {
        label: 'Отменить',
        onClick: async function () {
          const restored = await store.replaceData(before);
          clearAccountDrafts(store.state.activeAccountId);
          applyCurrency();
          state.calCursor = accountMonthStart();
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

  const TRADE_FIELD_KEYS = ['date', 'time', 'symbol', 'entry', 'stop', 'currentStop', 'target', 'qty', 'multiplier', 'fees', 'setup', 'emotion', 'discipline', 'tags', 'notes', 'side', 'entries', 'exits', 'checklist'];

  function tradeDraftKey(accountId, tradeId) {
    return DRAFT_PREFIX + String(accountId || '') + '.' + (tradeId || 'new');
  }

  function isScreenshotValue(value) {
    if (typeof value !== 'string' || value.length > 3000000) return false;
    return /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(value)
      || /^file:screenshots\/[a-z0-9_-]{1,80}\.(?:jpe?g|png|webp)$/i.test(value)
      || /^idb:screenshots\/[a-z0-9-]{1,80}$/i.test(value);
  }

  function normalizeLegRows(rows, maxRows) {
    const result = [];
    (Array.isArray(rows) ? rows : []).slice(0, maxRows || store.MAX_EXITS || 50).forEach(function (row) {
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

  function legsFromField(value, maxRows) {
    if (!value) return [];
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return normalizeLegRows(parsed, maxRows);
    } catch (err) {
      return [];
    }
  }

  function legsToField(rows, maxRows) {
    return JSON.stringify(normalizeLegRows(rows, maxRows).map(function (row) {
      return { qty: row.qty, price: row.price, date: row.date };
    }));
  }

  function checklistForTrade(trade) {
    const saved = trade && Array.isArray(trade.checklist) ? trade.checklist : [];
    const rules = (store.state.settings && Array.isArray(store.state.settings.checklist))
      ? store.state.settings.checklist
      : [];
    const out = [];
    const seen = new Set();
    saved.forEach(function (item) {
      if (!item || !item.text || out.length >= (store.MAX_CHECKLIST || 20)) return;
      const text = String(item.text).trim().slice(0, 120);
      if (!text) return;
      seen.add(text.toLowerCase());
      out.push({ text: text, done: !!item.done });
    });
    rules.forEach(function (rule) {
      if (out.length >= (store.MAX_CHECKLIST || 20)) return;
      const text = String(rule || '').trim().slice(0, 120);
      if (!text || seen.has(text.toLowerCase())) return;
      seen.add(text.toLowerCase());
      out.push({ text: text, done: false });
    });
    return out;
  }

  function normalizeChecklistField(raw) {
    const list = [];
    let source = [];
    if (typeof raw === 'string' && raw) {
      try { source = JSON.parse(raw); } catch (err) { source = []; }
    } else if (Array.isArray(raw)) {
      source = raw;
    }
    (Array.isArray(source) ? source : []).slice(0, store.MAX_CHECKLIST || 20).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const text = String(item.text || '').trim().slice(0, 120);
      if (text) list.push({ text: text, done: !!item.done });
    });
    return list;
  }

  function checklistToField(items) {
    return JSON.stringify(normalizeChecklistField(items));
  }

  function renderTradeChecklist() {
    const field = $('#tradeChecklistField');
    const box = $('#tradeChecklistBox');
    const prog = $('#tradeChecklistProgress');
    const warn = $('#tradeChecklistWarn');
    if (!field || !box) return;
    const list = state.tradeChecklist || [];
    if (!list.length) {
      field.hidden = true;
      box.innerHTML = '';
      if (warn) warn.hidden = true;
      return;
    }
    field.hidden = false;
    const done = list.filter(function (item) { return !!item.done; }).length;
    if (prog) {
      prog.textContent = done + ' / ' + list.length;
      prog.classList.toggle('all-done', done === list.length);
    }
    if (warn) warn.hidden = done === list.length;
    box.innerHTML = list.map(function (item, index) {
      return '<label class="checklist-item' + (item.done ? ' is-done' : '') + '">' +
        '<input type="checkbox" data-check-idx="' + index + '"' + (item.done ? ' checked' : '') + '>' +
        '<span data-i18n-skip>' + U.escapeHtml(item.text) + '</span>' +
        '</label>';
    }).join('');
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
      entries: legsToField(trade && Array.isArray(trade.entries) ? trade.entries : [], store.MAX_ENTRIES),
      exits: legsToField(trade ? store.tradeExits(trade) : [], store.MAX_EXITS),
      checklist: checklistToField(checklistForTrade(trade))
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
      entries: legsToField(state.tradeEntries, store.MAX_ENTRIES),
      exits: legsToField(state.tradeExits, store.MAX_EXITS),
      checklist: checklistToField(state.tradeChecklist)
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
      const max = key === 'notes' ? 20000 : (key === 'tags' ? 2000 : (key === 'exits' || key === 'entries' || key === 'checklist' ? 20000 : 200));
      result[key] = fields[key].slice(0, max);
    });
    result.entries = legsToField(legsFromField(result.entries, store.MAX_ENTRIES), store.MAX_ENTRIES);
    result.exits = legsToField(legsFromField(result.exits, store.MAX_EXITS), store.MAX_EXITS);
    result.checklist = checklistToField(normalizeChecklistField(result.checklist));
    result.multiplier = result.multiplier || '1';
    result.side = result.side === 'short' ? 'short' : 'long';
    result.discipline = String(U.clamp(Math.round(U.parseNum(result.discipline) || 0), 0, 5));
    return result;
  }

  function setTradeEntries(rows) {
    state.tradeEntries = normalizeLegRows(rows, store.MAX_ENTRIES);
  }

  function setTradeExits(rows) {
    state.tradeExits = normalizeLegRows(rows, store.MAX_EXITS);
  }

  function entryRowsTotals() {
    let qty = 0;
    let notional = 0;
    let validCount = 0;
    state.tradeEntries.forEach(function (row) {
      const q = U.parseNum(row.qty);
      const p = U.parseNum(row.price);
      if (q !== null && q > 0 && p !== null) {
        qty += q;
        notional += q * p;
        validCount++;
      }
    });
    return {
      qty: qty,
      entry: qty > (store.QTY_EPSILON || 1e-9) ? notional / qty : null,
      count: validCount
    };
  }

  function syncEntryAggregate() {
    const hasEntries = state.tradeEntries.length > 0;
    const entryEl = $('#tradeEntry');
    const qtyEl = $('#tradeQty');
    const entryBadge = $('#tradeEntryAuto');
    const qtyBadge = $('#tradeQtyAuto');
    if (entryBadge) entryBadge.classList.toggle('hidden', !hasEntries);
    if (qtyBadge) qtyBadge.classList.toggle('hidden', !hasEntries);
    if (entryEl) entryEl.readOnly = hasEntries;
    if (qtyEl) qtyEl.readOnly = hasEntries;
    if (hasEntries) {
      const totals = entryRowsTotals();
      if (entryEl && totals.entry !== null) entryEl.value = String(totals.entry);
      if (qtyEl && totals.qty > 0) qtyEl.value = String(totals.qty);
    }
    const hint = $('#entriesHint');
    if (hint) {
      if (!hasEntries) {
        hint.textContent = T('Один вход — цена и объём заданы полями выше. Добавьте доборы, чтобы автоматически считать средневзвешенную цену входа.');
      } else {
        const totals = entryRowsTotals();
        hint.textContent = totals.entry !== null
          ? T('Входов {count}, общий объём {qty}, средневзвешенная цена {entry}.')
            .replace('{count}', totals.count)
            .replace('{qty}', U.qty(totals.qty))
            .replace('{entry}', U.price(totals.entry))
          : T('Укажите корректную цену и количество хотя бы для одного входа.');
      }
    }
    renderPositionHistory();
  }

  function renderPositionHistory() {
    const box = $('#positionHistory');
    if (!box) return;
    const validEntries = state.tradeEntries.filter(function (row) {
      return U.parseNum(row.qty) > 0 && U.parseNum(row.price) !== null;
    });
    const validExits = state.tradeExits.filter(function (row) {
      return U.parseNum(row.qty) > 0 && U.parseNum(row.price) !== null;
    });
    if (validEntries.length <= 1 && !validExits.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const steps = [];
    const baseDate = $('#tradeDate') ? $('#tradeDate').value : '';
    const entriesList = validEntries.length
      ? validEntries
      : (U.parseNum($('#tradeQty') && $('#tradeQty').value) > 0 && U.parseNum($('#tradeEntry') && $('#tradeEntry').value) !== null
        ? [{ qty: $('#tradeQty').value, price: $('#tradeEntry').value, date: baseDate }]
        : []);
    entriesList.forEach(function (leg, idx) {
      steps.push({
        kind: 'entry',
        order: 0,
        idx: idx,
        date: leg.date || baseDate || '',
        qty: U.parseNum(leg.qty),
        price: U.parseNum(leg.price)
      });
    });
    validExits.forEach(function (leg, idx) {
      steps.push({
        kind: 'exit',
        order: 1,
        idx: idx,
        date: leg.date || baseDate || '',
        qty: U.parseNum(leg.qty),
        price: U.parseNum(leg.price)
      });
    });
    steps.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.order !== b.order) return a.order - b.order;
      return a.idx - b.idx;
    });
    box.hidden = false;
    box.innerHTML = '<span class="muted" style="font-size:10px;align-self:center">' + T('История позиции:') + '</span>' + steps.map(function (step) {
      const label = step.kind === 'entry'
        ? (step.idx === 0 ? T('Вход') : T('Добор')) + ' +' + U.qty(step.qty)
        : T('Выход') + ' −' + U.qty(step.qty);
      const dateTxt = step.date ? ' (' + U.formatDate(step.date, 'short') + ')' : '';
      return '<span class="history-step is-' + step.kind + '">' + U.escapeHtml(label + ' @ ' + U.price(step.price) + dateTxt) + '</span>';
    }).join('');
  }

  function renderEntriesEditor() {
    const editor = $('#entriesEditor');
    if (!editor) {
      syncEntryAggregate();
      return;
    }
    if (!state.tradeEntries.length) {
      editor.hidden = true;
      editor.innerHTML = '';
      syncEntryAggregate();
      return;
    }
    editor.hidden = false;
    editor.innerHTML = state.tradeEntries.map(function (row, index) {
      return '<div class="exit-row" data-entry-index="' + index + '">' +
        '<input type="number" step="any" min="0" inputmode="decimal" data-entry-field="qty" value="' + U.escapeHtml(row.qty) + '" placeholder="' + T('Количество') + '" aria-label="' + T('Количество входа') + ' ' + (index + 1) + '">' +
        '<input type="number" step="any" inputmode="decimal" data-entry-field="price" value="' + U.escapeHtml(row.price) + '" placeholder="' + T('Цена входа') + '" aria-label="' + T('Цена входа') + ' ' + (index + 1) + '">' +
        '<input type="date" data-entry-field="date" data-entry-date value="' + U.escapeHtml(row.date) + '" aria-label="' + T('Дата входа') + ' ' + (index + 1) + '">' +
        '<button type="button" class="icon-btn exit-remove" data-remove-entry="' + index + '" title="' + T('Удалить вход') + '" aria-label="' + T('Удалить вход') + '">×</button>' +
        '</div>';
    }).join('');
    syncEntryAggregate();
  }

  function addEntryRow(qty, price) {
    const maxEntries = store.MAX_ENTRIES || 50;
    if (state.tradeEntries.length >= maxEntries) {
      toast(T('Слишком много входов: максимум {max}.').replace('{max}', maxEntries), 'warn', null, { skip: true });
      return;
    }
    const baseDate = $('#tradeDate') ? ($('#tradeDate').value || U.todayISO(accountTimeZone())) : U.todayISO(accountTimeZone());
    if (!state.tradeEntries.length) {
      const curQty = $('#tradeQty') ? $('#tradeQty').value.trim() : '';
      const curEntry = $('#tradeEntry') ? $('#tradeEntry').value.trim() : '';
      if (curQty || curEntry) {
        state.tradeEntries.push({ id: U.uid(), qty: curQty, price: curEntry, date: baseDate });
      }
    }
    if (state.tradeEntries.length < maxEntries) {
      state.tradeEntries.push({
        id: U.uid(),
        qty: qty === undefined || qty === null ? '' : String(qty),
        price: price === undefined || price === null ? '' : String(price),
        date: baseDate
      });
    }
    renderEntriesEditor();
    const row = $('#entriesEditor .exit-row:last-child');
    const target = row && row.querySelector('[data-entry-field="qty"]');
    if (target) target.focus();
    updateTradePreview();
    syncTradeDirty();
  }

  function removeEntryRow(index) {
    if (index < 0 || index >= state.tradeEntries.length) return;
    if (state.tradeEntries.length === 1) {
      const only = state.tradeEntries[0];
      state.tradeEntries = [];
      if ($('#tradeQty')) $('#tradeQty').value = only.qty || '';
      if ($('#tradeEntry')) $('#tradeEntry').value = only.price || '';
    } else {
      state.tradeEntries.splice(index, 1);
    }
    renderEntriesEditor();
    updateTradePreview();
    syncTradeDirty();
  }

  function formatPresetNumber(val) {
    const rounded = Math.round(val * 1e6) / 1e6;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }

  function collectFeeSuggestions() {
    const saved = Array.isArray(store.state.settings.feePresets) ? store.state.settings.feePresets : [];
    const seen = new Set(saved.map(function (v) { return Math.round(v * 1e6) / 1e6; }));
    const recent = [];
    const trades = store.state.trades || [];
    for (let i = trades.length - 1; i >= 0 && recent.length < 3; i--) {
      const fee = U.parseNum(trades[i] && trades[i].fees);
      if (fee === null || fee <= 0) continue;
      const key = Math.round(fee * 1e6) / 1e6;
      if (seen.has(key)) continue;
      seen.add(key);
      recent.push(key);
    }
    return { saved: saved, recent: recent };
  }

  function renderFeePresets() {
    const bar = $('#feePresetsBar');
    if (!bar) return;
    const feeVal = U.parseNum($('#tradeFees') ? $('#tradeFees').value : null);
    const data = collectFeeSuggestions();
    const cur = (store.state.settings && store.state.settings.currency) || '$';
    const items = [{ value: 0, label: '0', saved: false }].concat(
      data.saved.map(function (v) {
        return { value: v, label: cur + formatPresetNumber(v), saved: true };
      }),
      data.recent.map(function (v) {
        return { value: v, label: cur + formatPresetNumber(v), saved: false };
      })
    );
    bar.innerHTML = items.map(function (item) {
      const active = feeVal !== null && Math.abs(feeVal - item.value) < 1e-8;
      return '<span class="fee-chip' + (active ? ' active' : '') + '" data-fee-value="' + item.value + '" role="button" tabindex="0">' +
        '<span data-i18n-skip>' + U.escapeHtml(item.label) + '</span>' +
        (item.saved ? '<button type="button" class="fee-chip-remove" data-remove-fee-preset="' + item.value + '" aria-label="' + U.escapeHtml(T('Удалить шаблон {fee}').replace('{fee}', item.label)) + '">×</button>' : '') +
        '</span>';
    }).join('');
  }

  function moveStopToBreakeven() {
    const entry = U.parseNum($('#tradeEntry') ? $('#tradeEntry').value : null);
    if (entry === null) {
      toast('Сначала укажите цену входа.', 'warn');
      if ($('#tradeEntry')) $('#tradeEntry').focus();
      return;
    }
    $('#tradeCurrentStop').value = String(entry);
    updateTradePreview();
    syncTradeDirty();
    toast('Текущий стоп перенесён в безубыток');
  }

  async function saveFeePreset() {
    const fee = U.parseNum($('#tradeFees') ? $('#tradeFees').value : null);
    if (fee === null || fee <= 0) {
      toast('Укажите комиссию больше нуля для шаблона.', 'warn');
      return;
    }
    const val = Math.round(fee * 1e6) / 1e6;
    const list = (store.state.settings.feePresets || []).slice();
    if (!list.some(function (v) { return Math.abs(v - val) < 1e-8; })) {
      if (list.length >= (store.MAX_FEE_PRESETS || 8)) list.pop();
      list.unshift(val);
      store.state.settings.feePresets = list;
      await persist();
    }
    renderFeePresets();
    toast('Шаблон комиссии сохранён');
  }

  async function removeFeePreset(val) {
    const list = (store.state.settings.feePresets || []).filter(function (v) {
      return Math.abs(v - val) >= 1e-8;
    });
    store.state.settings.feePresets = list;
    await persist();
    renderFeePresets();
    toast('Шаблон комиссии удалён');
  }

  function renderExitsEditor() {
    const editor = $('#exitsEditor');
    if (!editor) return;
    if (!state.tradeExits.length) {
      editor.innerHTML = '<div class="exits-empty">' + T('Выходов пока нет — позиция открыта') + '</div>';
      updateExitsSummary();
      renderPositionHistory();
      return;
    }
    editor.innerHTML = state.tradeExits.map(function (row, index) {
      return '<div class="exit-row" data-exit-index="' + index + '">' +
        '<input type="number" step="any" min="0" inputmode="decimal" data-exit-field="qty" value="' + U.escapeHtml(row.qty) + '" placeholder="' + T('Количество') + '" aria-label="' + T('Количество выхода') + ' ' + (index + 1) + '">' +
        '<input type="number" step="any" inputmode="decimal" data-exit-field="price" value="' + U.escapeHtml(row.price) + '" placeholder="' + T('Цена выхода') + '" aria-label="' + T('Цена выхода') + ' ' + (index + 1) + '">' +
        '<input type="date" data-exit-field="date" data-exit-date value="' + U.escapeHtml(row.date) + '" aria-label="' + T('Дата выхода') + ' ' + (index + 1) + '">' +
        '<button type="button" class="icon-btn exit-remove" data-remove-exit="' + index + '" title="' + T('Удалить выход') + '" aria-label="' + T('Удалить выход') + '">×</button>' +
        '</div>';
    }).join('');
    updateExitsSummary();
    renderPositionHistory();
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
      text = T('Выходов нет — позиция открыта. Добавьте один или несколько частичных выходов; комиссия распределится по объёму выходов.');
    } else if (quantity === null || quantity <= 0) {
      text = T('Укажите количество в сделке, чтобы рассчитать остаток позиции.');
    } else if (totals.qty > quantity + epsilon) {
      text = T('Сумма выходов {closed} больше количества {quantity}. Уменьшите объём выходов.')
        .replace('{closed}', U.qty(totals.qty))
        .replace('{quantity}', U.qty(quantity));
    } else if (totals.remaining <= epsilon) {
      text = T('Позиция закрыта полностью: {closed} из {quantity}.')
        .replace('{closed}', U.qty(totals.qty))
        .replace('{quantity}', U.qty(quantity));
    } else {
      text = T('Закрыто {closed} из {quantity}, остаток {remaining}. Сделка останется частично открытой.')
        .replace('{closed}', U.qty(totals.qty))
        .replace('{quantity}', U.qty(quantity))
        .replace('{remaining}', U.qty(totals.remaining));
    }
    if (totals.fees > 0 && state.tradeExits.length) {
      if (quantity !== null && quantity > 0 && totals.remaining <= epsilon) {
        text += ' ' + T('Комиссия {fee} распределится между выходами пропорционально количеству.')
          .replace('{fee}', U.money(totals.fees));
      } else {
        text += ' ' + T('Комиссия {fee} распределится по закрытому объёму: спишется только доля выходов, остаток — при следующем выходе.')
          .replace('{fee}', U.money(totals.fees));
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
    setTradeEntries(legsFromField(fields.entries, store.MAX_ENTRIES));
    setTradeExits(legsFromField(fields.exits, store.MAX_EXITS));
    state.tradeChecklist = normalizeChecklistField(fields.checklist);
    renderEntriesEditor();
    renderExitsEditor();
    renderTradeChecklist();
    setSide(fields.side);
    setDiscipline(Number(fields.discipline) || 0);
    renderFeePresets();
  }

  function addExitRow(qty, price) {
    if (state.tradeExits.length >= (store.MAX_EXITS || 50)) {
      toast(T('Слишком много выходов: максимум {max}.').replace('{max}', store.MAX_EXITS || 50), 'warn', null, { skip: true });
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

  const SHOT_LABEL_OPTIONS = ['', 'HTF', 'Вход', 'Выход', 'График', 'Другое'];

  function normalizeDraftScreenshots(list, legacyShot) {
    const maxShots = store.MAX_SCREENSHOTS || 4;
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (out.length >= maxShots) return;
      const src = typeof item === 'string' ? item : (item && typeof item.src === 'string' ? item.src : '');
      const label = item && typeof item === 'object' ? String(item.label || '').trim().slice(0, 32) : '';
      if (isScreenshotValue(src) && !seen.has(src)) {
        seen.add(src);
        out.push({ src: src, label: label });
      }
    });
    if (!out.length && isScreenshotValue(legacyShot)) {
      out.push({ src: legacyShot, label: '' });
    }
    return out;
  }

  function screenshotsEqual(a, b) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    return left.every(function (item, idx) {
      return item && right[idx] && item.src === right[idx].src && (item.label || '') === (right[idx].label || '');
    });
  }

  function syncTradeDirty() {
    if (state.tradeInitializing || !state.tradeBaseline) return;
    const dirty = !sameTradeFields(readTradeFields(), state.tradeBaseline)
      || !screenshotsEqual(state.screenshots, state.tradeBaselineScreenshots);
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
    const shots = state.screenshots.map(function (item) {
      return { src: item.src, label: item.label || '' };
    });
    const payload = {
      savedAt: new Date().toISOString(),
      accountId: accountId,
      tradeId: state.tradeId || '',
      fields: readTradeFields(),
      screenshots: shots,
      screenshot: shots[0] ? shots[0].src : ''
    };

    let serialized = JSON.stringify(payload);
    state.draftScreenshotOmitted = false;
    for (let i = payload.screenshots.length - 1; i >= 0 && serialized.length > DRAFT_MAX_CHARS; i--) {
      if (/^data:/i.test(payload.screenshots[i].src)) {
        payload.screenshots.splice(i, 1);
        payload.screenshotOmitted = true;
        state.draftScreenshotOmitted = true;
        payload.screenshot = payload.screenshots[0] ? payload.screenshots[0].src : '';
        serialized = JSON.stringify(payload);
      }
    }
    if (state.draftScreenshotOmitted && !state.draftShotWarned) {
      state.draftShotWarned = true;
      toast('Скриншот слишком большой для черновика: если закрыть форму, он не сохранится. Сохраните сделку, чтобы не потерять изображение.', 'warn');
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
    state.tradeBaselineScreenshots = store.tradeScreenshots(trade);
    state.screenshots = state.tradeBaselineScreenshots.map(function (item) {
      return { src: item.src, label: item.label || '' };
    });
    state.screenshotPreviews = {};
    state.tradeDirty = false;
    state.tradeSaving = false;
    state.screenshotBusy = false;
    state.draftShotWarned = false;
    state.draftScreenshotOmitted = false;

    $('#tradeModalTitleText').textContent = T(trade ? 'Редактировать сделку' : 'Новая сделка');
    applyTradeFields(state.tradeBaseline);

    let restored = false;
    const draft = readTradeDraft(accountId, trade ? trade.id : null);
    if (draft) {
      const fields = normalizeDraftFields(draft.fields, state.tradeBaseline);
      const draftShots = (Array.isArray(draft.screenshots) || draft.screenshot)
        ? normalizeDraftScreenshots(draft.screenshots, draft.screenshot)
        : state.tradeBaselineScreenshots.map(function (item) { return Object.assign({}, item); });
      if (!sameTradeFields(fields, state.tradeBaseline) || !screenshotsEqual(draftShots, state.tradeBaselineScreenshots)) {
        applyTradeFields(fields);
        state.screenshots = draftShots;
        restored = true;
      } else {
        clearTradeDraft(trade ? trade.id : null, accountId);
      }
    }

    $('#tradeError').hidden = true;
    $('#deleteTradeBtn').classList.toggle('hidden', !trade);
    $('#saveTradeBtn').textContent = T(trade ? 'Сохранить изменения' : 'Сохранить сделку');
    $('#saveTradeBtn').disabled = false;
    $('#tradeShot').value = '';
    state.tradeInitializing = false;
    updateTradePreview();
    renderFeePresets();
    renderShotPreview();
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
    $('#disciplineLabel').textContent = T(labels[level]);
    $$('#disciplineStars .star').forEach(function (star) {
      star.classList.toggle('active', Number(star.dataset.star) <= level);
    });
  }

  let shotPreviewToken = 0;
  let shotLightboxToken = 0;

  function removeShotAt(index) {
    if (state.screenshotBusy) {
      toast('Скриншот ещё сохраняется, подождите пару секунд.', 'warn');
      return;
    }
    if (index < 0 || index >= state.screenshots.length) return;
    state.screenshots.splice(index, 1);
    renderShotPreview();
    syncTradeDirty();
  }

  function renderShotPreview() {
    const box = $('#shotPreview');
    const remove = $('#removeShot');
    const countEl = $('#shotCount');
    const maxShots = store.MAX_SCREENSHOTS || 4;
    if (countEl) countEl.textContent = state.screenshots.length + ' / ' + maxShots;
    if (!box || !remove) return;
    const token = ++shotPreviewToken;
    box.innerHTML = '';

    if (!state.screenshots.length) {
      box.classList.remove('has');
      remove.classList.add('hidden');
      return;
    }

    box.classList.add('has');
    remove.classList.remove('hidden');

    state.screenshots.forEach(function (item, index) {
      const card = document.createElement('div');
      card.className = 'shot-card';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'shot-del';
      delBtn.title = T('Удалить скриншот');
      delBtn.setAttribute('aria-label', T('Удалить скриншот'));
      delBtn.textContent = '×';
      delBtn.addEventListener('click', function () { removeShotAt(index); });
      card.appendChild(delBtn);

      const loading = document.createElement('span');
      loading.className = 'shot-loading';
      loading.textContent = T('Загрузка…');
      card.appendChild(loading);

      const select = document.createElement('select');
      select.className = 'shot-label-select';
      select.setAttribute('aria-label', T('Метка скриншота'));
      const currentLabel = item.label || '';
      const optionsList = SHOT_LABEL_OPTIONS.slice();
      if (currentLabel && optionsList.indexOf(currentLabel) === -1) optionsList.push(currentLabel);
      optionsList.forEach(function (optVal) {
        const opt = document.createElement('option');
        opt.value = optVal;
        opt.textContent = optVal ? T(optVal) : T('Без метки');
        select.appendChild(opt);
      });
      select.value = currentLabel;
      select.addEventListener('change', function () {
        if (!state.screenshots[index]) return;
        state.screenshots[index].label = select.value;
        syncTradeDirty();
      });
      card.appendChild(select);
      box.appendChild(card);

      store.screenshotSource(item.src).then(function (source) {
        if (token !== shotPreviewToken || !document.contains(card)) return;
        card.removeChild(loading);
        if (!source) {
          const missing = document.createElement('span');
          missing.className = 'shot-loading';
          missing.textContent = T('Файл скриншота не найден');
          card.insertBefore(missing, select);
          return;
        }
        state.screenshotPreviews[item.src] = source;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'shot-open';
        button.title = T('Открыть скриншот на весь экран');
        button.setAttribute('aria-label', T('Открыть скриншот в полном размере'));
        button.addEventListener('click', function () { openShotLightbox(index); });
        const image = document.createElement('img');
        image.src = source;
        image.alt = item.label || T('Скриншот сделки');
        button.appendChild(image);
        card.insertBefore(button, select);
      }).catch(function () {
        if (token !== shotPreviewToken || !document.contains(card)) return;
        loading.textContent = T('Не удалось загрузить скриншот');
      });
    });
  }

  function renderLightboxCurrent() {
    const lightbox = $('#shotLightbox');
    const image = $('#shotLightboxImage');
    if (!lightbox || !image || !state.lightboxItems.length) return;
    const item = state.lightboxItems[state.lightboxIndex] || state.lightboxItems[0];
    const total = state.lightboxItems.length;
    const prevBtn = $('#shotLightboxPrev');
    const nextBtn = $('#shotLightboxNext');
    const bar = $('#shotLightboxBar');
    const captionEl = $('#shotLightboxCaption');
    const counterEl = $('#shotLightboxCounter');
    if (prevBtn) prevBtn.hidden = total <= 1;
    if (nextBtn) nextBtn.hidden = total <= 1;
    if (bar) bar.hidden = total <= 1 && !item.label;
    if (captionEl) captionEl.textContent = item.label ? T(item.label) : '';
    if (counterEl) counterEl.textContent = total > 1 ? (state.lightboxIndex + 1) + ' / ' + total : '';

    const token = ++shotLightboxToken;
    const cached = state.screenshotPreviews[item.src];
    if (cached) {
      image.src = cached;
      image.alt = item.label ? T(item.label) : T('Скриншот сделки');
      return;
    }
    image.removeAttribute('src');
    image.alt = T('Загрузка скриншота');
    store.screenshotSource(item.src).then(function (source) {
      if (token !== shotLightboxToken || lightbox.hidden || !source) return;
      image.src = source;
      image.alt = item.label ? T(item.label) : T('Скриншот сделки');
    });
  }

  function stepLightbox(delta) {
    if (state.lightboxItems.length <= 1) return;
    const len = state.lightboxItems.length;
    state.lightboxIndex = (state.lightboxIndex + delta + len) % len;
    renderLightboxCurrent();
  }

  function openScreenshotLightbox(itemsOrValue, startIndexOrFocus, maybeFocusElement) {
    let items = [];
    let startIndex = 0;
    let focusElement = maybeFocusElement;
    if (Array.isArray(itemsOrValue)) {
      items = itemsOrValue.filter(function (item) { return item && item.src; });
      if (typeof startIndexOrFocus === 'number') startIndex = startIndexOrFocus;
      else focusElement = startIndexOrFocus;
    } else if (typeof itemsOrValue === 'string' && itemsOrValue) {
      items = [{ src: itemsOrValue, label: '' }];
      focusElement = startIndexOrFocus;
    }
    if (!items.length) return;
    const lightbox = $('#shotLightbox');
    const image = $('#shotLightboxImage');
    if (!lightbox || !image) return;
    state.shotFocus = focusElement || document.activeElement;
    state.lightboxItems = items;
    state.lightboxIndex = Math.max(0, Math.min(items.length - 1, startIndex || 0));
    lightbox.hidden = false;
    $('#shotLightboxClose').focus();
    renderLightboxCurrent();
  }

  function openShotLightbox(startIndex) {
    if (!state.screenshots.length) return;
    openScreenshotLightbox(state.screenshots, typeof startIndex === 'number' ? startIndex : 0, document.activeElement);
  }

  function openTradeScreenshot(tradeId, focusElement) {
    const trade = store.state.trades.find(function (item) { return item.id === tradeId; });
    const shots = store.tradeScreenshots(trade);
    if (!shots.length) return;
    openScreenshotLightbox(shots, 0, focusElement);
  }

  function closeShotLightbox() {
    shotLightboxToken++;
    const lightbox = $('#shotLightbox');
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    state.lightboxItems = [];
    state.lightboxIndex = 0;
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

  function setScreenshotBusy(busy) {
    state.screenshotBusy = !!busy;
    const saveButton = $('#saveTradeBtn');
    if (saveButton && !state.tradeSaving) saveButton.disabled = state.screenshotBusy;
  }

  async function applyScreenshot(dataUrl, options) {
    const busyHeld = !!(options && options.busyHeld);
    const maxShots = store.MAX_SCREENSHOTS || 4;
    if (state.screenshots.length >= maxShots) {
      if (busyHeld) setScreenshotBusy(false);
      toast(T('Максимум {max} скриншота на сделку.').replace('{max}', maxShots), 'warn', null, { skip: true });
      return;
    }
    if (!busyHeld && state.screenshotBusy) return;
    setScreenshotBusy(true);
    try {
      const ref = await store.saveScreenshot(dataUrl);
      if (state.screenshots.length < maxShots) {
        state.screenshots.push({ src: ref, label: '' });
      }
      renderShotPreview();
      syncTradeDirty();
      toast('Скриншот добавлен');
    } catch (err) {
      toast(err && err.message ? err.message : 'Не удалось сохранить скриншот.', 'error');
    } finally {
      setScreenshotBusy(false);
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
    if (!file) return Promise.resolve();
    const maxShots = store.MAX_SCREENSHOTS || 4;
    if (state.screenshots.length >= maxShots) {
      toast(T('Максимум {max} скриншота на сделку.').replace('{max}', maxShots), 'warn', null, { skip: true });
      return Promise.resolve();
    }
    if (state.screenshotBusy) {
      toast('Дождитесь окончания сохранения скриншота.', 'warn');
      return Promise.resolve();
    }
    if (!/^image\//.test(file.type)) {
      toast('Можно прикрепить только изображение.', 'error');
      return Promise.resolve();
    }
    setScreenshotBusy(true);
    return new Promise(function (resolve) {
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
          let dataUrl;
          try {
            dataUrl = encodeScreenshot(canvas);
          } catch (err) {
            setScreenshotBusy(false);
            toast('Не удалось обработать изображение.', 'error');
            resolve();
            return;
          }
          Promise.resolve(applyScreenshot(dataUrl, { busyHeld: true })).then(resolve, resolve);
        };
        image.onerror = function () {
          setScreenshotBusy(false);
          toast('Не удалось открыть изображение.', 'error');
          resolve();
        };
        image.src = String(reader.result);
      };
      reader.onerror = function () {
        setScreenshotBusy(false);
        toast('Не удалось прочитать файл.', 'error');
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }

  async function compressScreenshots(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    const maxShots = store.MAX_SCREENSHOTS || 4;
    for (const file of files) {
      if (state.screenshots.length >= maxShots) {
        toast(T('Максимум {max} скриншота на сделку.').replace('{max}', maxShots), 'warn', null, { skip: true });
        break;
      }
      await compressScreenshot(file);
    }
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
      else if (!exits.length) remainingEl.textContent = U.qty(qty) + ' ' + T('открыто');
      else if (remaining <= epsilon) remainingEl.textContent = T('Закрыта');
      else remainingEl.textContent = U.qty(remaining) + ' ' + T('остаток');
      remainingEl.className = remaining !== null && remaining > epsilon && exits.length ? 'neutral' : '';
    }
    updateExitsSummary();
    renderPositionHistory();
    renderFeePresets();
  }

  function collectLegRows(rows, tradeDate, kind) {
    const isEntry = kind === 'entry';
    const items = [];
    for (let i = 0; i < (rows || []).length; i++) {
      const row = rows[i];
      const qtyRaw = String(row.qty === undefined || row.qty === null ? '' : row.qty).trim();
      const priceRaw = String(row.price === undefined || row.price === null ? '' : row.price).trim();
      if (!qtyRaw && !priceRaw) continue;
      const qty = U.parseNum(qtyRaw);
      const price = U.parseNum(priceRaw);
      if (qty === null || qty <= 0) {
        return {
          error: T(isEntry ? 'Вход {index}: количество должно быть больше нуля.' : 'Выход {index}: количество должно быть больше нуля.').replace('{index}', i + 1)
        };
      }
      if (price === null) {
        return {
          error: T(isEntry ? 'Вход {index}: укажите цену входа.' : 'Выход {index}: укажите цену выхода.').replace('{index}', i + 1)
        };
      }
      items.push({
        id: row.id,
        qty: qty,
        price: price,
        date: row.date || tradeDate
      });
    }
    return isEntry ? { entries: items } : { exits: items };
  }

  function collectEntryRows(tradeDate) {
    return collectLegRows(state.tradeEntries, tradeDate, 'entry');
  }

  function collectExitRows(tradeDate) {
    return collectLegRows(state.tradeExits, tradeDate, 'exit');
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
    const collectedEntries = collectEntryRows(date);
    const entries = collectedEntries.entries || [];
    let entry = U.parseNum($('#tradeEntry').value);
    let qty = U.parseNum($('#tradeQty').value);
    if (entries.length) {
      const entryTotals = entryRowsTotals();
      entry = entryTotals.entry;
      qty = entryTotals.qty;
    }
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

    let error = collectedEntries.error || collected.error || '';
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
      $('#tradeError').textContent = T(error);
      return;
    }

    const accountId = state.tradeAccountId || store.state.activeAccountId;
    const draftTradeId = state.tradeId;
    const existing = state.tradeId ? store.state.trades.find(function (t) { return t.id === state.tradeId; }) : null;
    const saveButton = $('#saveTradeBtn');
    state.tradeSaving = true;
    if (saveButton) saveButton.disabled = true;

    let rollbackTrade = null;
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

      const screenshots = state.screenshots.map(function (item) {
        return { src: item.src, label: item.label || '' };
      });
      if (desktop && screenshots.length) {
        let converted = false;
        for (const item of screenshots) {
          if (item.src && !/^file:screenshots\//i.test(item.src)) {
            item.src = await store.saveScreenshot(item.src);
            converted = true;
          }
        }
        if (converted) {
          state.screenshots = screenshots.map(function (item) { return Object.assign({}, item); });
          renderShotPreview();
        }
      }
      const screenshot = screenshots[0] ? screenshots[0].src : '';

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
        entries: entries,
        exits: exits,
        setup: $('#tradeSetup').value.trim(),
        emotion: $('#tradeEmotion').value,
        discipline: Number($('#tradeDiscipline').value) || 0,
        tags: splitTags($('#tradeTags').value),
        notes: $('#tradeNotes').value.trim(),
        checklist: state.tradeChecklist.map(function (item) {
          return { text: item.text, done: !!item.done };
        }),
        screenshot: screenshot,
        screenshots: screenshots
      }, { timeZone: accountTimeZone() });
      if (!trade) throw new Error('Не удалось подготовить сделку к сохранению.');

      const prevDemo = store.state.demo;
      let existingIndex = -1;
      let previousTrade = null;
      let mutated = false;
      rollbackTrade = function () {
        if (!mutated) return;
        mutated = false;
        if (existing) {
          if (existingIndex !== -1 && previousTrade) store.state.trades[existingIndex] = previousTrade;
        } else {
          const addedIndex = store.state.trades.lastIndexOf(trade);
          if (addedIndex !== -1) store.state.trades.splice(addedIndex, 1);
        }
        store.state.demo = prevDemo;
      };

      if (existing) {
        existingIndex = store.state.trades.findIndex(function (t) { return t.id === existing.id; });
        if (existingIndex !== -1) {
          previousTrade = store.state.trades[existingIndex];
          store.state.trades[existingIndex] = trade;
          mutated = true;
        }
      } else {
        store.state.trades.push(trade);
        mutated = true;
      }

      store.state.demo = false;
      const ok = await persist();
      if (!ok) {
        rollbackTrade();
        $('#tradeError').hidden = false;
        $('#tradeError').textContent = T('Не удалось сохранить сделку. Проверьте свободное место и папку данных, затем попробуйте ещё раз.');
        saveDraftNow();
        return;
      }
      mutated = false;

      if (!existing) {
        state.tradeId = trade.id;
        $('#tradeModalTitleText').textContent = T('Редактировать сделку');
        $('#deleteTradeBtn').classList.remove('hidden');
        $('#saveTradeBtn').textContent = T('Сохранить изменения');
      }

      clearTradeDraft(draftTradeId, accountId);
      clearTradeDraft(state.tradeOriginalId, accountId);
      clearTradeDraft(trade.id, accountId);
      state.tradeDirty = false;
      state.tradeBaseline = tradeFieldsFromTrade(trade);
      state.tradeBaselineScreenshots = store.tradeScreenshots(trade);
      state.screenshots = state.tradeBaselineScreenshots.map(function (item) {
        return { src: item.src, label: item.label || '' };
      });
      state.tradeId = trade.id;
      updateDraftUi();
      closeModal('tradeModal');
      renderAll();
      toast(existing ? 'Сделка обновлена' : 'Сделка добавлена');
    } catch (err) {
      if (rollbackTrade) rollbackTrade();
      $('#tradeError').hidden = false;
      $('#tradeError').textContent = T(err && err.message ? err.message : 'Не удалось сохранить сделку.');
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
    updateTradePreview();
    renderFeePresets();
    renderShotPreview();
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
      text: T('Сделка {symbol} от {date} будет удалена. Сразу после удаления действие можно будет отменить.')
        .replace('{symbol}', trade.symbol)
        .replace('{date}', U.formatDate(trade.date, 'long')),
      textReady: true,
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
      $('#noteError').textContent = T(error);
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
      $('#saveNoteBtn').textContent = T('Сохранить изменения');
    }

    store.state.demo = false;
    const ok = await persist();
    if (!ok) {
      $('#noteError').hidden = false;
      $('#noteError').textContent = T('Запись сохранена в текущей сессии, но сохранить её не удалось. Проверьте свободное место и папку данных.');
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
      text: T('Запись от {date} будет удалена. Сразу после удаления действие можно будет отменить.')
        .replace('{date}', U.formatDate(note.date, 'long')),
      textReady: true,
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

  function focusableElements(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    const selector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(container.querySelectorAll(selector)).filter(function (el) {
      if (typeof el.closest === 'function' && (el.closest('[hidden]') || el.closest('.hidden'))) return false;
      if (typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      }
      return true;
    });
  }

  function trapFocusInContainer(event, container) {
    if (!container) return;
    const items = focusableElements(container);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || (typeof container.contains === 'function' && !container.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || (typeof container.contains === 'function' && !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function topOpenModal() {
    for (let i = state.focusStack.length - 1; i >= 0; i--) {
      const candidate = document.getElementById(state.focusStack[i].id);
      if (candidate && !candidate.hidden) return candidate;
    }
    const open = $$('.modal').filter(function (modal) { return !modal.hidden; });
    return open.length ? open[open.length - 1] : null;
  }

  function openModal(id, focusSelector) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (modal.hidden) {
      state.focusStack.push({ id: id, trigger: document.activeElement });
    }
    modal.hidden = false;
    syncModalClass();
    setTimeout(function () {
      if (modal.hidden) return;
      const target = focusSelector ? $(focusSelector, modal) : null;
      if (target) {
        target.focus();
      } else {
        const items = focusableElements((typeof modal.querySelector === 'function' && modal.querySelector('.modal-panel')) || modal);
        if (items.length) items[0].focus();
      }
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
    let entry = null;
    for (let i = state.focusStack.length - 1; i >= 0; i--) {
      if (state.focusStack[i].id === id) {
        entry = state.focusStack.splice(i, 1)[0];
        break;
      }
    }
    const trigger = entry && entry.trigger;
    const isHiddenModal = trigger && typeof trigger.closest === 'function' && trigger.closest('.modal[hidden]');
    const inDoc = trigger && (typeof document.contains !== 'function' || document.contains(trigger));
    if (trigger && trigger !== document.body && inDoc && !isHiddenModal) {
      try { trigger.focus(); } catch (err) { /* ignore */ }
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
      openModal('confirmModal', '#confirmCancel');
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
      if (state.view === 'dashboard') redrawDashboardCharts();
      else if (state.view === 'analytics') redrawAnalyticsCharts();
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
      if (state.period === 'custom' && !state.periodFrom && !state.periodTo) {
        const today = todayInAccount();
        state.periodFrom = today.slice(0, 8) + '01';
        state.periodTo = today;
      }
      renderPeriodControls();
      renderCurrentView();
    });
    $('#periodFrom').addEventListener('change', function (event) {
      state.periodFrom = event.target.value || '';
      state.period = 'custom';
      renderPeriodControls();
      renderCurrentView();
    });
    $('#periodTo').addEventListener('change', function (event) {
      state.periodTo = event.target.value || '';
      state.period = 'custom';
      renderPeriodControls();
      renderCurrentView();
    });
    $('#dateModeSegmented').addEventListener('click', function (event) {
      const btn = event.target.closest('[data-date-mode]');
      if (!btn) return;
      state.dateMode = btn.dataset.dateMode === 'exit' ? 'exit' : 'entry';
      renderPeriodControls();
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
        state.calCursor = accountMonthStart();
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
    if ($('#journalSearch')) {
      $('#journalSearch').addEventListener('input', U.debounce(function (event) {
        state.journalFilters.search = event.target.value.trim().toLowerCase();
        renderJournal();
      }, 160));
    }
    if ($('#journalMoodFilter')) {
      $('#journalMoodFilter').addEventListener('change', function (event) {
        state.journalFilters.mood = event.target.value;
        renderJournal();
      });
    }
    if ($('#journalTagFilter')) {
      $('#journalTagFilter').addEventListener('change', function (event) {
        state.journalFilters.tag = event.target.value;
        renderJournal();
      });
    }
    if ($('#clearJournalFilters')) {
      $('#clearJournalFilters').addEventListener('click', resetJournalFilters);
    }
    const tradesHead = $('#tradesTable').querySelector('thead');
    function toggleTradeSort(th) {
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else { state.sort.key = key; state.sort.dir = 'desc'; }
      state.page = 1;
      renderTrades();
    }
    tradesHead.addEventListener('click', function (event) {
      toggleTradeSort(event.target.closest('th[data-sort]'));
    });
    tradesHead.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const th = event.target.closest('th[data-sort]');
      if (!th) return;
      event.preventDefault();
      toggleTradeSort(th);
    });
    $('#tradesFooter').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-page]');
      if (!button || button.disabled) return;
      state.page = Math.max(1, Number(button.dataset.page) || 1);
      renderTrades();
    });
    $('#tradesTbody').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button, a, input, select, textarea, [data-open-shot]')) return;
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
      state.calCursor = accountMonthStart();
      state.selectedDay = todayInAccount();
      renderCalendar();
    });

    $('#calcForm').addEventListener('input', calcUpdate);
    $('#calcReset').addEventListener('click', resetCalculator);

    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#profileForm').addEventListener('submit', saveProfile);
    $('#addSessionBtn').addEventListener('click', addSessionRow);
    if ($('#addChecklistRuleBtn')) $('#addChecklistRuleBtn').addEventListener('click', function () { addChecklistRuleRow(''); });
    if ($('#loadStarterChecklistBtn')) $('#loadStarterChecklistBtn').addEventListener('click', loadStarterChecklistRules);
    if ($('#checklistSettings')) {
      $('#checklistSettings').addEventListener('click', function (event) {
        const button = event.target.closest('[data-remove-rule]');
        if (!button) return;
        const row = button.closest('.checklist-setting-row');
        if (row) row.remove();
        if (!$$('#checklistSettings .checklist-setting-row').length) renderChecklistSettings([]);
      });
    }
    if ($('#tradeChecklistBox')) {
      $('#tradeChecklistBox').addEventListener('change', function (event) {
        const input = event.target.closest('[data-check-idx]');
        if (!input) return;
        const idx = Number(input.dataset.checkIdx);
        if (!state.tradeChecklist[idx]) return;
        state.tradeChecklist[idx].done = !!input.checked;
        renderTradeChecklist();
        syncTradeDirty();
      });
    }
    $('#settingTimezone').addEventListener('change', renderClockSettings);
    $('#sessionSettings').addEventListener('input', renderClockSettings);
    $('#sessionSettings').addEventListener('click', function (event) {
      const button = event.target.closest('[data-remove-session]');
      if (!button || button.disabled) return;
      const row = button.closest('.session-setting-row');
      if (!row) return;
      if ($$('#sessionSettings .session-setting-row').length <= 1) return;
      row.remove();
      syncSessionRemoveButtons();
      renderClockSettings();
    });
    setInterval(function () {
      if (state.view === 'settings' && !document.hidden) renderClockSettings();
    }, 30000);
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
    $('#themePresets').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-preset-id]');
      if (!button || !NS.prefs) return;
      NS.prefs.usePreset(button.dataset.presetId);
      renderAppearance();
      renderCurrentView();
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
    $('#uploadAvatarBtn').addEventListener('click', function () {
      $('#profileAvatarInput').click();
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
    $('#stopToBeBtn').addEventListener('click', moveStopToBreakeven);
    $('#saveFeePresetBtn').addEventListener('click', saveFeePreset);
    $('#feePresetsBar').addEventListener('click', function (event) {
      const removeBtn = event.target.closest('[data-remove-fee-preset]');
      if (removeBtn) {
        event.stopPropagation();
        removeFeePreset(Number(removeBtn.dataset.removeFeePreset));
        return;
      }
      const chip = event.target.closest('[data-fee-value]');
      if (!chip) return;
      const val = Number(chip.dataset.feeValue);
      $('#tradeFees').value = val === 0 ? '0' : String(val);
      renderFeePresets();
      updateTradePreview();
      syncTradeDirty();
    });
    $('#feePresetsBar').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const chip = event.target.closest('[data-fee-value]');
      if (!chip || event.target.closest('[data-remove-fee-preset]')) return;
      event.preventDefault();
      const val = Number(chip.dataset.feeValue);
      $('#tradeFees').value = val === 0 ? '0' : String(val);
      renderFeePresets();
      updateTradePreview();
      syncTradeDirty();
    });
    $('#addEntryBtn').addEventListener('click', function () { addEntryRow(); });
    $('#entriesEditor').addEventListener('input', function (event) {
      const row = event.target.closest('[data-entry-index]');
      const field = event.target.dataset.entryField;
      if (!row || !field) return;
      const index = Number(row.dataset.entryIndex);
      if (!state.tradeEntries[index]) return;
      state.tradeEntries[index][field] = event.target.value;
      syncEntryAggregate();
      updateTradePreview();
      syncTradeDirty();
    });
    $('#entriesEditor').addEventListener('change', function (event) {
      const row = event.target.closest('[data-entry-index]');
      const field = event.target.dataset.entryField;
      if (!row || !field) return;
      const index = Number(row.dataset.entryIndex);
      if (!state.tradeEntries[index]) return;
      state.tradeEntries[index][field] = event.target.value;
      syncEntryAggregate();
      updateTradePreview();
      syncTradeDirty();
    });
    $('#entriesEditor').addEventListener('click', function (event) {
      const button = event.target.closest('[data-remove-entry]');
      if (!button) return;
      removeEntryRow(Number(button.dataset.removeEntry));
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
    $('#uploadShotBtn').addEventListener('click', function () {
      $('#tradeShot').click();
    });
    $('#tradeShot').addEventListener('change', function (event) {
      compressScreenshots(event.target.files);
      event.target.value = '';
    });
    $('#pasteShot').addEventListener('click', pasteScreenshotFromClipboard);
    $('#removeShot').addEventListener('click', function () {
      if (state.screenshotBusy) {
        toast('Скриншот ещё сохраняется, подождите пару секунд.', 'warn');
        return;
      }
      state.screenshots = [];
      state.screenshotPreviews = {};
      renderShotPreview();
      syncTradeDirty();
    });
    $('#shotLightboxClose').addEventListener('click', closeShotLightbox);
    $('#shotLightboxBackdrop').addEventListener('click', closeShotLightbox);
    $('#shotLightboxPrev').addEventListener('click', function () { stepLightbox(-1); });
    $('#shotLightboxNext').addEventListener('click', function () { stepLightbox(1); });

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
      if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
        compressScreenshots(event.dataTransfer.files);
      }
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
      if (action === 'clear-journal-filters') { resetJournalFilters(); return; }
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
    const topEl = topOpenModal();
    const topModal = topEl ? topEl.id : '';
    const lightbox = $('#shotLightbox');
    const lightboxOpen = !!(lightbox && !lightbox.hidden);

    if (key === 'Tab' && !withModifier && !event.altKey) {
      if (lightboxOpen) {
        trapFocusInContainer(event, $('.shot-lightbox-panel', lightbox) || lightbox);
        return;
      }
      if (topEl) {
        trapFocusInContainer(event, $('.modal-panel', topEl) || topEl);
        return;
      }
    }

    if (!lightboxOpen && topModal === 'tradeModal' && withModifier
      && (key === 'Enter' || key.toLowerCase() === 's')) {
      event.preventDefault();
      $('#tradeForm').requestSubmit();
      return;
    }

    if (lightboxOpen && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      event.preventDefault();
      stepLightbox(key === 'ArrowLeft' ? -1 : 1);
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
    if (withModifier || event.altKey) return;

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
      toast(T('Не удалось запустить приложение: {error}').replace('{error}', err && err.message ? err.message : err), 'error', null, { skip: true });
    });
  }

  NS.app = {
    state: state,
    buildInsights: buildInsights,
    disciplineSnapshot: disciplineSnapshot,
    renderDiscipline: renderDiscipline,
    getFilteredTrades: getFilteredTrades,
    collectExitRows: collectExitRows,
    collectEntryRows: collectEntryRows,
    moveStopToBreakeven: moveStopToBreakeven,
    calcUpdate: calcUpdate,
    openModal: openModal,
    closeModal: closeModal,
    handleKeydown: handleKeydown,
    exportJSON: exportJSON,
    exportCSV: exportCSV,
    exportZIP: exportZIP,
    saveTrade: saveTrade,
    renderCalendar: renderCalendar,
    renderDayPanel: renderDayPanel,
    renderJournal: renderJournal,
    getFilteredNotes: getFilteredNotes,
    resetJournalFilters: resetJournalFilters,
    renderChecklistSettings: renderChecklistSettings,
    readChecklistSettings: readChecklistSettings,
    renderTradeChecklist: renderTradeChecklist,
    changeMonth: changeMonth,
    redrawDashboardCharts: redrawDashboardCharts,
    redrawAnalyticsCharts: redrawAnalyticsCharts,
    renderAnalytics: renderAnalytics,
    fillTimezoneOptions: fillTimezoneOptions,
    buildPeriodMetrics: buildPeriodMetrics,
    renderKpis: renderKpis,
    renderQuality: renderQuality,
    tradeRowHtml: tradeRowHtml,
    openTradeScreenshot: openTradeScreenshot,
    stepLightbox: stepLightbox
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
