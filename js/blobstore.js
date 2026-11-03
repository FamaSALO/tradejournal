(function () {
  'use strict';

  const NS = (window.TJ = window.TJ || {});
  const PREFIX = 'idb:screenshots/';
  const ID_RE = /^[a-z0-9-]{1,80}$/i;
  const DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;
  const DB_NAME = 'tradejournal.screenshots';
  const STORE_NAME = 'screenshots';
  const DB_VERSION = 1;
  const desktop = !!(typeof window !== 'undefined' && window.tradeJournalDesktop);

  let defaultStore;

  function refFor(id) {
    return PREFIX + id;
  }

  function isRef(value) {
    return !!idFromRef(value);
  }

  function idFromRef(value) {
    if (typeof value !== 'string' || value.indexOf(PREFIX) !== 0) return '';
    const id = value.slice(PREFIX.length);
    return ID_RE.test(id) ? id : '';
  }

  function dataUrlSize(value) {
    return typeof value === 'string' ? value.length : 0;
  }

  function createBlobStore(adapter) {
    if (!adapter || typeof adapter.put !== 'function' || typeof adapter.get !== 'function' ||
        typeof adapter.remove !== 'function' || typeof adapter.list !== 'function') {
      throw new Error('Некорректный адаптер хранилища скриншотов.');
    }
    let persistResult = null;

    function save(dataUrl) {
      const value = String(dataUrl || '');
      if (!DATA_URL_RE.test(value)) {
        return Promise.reject(new Error('Некорректное изображение скриншота.'));
      }
      const id = NS.utils.uid();
      return Promise.resolve(adapter.put(id, value)).then(function () {
        return refFor(id);
      });
    }

    function load(ref) {
      const id = idFromRef(ref);
      if (!id) return Promise.resolve('');
      return Promise.resolve(adapter.get(id)).then(function (value) {
        return typeof value === 'string' ? value : '';
      }).catch(function (err) {
        console.warn('TradeJournal: не удалось прочитать скриншот из IndexedDB', err);
        return '';
      });
    }

    function remove(ref) {
      const id = idFromRef(ref);
      if (!id) return Promise.resolve(false);
      return Promise.resolve(adapter.remove(id)).then(function () {
        return true;
      }).catch(function (err) {
        console.warn('TradeJournal: не удалось удалить скриншот из IndexedDB', err);
        return false;
      });
    }

    function list() {
      return Promise.resolve(adapter.list()).then(function (items) {
        return (Array.isArray(items) ? items : []).map(function (item) {
          return { id: String(item.id), size: Math.max(0, Number(item.size) || 0) };
        });
      }).catch(function (err) {
        console.warn('TradeJournal: не удалось получить список скриншотов', err);
        return [];
      });
    }

    function gc(referenced) {
      const keep = new Set();
      (referenced || []).forEach(function (value) {
        const id = idFromRef(value);
        if (id) keep.add(id);
      });
      return list().then(function (items) {
        const orphans = items.filter(function (item) { return !keep.has(item.id); });
        let deleted = 0;
        let bytes = 0;
        return orphans.reduce(function (chain, item) {
          return chain.then(function () {
            return Promise.resolve(adapter.remove(item.id)).then(function () {
              deleted++;
              bytes += item.size;
            }).catch(function (err) {
              console.warn('TradeJournal: не удалось удалить неиспользуемый скриншот', err);
            });
          });
        }, Promise.resolve()).then(function () {
          return { deleted: deleted, bytes: bytes };
        });
      });
    }

    function supportsPersistence() {
      return typeof adapter.persist === 'function' && typeof adapter.persisted === 'function';
    }

    function persisted() {
      if (typeof adapter.persisted !== 'function') return Promise.resolve(null);
      try {
        return Promise.resolve(adapter.persisted()).then(function (value) {
          if (value === true) return true;
          if (value === false) return false;
          return null;
        }).catch(function () {
          return null;
        });
      } catch (err) {
        return Promise.resolve(null);
      }
    }

    function persist() {
      if (persistResult) return persistResult;
      if (typeof adapter.persist !== 'function') {
        persistResult = Promise.resolve(false);
        return persistResult;
      }
      persistResult = Promise.resolve(adapter.persist()).then(function (granted) {
        return !!granted;
      }).catch(function () {
        return false;
      });
      return persistResult;
    }

    function estimate() {
      if (typeof adapter.estimate !== 'function') return Promise.resolve(null);
      return Promise.resolve(adapter.estimate()).then(function (data) {
        if (!data || !Number.isFinite(data.usage) || !Number.isFinite(data.quota) || data.quota <= 0) {
          return null;
        }
        return { usage: data.usage, quota: data.quota };
      }).catch(function () {
        return null;
      });
    }

    return {
      save: save,
      load: load,
      remove: remove,
      list: list,
      gc: gc,
      supportsPersistence: supportsPersistence,
      persisted: persisted,
      persist: persist,
      estimate: estimate
    };
  }

  function createIdbAdapter(options) {
    options = options || {};
    const factory = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!factory || typeof factory.open !== 'function') return null;
    const dbName = options.dbName || DB_NAME;
    const storeName = options.storeName || STORE_NAME;
    const storage = options.storage || (typeof navigator !== 'undefined' ? navigator.storage : null);
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        let request;
        try {
          request = factory.open(dbName, DB_VERSION);
        } catch (err) {
          reject(err);
          return;
        }
        request.onupgradeneeded = function () {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('Не удалось открыть IndexedDB.')); };
        request.onblocked = function () { reject(new Error('IndexedDB заблокирована другой вкладкой.')); };
      });
      return dbPromise;
    }

    function run(mode, action) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          let tx;
          try {
            tx = db.transaction(storeName, mode);
          } catch (err) {
            reject(err);
            return;
          }
          const store = tx.objectStore(storeName);
          let request;
          let value;
          try {
            request = action(store);
          } catch (err) {
            reject(err);
            return;
          }
          if (request) {
            request.onsuccess = function () { value = request.result; };
            request.onerror = function () { reject(request.error || tx.error || new Error('Ошибка IndexedDB.')); };
          }
          tx.oncomplete = function () { resolve(value); };
          tx.onerror = function () { reject(tx.error || new Error('Ошибка IndexedDB.')); };
          tx.onabort = function () { reject(tx.error || new Error('Транзакция IndexedDB отменена.')); };
        });
      });
    }

    function put(id, value) {
      return run('readwrite', function (store) {
        return store.put(value, id);
      });
    }

    function get(id) {
      return run('readonly', function (store) {
        return store.get(id);
      });
    }

    function remove(id) {
      return run('readwrite', function (store) {
        return store.delete(id);
      });
    }

    function list() {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          const items = [];
          let tx;
          try {
            tx = db.transaction(storeName, 'readonly');
          } catch (err) {
            reject(err);
            return;
          }
          const request = tx.objectStore(storeName).openCursor();
          request.onsuccess = function () {
            const cursor = request.result;
            if (!cursor) return;
            items.push({ id: String(cursor.key), size: dataUrlSize(cursor.value) });
            cursor.continue();
          };
          request.onerror = function () { reject(request.error || tx.error || new Error('Ошибка IndexedDB.')); };
          tx.oncomplete = function () { resolve(items); };
          tx.onerror = function () { reject(tx.error || new Error('Ошибка IndexedDB.')); };
          tx.onabort = function () { reject(tx.error || new Error('Транзакция IndexedDB отменена.')); };
        });
      });
    }

    function persisted() {
      if (!storage || typeof storage.persisted !== 'function') return Promise.resolve(null);
      try {
        return Promise.resolve(storage.persisted()).then(function (value) {
          if (value === true) return true;
          if (value === false) return false;
          return null;
        }).catch(function () {
          return null;
        });
      } catch (err) {
        return Promise.resolve(null);
      }
    }

    function persist() {
      if (!storage || typeof storage.persist !== 'function') return Promise.resolve(false);
      return Promise.resolve(storage.persist()).then(function (granted) {
        return !!granted;
      }).catch(function () {
        return false;
      });
    }

    function estimate() {
      if (!storage || typeof storage.estimate !== 'function') return Promise.resolve(null);
      return Promise.resolve(storage.estimate()).catch(function () {
        return null;
      });
    }

    return {
      put: put,
      get: get,
      remove: remove,
      list: list,
      persisted: persisted,
      persist: persist,
      estimate: estimate
    };
  }

  function available() {
    if (desktop) return false;
    return typeof indexedDB !== 'undefined' && !!indexedDB && typeof indexedDB.open === 'function';
  }

  function getDefault() {
    if (defaultStore !== undefined) return defaultStore;
    if (!available()) {
      defaultStore = null;
      return defaultStore;
    }
    const adapter = createIdbAdapter();
    defaultStore = adapter ? createBlobStore(adapter) : null;
    return defaultStore;
  }

  function configure(adapter) {
    defaultStore = adapter ? createBlobStore(adapter) : null;
    return defaultStore;
  }

  NS.blobStore = {
    PREFIX: PREFIX,
    refFor: refFor,
    isRef: isRef,
    idFromRef: idFromRef,
    createBlobStore: createBlobStore,
    createIdbAdapter: createIdbAdapter,
    available: available,
    getDefault: getDefault,
    configure: configure
  };
})();
