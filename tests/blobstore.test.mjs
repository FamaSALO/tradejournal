import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const PNG = 'data:image/png;base64,AAAA';

function memoryAdapter() {
  const data = new Map();
  const calls = { put: 0, remove: 0, persist: 0, estimate: 0 };
  return {
    data: data,
    calls: calls,
    put: function (id, value) {
      calls.put++;
      data.set(id, value);
      return Promise.resolve();
    },
    get: function (id) {
      return Promise.resolve(data.get(id) || '');
    },
    remove: function (id) {
      calls.remove++;
      data.delete(id);
      return Promise.resolve();
    },
    list: function () {
      return Promise.resolve(Array.from(data.entries()).map(function (entry) {
        return { id: entry[0], size: entry[1].length };
      }));
    },
    persist: function () {
      calls.persist++;
      return Promise.resolve(true);
    },
    estimate: function () {
      calls.estimate++;
      return Promise.resolve({ usage: 2048, quota: 4096 });
    }
  };
}

function createStore(adapter) {
  const loaded = loadTradeJournal();
  loaded.TJ.blobStore.configure(adapter);
  return loaded;
}

function trade() {
  return {
    id: 'trade-1',
    date: '2026-01-05',
    timeUtc: '2026-01-05T07:30:00.000Z',
    symbol: 'EURUSD',
    side: 'long',
    entry: 100,
    stop: 95,
    qty: 10,
    screenshot: PNG
  };
}

test('blob store saves, loads and removes screenshots through an adapter', async function () {
  const adapter = memoryAdapter();
  const loaded = loadTradeJournal();
  const store = loaded.TJ.blobStore.createBlobStore(adapter);

  const ref = await store.save(PNG);
  assert.ok(ref.startsWith('idb:screenshots/'));
  assert.equal(loaded.TJ.blobStore.idFromRef(ref).length > 0, true);
  assert.equal(await store.load(ref), PNG);

  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].size, PNG.length);

  assert.equal(await store.remove(ref), true);
  assert.equal(await store.load(ref), '');
  assert.equal(adapter.data.size, 0);
});

test('blob store rejects invalid images and malformed references', async function () {
  const loaded = loadTradeJournal();
  const store = loaded.TJ.blobStore.createBlobStore(memoryAdapter());

  await assert.rejects(function () {
    return store.save('data:image/gif;base64,AAAA');
  }, /Некорректное изображение/);
  await assert.rejects(function () {
    return store.save('not an image');
  }, /Некорректное изображение/);

  assert.equal(loaded.TJ.blobStore.idFromRef('idb:screenshots/../../../etc/passwd'), '');
  assert.equal(loaded.TJ.blobStore.idFromRef('idb:screenshots/'), '');
  assert.equal(loaded.TJ.blobStore.idFromRef('file:screenshots/a.png'), '');
  assert.equal(loaded.TJ.blobStore.isRef('idb:screenshots/valid-id_1'), false);
});

test('IndexedDB screenshots are disabled in the desktop app', function () {
  const fakeIndexedDB = { open: function () { throw new Error('IndexedDB must not be opened on desktop'); } };
  const web = loadTradeJournal(null, { indexedDB: fakeIndexedDB });
  assert.equal(web.TJ.blobStore.available(), true);

  const desktop = loadTradeJournal(null, { indexedDB: fakeIndexedDB, desktop: { name: 'desktop' } });
  assert.equal(desktop.TJ.blobStore.available(), false);
  assert.equal(desktop.TJ.blobStore.getDefault(), null);

  const base = { id: 'trade-1', date: '2026-01-05', symbol: 'EURUSD', side: 'long', entry: 100, qty: 1 };
  const idbTrade = desktop.TJ.store.normalizeTrade(Object.assign({}, base, { screenshot: 'idb:screenshots/abc' }));
  const fileTrade = desktop.TJ.store.normalizeTrade(Object.assign({}, base, {
    screenshot: 'file:screenshots/a.png'
  }));
  assert.equal(idbTrade.screenshot, '');
  assert.equal(fileTrade.screenshot, 'file:screenshots/a.png');
});

test('garbage collection removes only unreferenced screenshots', async function () {
  const adapter = memoryAdapter();
  const loaded = loadTradeJournal();
  const store = loaded.TJ.blobStore.createBlobStore(adapter);

  const kept = await store.save(PNG);
  const orphan = await store.save(PNG);
  const result = await store.gc([kept, 'data:image/png;base64,BBBB']);

  assert.equal(result.deleted, 1);
  assert.equal(result.bytes, PNG.length);
  assert.equal(adapter.data.has(loaded.TJ.blobStore.idFromRef(kept)), true);
  assert.equal(adapter.data.has(loaded.TJ.blobStore.idFromRef(orphan)), false);
});

test('persistent storage and estimate are exposed as promises', async function () {
  const adapter = memoryAdapter();
  const store = loadTradeJournal().TJ.blobStore.createBlobStore(adapter);

  assert.equal(await store.persist(), true);
  assert.equal(await store.persist(), true);
  assert.equal(adapter.calls.persist, 1);
  assert.equal(adapter.calls.estimate, 0);

  const estimate = await store.estimate();
  assert.equal(estimate.usage, 2048);
  assert.equal(estimate.quota, 4096);
  assert.equal(adapter.calls.estimate, 1);
});

test('web migration moves embedded screenshots to IndexedDB', async function () {
  const adapter = memoryAdapter();
  const loaded = createStore(adapter);
  const store = loaded.TJ.store;
  const normalized = store.normalizeTrade(trade());
  store.state.trades = [normalized];

  const changed = await store.migrateScreenshots();
  assert.equal(changed, 1);
  assert.ok(normalized.screenshot.startsWith('idb:screenshots/'));
  assert.equal(adapter.data.size, 1);
  assert.equal(adapter.data.get(loaded.TJ.blobStore.idFromRef(normalized.screenshot)), PNG);

  const raw = await store.getRaw();
  assert.equal(raw.includes(PNG), false);
});

test('failed IndexedDB migration keeps the embedded screenshot', async function () {
  const adapter = memoryAdapter();
  adapter.put = function () { return Promise.reject(new Error('quota')); };
  const loaded = createStore(adapter);
  const store = loaded.TJ.store;
  const normalized = store.normalizeTrade(trade());
  store.state.trades = [normalized];

  const changed = await store.migrateScreenshots();
  assert.equal(changed, 0);
  assert.equal(normalized.screenshot, PNG);
});

test('web export embeds screenshots from IndexedDB', async function () {
  const adapter = memoryAdapter();
  const loaded = createStore(adapter);
  const store = loaded.TJ.store;
  store.state.trades = [store.normalizeTrade(trade())];
  await store.migrateScreenshots();

  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.accounts[0].trades[0].screenshot, PNG);
  assert.ok(store.state.trades[0].screenshot.startsWith('idb:screenshots/'));
});

test('imported data URLs are migrated before the journal is saved', async function () {
  const adapter = memoryAdapter();
  const loaded = createStore(adapter);
  const store = loaded.TJ.store;

  const ok = await store.replaceData({
    version: 4,
    activeAccountId: 'acc',
    accounts: [{
      id: 'acc',
      name: 'Test',
      trades: [trade()],
      notes: []
    }]
  }, { strictDate: true });

  assert.equal(ok, true);
  assert.equal(store.state.trades.length, 1);
  assert.ok(store.state.trades[0].screenshot.startsWith('idb:screenshots/'));
  assert.equal(adapter.data.size, 1);
  const raw = await store.getRaw();
  assert.equal(raw.includes(PNG), false);
});

test('successful save collects orphaned screenshots but keeps refs from undo history', async function () {
  const adapter = memoryAdapter();
  const loaded = createStore(adapter);
  const store = loaded.TJ.store;
  store.state.trades = [store.normalizeTrade(trade())];
  await store.migrateScreenshots();
  const used = loaded.TJ.blobStore.idFromRef(store.state.trades[0].screenshot);
  assert.ok(used);

  const orphan = 'orphan-1';
  await adapter.put(orphan, PNG);
  await store.save();
  assert.equal(adapter.data.has(orphan), false);
  assert.equal(adapter.data.has(used), true);

  // Removing a trade is undoable in the UI, so its ref stays protected until
  // the next application launch.
  store.state.trades = [];
  await store.save();
  assert.equal(adapter.data.has(used), true);
});

test('a fresh session collects screenshots left by earlier undo history', async function () {
  const adapter = memoryAdapter();
  const first = createStore(adapter);
  first.TJ.store.state.trades = [first.TJ.store.normalizeTrade(trade())];
  await first.TJ.store.migrateScreenshots();
  const oldId = first.TJ.blobStore.idFromRef(first.TJ.store.state.trades[0].screenshot);
  first.TJ.store.state.trades = [];
  await first.TJ.store.save();
  assert.equal(adapter.data.has(oldId), true);

  const second = createStore(adapter);
  const result = await second.TJ.store.gcScreenshots();
  assert.equal(result.deleted, 1);
  assert.equal(adapter.data.has(oldId), false);
});
