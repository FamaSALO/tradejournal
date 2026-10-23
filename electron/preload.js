'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function syncCall(channel, payload) {
  const result = ipcRenderer.sendSync(channel, payload);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || 'Ошибка локального хранилища TradeJournal.');
  }
  return result;
}

contextBridge.exposeInMainWorld('tradeJournalDesktop', {
  isDesktop: true,
  platform: process.platform,

  hasData: function () {
    return !!syncCall('tj:storage-has').exists;
  },

  load: function () {
    return syncCall('tj:storage-load').raw;
  },

  save: function (raw) {
    syncCall('tj:storage-save', raw);
    return true;
  },

  clear: function () {
    syncCall('tj:storage-clear');
    return true;
  },

  backup: function () {
    return syncCall('tj:storage-backup');
  },

  listBackups: function () {
    return syncCall('tj:storage-list-backups').backups || [];
  },

  restoreBackup: function (name) {
    return syncCall('tj:storage-restore', name);
  },

  getDataInfo: function () {
    return ipcRenderer.invoke('tj:data-info');
  },

  openDataFolder: function () {
    return ipcRenderer.invoke('tj:open-data-folder');
  }
});
