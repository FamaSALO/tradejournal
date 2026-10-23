'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = 'com.famasalo.tradejournal';
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const AUTO_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKUPS = 20;

let mainWindow = null;
let dataDir = '';
let journalPath = '';
let previousPath = '';
let backupDir = '';
let lastAutoBackupAt = 0;
let smokeFinished = false;

app.setName('TradeJournal');
app.setAppUserModelId(APP_ID);

// Use a dedicated, predictable data directory on Windows. It is intentionally
// outside the installation folder so updates and uninstalling keep the journal.
if (IS_SMOKE_TEST) {
  const smokeDir = path.join(os.tmpdir(), 'tradejournal-smoke-' + process.pid);
  try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  dataDir = smokeDir;
} else {
  const appDataRoot = process.env.APPDATA || app.getPath('appData');
  dataDir = path.join(appDataRoot, 'TradeJournal');
}
try { app.setPath('userData', dataDir); } catch (err) { /* the path is set again after ready */ }
try { app.setPath('sessionData', path.join(dataDir, 'session')); } catch (err) { /* optional optimization */ }

journalPath = path.join(dataDir, 'journal.json');
previousPath = path.join(dataDir, 'journal.previous.json');
backupDir = path.join(dataDir, 'backups');

const gotSingleInstanceLock = IS_SMOKE_TEST ? true : app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(initialize).catch(function (err) {
    console.error('TradeJournal: не удалось запустить приложение', err);
    dialog.showErrorBox('TradeJournal', 'Не удалось запустить приложение.\n\n' + String(err && err.message ? err.message : err));
    app.quit();
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin' || IS_SMOKE_TEST) app.quit();
});

/* ============================================================
   Storage
   ============================================================ */

function ensureDataDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, '.tj-' + process.pid + '-' + Date.now() + '.tmp');
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      // On Windows a virus scanner can briefly lock the target. A copy is a
      // safe fallback; the complete JSON still gets written.
      if (renameErr.code === 'EPERM' || renameErr.code === 'EACCES' || renameErr.code === 'EEXIST') {
        fs.copyFileSync(tmpPath, filePath);
        fs.unlinkSync(tmpPath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeErr) { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch (unlinkErr) { /* ignore */ }
    throw err;
  }
}

function isJournalData(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.trades) && Array.isArray(value.notes);
}

function readJournal() {
  try {
    if (!fs.existsSync(journalPath)) return { ok: true, exists: false, raw: null };
    return { ok: true, exists: true, raw: fs.readFileSync(journalPath, 'utf8') };
  } catch (err) {
    return { ok: false, error: 'Не удалось прочитать файл журнала: ' + errorMessage(err) };
  }
}

function timestampForFile(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupReason(name) {
  const suffixes = ['before-restore', 'auto', 'manual', 'smoke', 'removed'];
  for (let i = 0; i < suffixes.length; i += 1) {
    if (name.endsWith('-' + suffixes[i] + '.json')) return suffixes[i];
  }
  return 'backup';
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(function (name) { return /^journal-.*\.json$/.test(name); })
      .map(function (name) {
        const fullPath = path.join(backupDir, name);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch (err) { /* ignore */ }
        return stat ? { name: name, path: fullPath, mtime: stat.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.mtime - a.mtime; });

    files.slice(MAX_BACKUPS).forEach(function (file) {
      try { fs.unlinkSync(file.path); } catch (err) { /* ignore */ }
    });
  } catch (err) {
    console.warn('TradeJournal: не удалось очистить старые резервные копии', err);
  }
}

function makeBackup(reason, raw, force) {
  if (!raw) return null;
  const now = Date.now();
  if (!force && now - lastAutoBackupAt < AUTO_BACKUP_INTERVAL_MS) return null;

  ensureDataDirs();
  const safeReason = String(reason || 'auto').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'backup';
  const name = 'journal-' + timestampForFile(new Date(now)) + '-' + safeReason + '.json';
  const target = path.join(backupDir, name);
  fs.writeFileSync(target, raw, 'utf8');
  lastAutoBackupAt = now;
  pruneBackups();
  return {
    name: name,
    path: target,
    size: Buffer.byteLength(raw, 'utf8'),
    mtime: now,
    reason: safeReason
  };
}

function saveJournal(raw) {
  try {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'Некорректные данные для сохранения.' };
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_STORAGE_BYTES) {
      return { ok: false, error: 'Файл журнала слишком большой (более 100 МБ).' };
    }

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) {
      return { ok: false, error: 'Данные журнала не являются корректным JSON.' };
    }
    if (!isJournalData(parsed)) {
      return { ok: false, error: 'Неожиданная структура журнала.' };
    }

    ensureDataDirs();
    let oldRaw = null;
    try {
      if (fs.existsSync(journalPath)) oldRaw = fs.readFileSync(journalPath, 'utf8');
    } catch (err) {
      console.warn('TradeJournal: не удалось прочитать предыдущую версию журнала', err);
    }

    if (oldRaw !== null) {
      try { fs.copyFileSync(journalPath, previousPath); } catch (err) {
        console.warn('TradeJournal: не удалось сохранить предыдущую версию', err);
      }
      try { makeBackup('auto', oldRaw, false); } catch (err) {
        console.warn('TradeJournal: не удалось создать автоматическую резервную копию', err);
      }
    }

    writeAtomic(journalPath, raw);
    return { ok: true, bytes: Buffer.byteLength(raw, 'utf8') };
  } catch (err) {
    console.error('TradeJournal: не удалось сохранить журнал', err);
    return { ok: false, error: 'Не удалось записать файл журнала: ' + errorMessage(err) };
  }
}

function createManualBackup() {
  try {
    ensureDataDirs();
    if (!fs.existsSync(journalPath)) {
      return { ok: false, error: 'Файл журнала ещё не создан.' };
    }
    const raw = fs.readFileSync(journalPath, 'utf8');
    const backup = makeBackup('manual', raw, true);
    return { ok: true, backup: backup };
  } catch (err) {
    return { ok: false, error: 'Не удалось создать резервную копию: ' + errorMessage(err) };
  }
}

function listBackups() {
  try {
    ensureDataDirs();
    const backups = fs.readdirSync(backupDir)
      .filter(function (name) { return /^journal-.*\.json$/.test(name); })
      .map(function (name) {
        const fullPath = path.join(backupDir, name);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch (err) { /* ignore */ }
        return stat ? {
          name: name,
          size: stat.size,
          mtime: stat.mtimeMs,
          reason: backupReason(name)
        } : null;
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.mtime - a.mtime; })
      .slice(0, 50);
    return { ok: true, backups: backups };
  } catch (err) {
    return { ok: false, error: 'Не удалось прочитать список копий: ' + errorMessage(err) };
  }
}

function restoreBackup(name) {
  try {
    if (typeof name !== 'string' || path.basename(name) !== name || !/^journal-.*\.json$/.test(name)) {
      return { ok: false, error: 'Некорректное имя резервной копии.' };
    }
    const sourcePath = path.join(backupDir, name);
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: 'Резервная копия не найдена.' };
    }
    const raw = fs.readFileSync(sourcePath, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) {
      return { ok: false, error: 'Резервная копия повреждена.' };
    }
    if (!isJournalData(parsed)) {
      return { ok: false, error: 'В резервной копии неожиданная структура журнала.' };
    }

    ensureDataDirs();
    if (fs.existsSync(journalPath)) {
      try { fs.copyFileSync(journalPath, previousPath); } catch (err) { /* ignore */ }
      try { makeBackup('before-restore', fs.readFileSync(journalPath, 'utf8'), true); } catch (err) { /* ignore */ }
    }
    writeAtomic(journalPath, raw);
    return { ok: true, name: name, raw: raw };
  } catch (err) {
    return { ok: false, error: 'Не удалось восстановить копию: ' + errorMessage(err) };
  }
}

function clearJournal() {
  try {
    ensureDataDirs();
    if (!fs.existsSync(journalPath)) return { ok: true };
    const target = path.join(backupDir, 'journal-' + timestampForFile(new Date()) + '-removed.json');
    try {
      fs.renameSync(journalPath, target);
    } catch (renameErr) {
      fs.copyFileSync(journalPath, target);
      fs.unlinkSync(journalPath);
    }
    pruneBackups();
    return { ok: true, backup: path.basename(target) };
  } catch (err) {
    return { ok: false, error: 'Не удалось удалить файл журнала: ' + errorMessage(err) };
  }
}

function getDataInfo() {
  return {
    ok: true,
    dataDir: dataDir,
    journalPath: journalPath,
    backupDir: backupDir,
    version: app.getVersion(),
    isDesktop: true
  };
}

async function openDataFolder() {
  try {
    ensureDataDirs();
    const error = await shell.openPath(dataDir);
    return { ok: !error, error: error || '' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/* ============================================================
   IPC
   ============================================================ */

function registerIpc() {
  ipcMain.on('tj:storage-has', function (event) {
    try {
      event.returnValue = { ok: true, exists: fs.existsSync(journalPath) };
    } catch (err) {
      event.returnValue = { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.on('tj:storage-load', function (event) {
    event.returnValue = readJournal();
  });

  ipcMain.on('tj:storage-save', function (event, raw) {
    event.returnValue = saveJournal(raw);
  });

  ipcMain.on('tj:storage-clear', function (event) {
    event.returnValue = clearJournal();
  });

  ipcMain.on('tj:storage-backup', function (event) {
    event.returnValue = createManualBackup();
  });

  ipcMain.on('tj:storage-list-backups', function (event) {
    event.returnValue = listBackups();
  });

  ipcMain.on('tj:storage-restore', function (event, name) {
    event.returnValue = restoreBackup(name);
  });

  ipcMain.handle('tj:data-info', function () {
    return getDataInfo();
  });

  ipcMain.handle('tj:open-data-folder', function () {
    return openDataFolder();
  });
}

/* ============================================================
   Window
   ============================================================ */

function downloadFiltersFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.json') return [{ name: 'JSON', extensions: ['json'] }];
  if (extension === '.csv') return [{ name: 'CSV', extensions: ['csv'] }];
  return [{ name: 'Все файлы', extensions: ['*'] }];
}

function handleDownload(event, item) {
  try {
    const filename = path.basename(item.getFilename() || 'tradejournal-download');
    if (IS_SMOKE_TEST) {
      ensureDataDirs();
      item.setSavePath(path.join(dataDir, 'smoke-download-' + filename));
      return;
    }
    const options = {
      title: 'Сохранить файл',
      defaultPath: path.join(app.getPath('downloads'), filename),
      filters: downloadFiltersFor(filename)
    };
    const savePath = mainWindow
      ? dialog.showSaveDialogSync(mainWindow, options)
      : dialog.showSaveDialogSync(options);
    if (!savePath) {
      item.cancel();
      return;
    }
    item.setSavePath(savePath);
  } catch (err) {
    console.warn('TradeJournal: не удалось выбрать путь для скачивания', err);
    item.cancel();
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1060,
    minHeight: 680,
    backgroundColor: '#080d13',
    show: false,
    title: 'TradeJournal',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.webContents.session.setPermissionRequestHandler(function (webContents, permission, callback) {
    callback(false);
  });
  mainWindow.webContents.session.on('will-download', handleDownload);

  mainWindow.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', function (event, url) {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  mainWindow.once('ready-to-show', function () {
    if (!IS_SMOKE_TEST || process.argv.includes('--smoke-show')) mainWindow.show();
  });

  mainWindow.webContents.on('did-finish-load', function () {
    if (IS_SMOKE_TEST) setTimeout(runSmokeTest, 500);
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

async function runSmokeTest() {
  if (smokeFinished || !mainWindow) return;
  smokeFinished = true;
  let result = { ok: false, error: 'Smoke test did not run.' };

  try {
    result = await mainWindow.webContents.executeJavaScript(
      '(async function () {\n' +
      '  try {\n' +
      '    if (!window.TJ || !window.TJ.store || !window.tradeJournalDesktop) {\n' +
      '      return { ok: false, error: "TJ.store or desktop bridge is not available" };\n' +
      '    }\n' +
      '    const initialTrades = window.TJ.store.state.trades.length;\n' +
      '    window.TJ.store.state.settings.name = "Smoke Test";\n' +
      '    window.TJ.store.state.demo = false;\n' +
      '    const saved = window.TJ.store.save();\n' +
      '    window.TJ.utils.download("smoke-export.json", JSON.stringify({ app: "TradeJournal", trades: [], notes: [] }), "application/json");\n' +
      '    const raw = window.tradeJournalDesktop.load();\n' +
      '    const parsed = JSON.parse(raw);\n' +
      '    const manualBackup = window.tradeJournalDesktop.backup();\n' +
      '    const backups = window.tradeJournalDesktop.listBackups();\n' +
      '    const info = await window.tradeJournalDesktop.getDataInfo();\n' +
      '    const pageTitleBeforeSettings = document.querySelector("#pageTitle") ? document.querySelector("#pageTitle").textContent : "";\n' +
      '    const desktopCard = document.querySelector("#desktopDataCard");\n' +
      '    const settingsButton = document.querySelector("[data-view=\\"settings\\"]");\n' +
      '    if (settingsButton) settingsButton.click();\n' +
      '    await new Promise(function (resolve) { setTimeout(resolve, 150); });\n' +
      '    const settingsPanel = document.querySelector("[data-panel=\\"settings\\"]");\n' +
      '    const settingsVisible = !!(settingsPanel && settingsPanel.classList.contains("active"));\n' +
      '    const desktopCardVisible = !!(desktopCard && !desktopCard.hidden);\n' +
      '    const dataPathText = document.querySelector("#desktopDataPath") ? document.querySelector("#desktopDataPath").textContent : "";\n' +
      '    return {\n' +
      '      ok: saved === true && parsed.settings.name === "Smoke Test" && initialTrades > 0 && backups.length > 0 && pageTitleBeforeSettings === "Обзор" && settingsVisible && desktopCardVisible && dataPathText !== "…",\n' +
      '      initialTrades: initialTrades,\n' +
      '      saved: saved,\n' +
      '      persistedName: parsed.settings.name,\n' +
      '      backupOk: !!(manualBackup && manualBackup.ok),\n' +
      '      backupCount: backups.length,\n' +
      '      pageTitleBeforeSettings: pageTitleBeforeSettings,\n' +
      '      settingsVisible: settingsVisible,\n' +
      '      desktopCardVisible: desktopCardVisible,\n' +
      '      dataPathText: dataPathText,\n' +
      '      journalPath: info.journalPath\n' +
      '    };\n' +
      '  } catch (err) {\n' +
      '    return { ok: false, error: String(err && err.stack ? err.stack : err) };\n' +
      '  }\n' +
      '})()'
    );
  } catch (err) {
    result = { ok: false, error: errorMessage(err) };
  }

  await new Promise(function (resolve) { setTimeout(resolve, 500); });
  const downloadPath = path.join(dataDir, 'smoke-download-smoke-export.json');
  result.downloadOk = fs.existsSync(downloadPath) && fs.statSync(downloadPath).size > 0;
  result.ok = !!(result.ok && result.downloadOk);

  try {
    const image = await mainWindow.webContents.capturePage();
    const screenshotPath = path.join(dataDir, 'smoke-settings.png');
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log('SMOKE_SCREENSHOT ' + screenshotPath);
  } catch (err) {
    console.warn('TradeJournal: не удалось сохранить снимок smoke-теста', err);
  }

  try {
    const restoreCheck = await mainWindow.webContents.executeJavaScript(
      '(function () {\n' +
      '  try {\n' +
      '    const backups = window.tradeJournalDesktop.listBackups();\n' +
      '    const auto = backups.filter(function (item) { return item.reason === "auto"; }).pop();\n' +
      '    if (!auto) return { ok: false, error: "auto backup not found" };\n' +
      '    const restored = window.tradeJournalDesktop.restoreBackup(auto.name);\n' +
      '    const loaded = window.TJ.store.load();\n' +
      '    return { ok: !!(restored && restored.ok) && loaded, restoredName: window.TJ.store.state.settings.name };\n' +
      '  } catch (err) {\n' +
      '    return { ok: false, error: String(err && err.stack ? err.stack : err) };\n' +
      '  }\n' +
      '})()'
    );
    result.restoreOk = !!(restoreCheck && restoreCheck.ok);
    result.restoredName = restoreCheck && restoreCheck.restoredName;
    result.ok = !!(result.ok && result.restoreOk);
  } catch (err) {
    result.ok = false;
    result.restoreError = errorMessage(err);
  }

  console.log('SMOKE_RESULT ' + JSON.stringify(result));
  console.log('SMOKE_FILE_EXISTS ' + fs.existsSync(journalPath));
  setTimeout(function () {
    app.exit(result && result.ok ? 0 : 1);
  }, 250);
}

async function initialize() {
  dataDir = app.getPath('userData');
  journalPath = path.join(dataDir, 'journal.json');
  previousPath = path.join(dataDir, 'journal.previous.json');
  backupDir = path.join(dataDir, 'backups');
  try {
    ensureDataDirs();
  } catch (err) {
    console.error('TradeJournal: не удалось создать папку данных', err);
  }
  registerIpc();
  createWindow();
}
