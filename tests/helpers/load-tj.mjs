import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function memoryStorage() {
  const data = new Map();
  return {
    getItem: function (key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem: function (key, value) { data.set(String(key), String(value)); },
    removeItem: function (key) { data.delete(String(key)); },
    clear: function () { data.clear(); },
    key: function (index) { return Array.from(data.keys())[index] || null; },
    get length() { return data.size; }
  };
}

export function loadTradeJournal(extraFiles, options) {
  options = options || {};
  const storage = memoryStorage();
  const sandbox = {
    console: console,
    Intl: Intl,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    URL: URL,
    Blob: Blob,
    Response: Response,
    DecompressionStream: options.DecompressionStream || DecompressionStream,
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    localStorage: storage,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (options.indexedDB) sandbox.indexedDB = options.indexedDB;
  if (options.desktop) sandbox.tradeJournalDesktop = options.desktop;
  vm.createContext(sandbox);

  const files = ['js/utils.js', 'js/blobstore.js', 'js/store.js', 'js/csv.js', 'js/zip.js'].concat(extraFiles || []);
  files.forEach(function (file) {
    const full = path.join(ROOT, file);
    vm.runInContext(readFileSync(full, 'utf8'), sandbox, { filename: full });
  });

  return { TJ: sandbox.TJ, storage: storage, sandbox: sandbox };
}
