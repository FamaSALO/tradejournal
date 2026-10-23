(function () {
  'use strict';

  const tauri = window.__TAURI__ && window.__TAURI__.core;
  if (!tauri || typeof tauri.invoke !== 'function' || window.tradeJournalDesktop) return;

  const invoke = tauri.invoke;
  let saveChain = Promise.resolve();

  function call(command, args) {
    return invoke(command, args || {}).catch(function (err) {
      const message = err && err.message ? err.message : String(err || 'Ошибка Tauri');
      throw new Error(message);
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
    platform: 'win32',

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

    getDataInfo: function () {
      return call('data_info');
    },

    openDataFolder: function () {
      return call('open_data_folder');
    },

    saveDownload: function (filename, content) {
      return call('save_download', { filename: filename, content: content });
    }
  };
})();
