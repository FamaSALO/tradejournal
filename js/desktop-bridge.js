(function () {
  'use strict';

  const tauri = window.__TAURI__ && window.__TAURI__.core;
  if (!tauri || typeof tauri.invoke !== 'function' || window.tradeJournalDesktop) return;

  const invoke = tauri.invoke;
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let platform = /Mac/i.test(userAgent) ? 'darwin' : /Win/i.test(userAgent) ? 'win32' : 'linux';
  let saveChain = Promise.resolve();

  function syncPlatform(rawPlatform) {
    if (rawPlatform === 'macos' || rawPlatform === 'darwin') platform = 'darwin';
    else if (rawPlatform === 'windows' || rawPlatform === 'win32') platform = 'win32';
    else if (rawPlatform === 'linux') platform = 'linux';
  }

  function tr(text) {
    const i18n = window.TJ && window.TJ.i18n;
    return i18n && typeof i18n.t === 'function' ? i18n.t(text) : text;
  }

  function translateDesktopMessage(message) {
    const text = String(message || tr('Ошибка Tauri'));
    const i18n = window.TJ && window.TJ.i18n;
    if (!i18n || typeof i18n.lang !== 'function' || i18n.lang() !== 'en') return text;

    const cleanupSuffix = ' Очистка отменена, чтобы не удалить нужные скриншоты.';
    let suffix = '';
    let core = text;
    if (core.endsWith(cleanupSuffix)) {
      suffix = ' ' + tr(cleanupSuffix.trim());
      core = core.slice(0, -cleanupSuffix.length).trim();
    }

    const corruptFile = /^Файл (.+) повреждён\.$/.exec(core);
    if (corruptFile) {
      return tr('Файл {name} повреждён.').replace('{name}', corruptFile[1]) + suffix;
    }

    const readNamed = /^Не удалось прочитать ([^:]+): ([\s\S]+)$/.exec(core);
    if (readNamed) {
      const target = readNamed[1];
      if (!/^(список копий|папку резервных копий|папку скриншотов|файл журнала)$/.test(target)) {
        return tr('Не удалось прочитать {name}: {error}').replace('{name}', target).replace('{error}', readNamed[2]) + suffix;
      }
    }

    const colonIndex = core.indexOf(': ');
    if (colonIndex > 0) {
      const prefix = core.slice(0, colonIndex + 1);
      const rest = core.slice(colonIndex + 2);
      const translatedPrefix = tr(prefix);
      if (translatedPrefix !== prefix) return translatedPrefix + ' ' + rest + suffix;
    }
    return tr(core) + suffix;
  }

  function call(command, args) {
    return invoke(command, args || {}).catch(function (err) {
      const raw = err && err.message ? err.message : String(err || 'Ошибка Tauri');
      throw new Error(translateDesktopMessage(raw));
    });
  }

  function enqueueSave(raw) {
    const task = saveChain.then(function () {
      return call('storage_save', { raw: raw });
    });
    saveChain = task.catch(function () { /* the next save must still run */ });
    return task;
  }

  function waitForSaves() {
    return saveChain;
  }

  window.tradeJournalDesktop = {
    isDesktop: true,
    get platform() { return platform; },
    translateMessage: translateDesktopMessage,

    hasData: function () {
      return waitForSaves().then(function () {
        return call('storage_has');
      });
    },

    load: function () {
      return waitForSaves().then(function () {
        return call('storage_load');
      });
    },

    save: function (raw) {
      return enqueueSave(raw).then(function () {
        return true;
      });
    },

    clear: function () {
      return waitForSaves().then(function () {
        return call('storage_clear');
      }).then(function () {
        return true;
      });
    },

    backup: function () {
      return waitForSaves().then(function () {
        return call('storage_backup');
      }).then(function (backup) {
        return { ok: true, backup: backup };
      });
    },

    listBackups: function () {
      return waitForSaves().then(function () {
        return call('storage_list_backups');
      });
    },

    restoreBackup: function (name) {
      return waitForSaves().then(function () {
        return call('storage_restore', { name: name });
      }).then(function (raw) {
        return { ok: true, name: name, raw: raw };
      });
    },

    restorePrevious: function () {
      return waitForSaves().then(function () {
        return call('storage_restore_previous');
      }).then(function (raw) {
        return { ok: true, raw: raw };
      });
    },

    saveScreenshot: function (id, dataUrl) {
      return call('screenshot_save', { id: id, dataUrl: dataUrl });
    },

    loadScreenshot: function (reference) {
      return call('screenshot_load', { reference: reference });
    },

    getDataInfo: function () {
      return call('data_info').then(function (info) {
        if (info && info.platform) syncPlatform(info.platform);
        return info;
      });
    },

    storageHealth: function () {
      return waitForSaves().then(function () {
        return call('storage_health');
      });
    },

    cleanupUnusedScreenshots: function (names) {
      return waitForSaves().then(function () {
        return call('storage_cleanup_unused', { names: names || [] });
      });
    },

    openDataFolder: function () {
      return call('open_data_folder');
    },

    saveDownload: function (filename, content) {
      return call('save_download', { filename: filename, content: content });
    },

    saveDownloadBytes: function (filename, base64Content) {
      return call('save_download_bytes', { filename: filename, content: base64Content });
    },

    checkUpdate: function () {
      return call('update_check');
    },

    installUpdate: function () {
      return call('update_install');
    }
  };
})();
