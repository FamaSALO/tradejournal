import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function loadServiceWorker() {
  const listeners = new Map();
  let installedRequests = null;
  const cache = {
    addAll: function (requests) {
      installedRequests = requests;
      return Promise.resolve();
    }
  };
  const sandbox = {
    URL: URL,
    Request: function Request(url, options) {
      return { url: String(url), cache: options && options.cache };
    },
    caches: {
      open: function () { return Promise.resolve(cache); },
      keys: function () { return Promise.resolve([]); },
      delete: function () { return Promise.resolve(true); },
      match: function () { return Promise.resolve(null); }
    },
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: function (type, handler) {
        listeners.set(type, handler);
      },
      clients: { claim: function () { return Promise.resolve(); } },
      skipWaiting: function () {}
    }
  };
  vm.runInNewContext(swSource, sandbox, { filename: 'sw.js' });

  async function install() {
    let waitUntil = null;
    listeners.get('install')({
      waitUntil: function (promise) { waitUntil = promise; }
    });
    assert.ok(waitUntil, 'install handler must call event.waitUntil');
    await waitUntil;
    return installedRequests;
  }

  return { install: install, listeners: listeners };
}

function appShellEntries(requests) {
  return requests.map(function (request) { return request.url; });
}

function normalizeRef(ref) {
  const clean = String(ref).replace(/[?#].*$/, '');
  if (!clean || clean.startsWith('data:') || /^[a-z]+:/i.test(clean)) return '';
  return './' + clean.replace(/^\.\//, '');
}

function htmlLocalRefs() {
  const refs = [];
  const pattern = /<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/gi;
  let match;
  while ((match = pattern.exec(indexHtml))) {
    const ref = normalizeRef(match[1]);
    if (ref) refs.push(ref);
  }
  return refs;
}

test('install preloads the app shell with cache reload', async function () {
  const worker = loadServiceWorker();
  const requests = await worker.install();

  assert.ok(Array.isArray(requests), 'install must pass an array to cache.addAll');
  assert.ok(requests.length > 0);
  requests.forEach(function (request) {
    assert.equal(request.cache, 'reload');
  });
});

test('app shell lists existing local assets without duplicates', async function () {
  const worker = loadServiceWorker();
  const entries = appShellEntries(await worker.install());
  const seen = new Set();

  entries.forEach(function (entry) {
    assert.ok(entry.startsWith('./'), 'app shell entries must be relative: ' + entry);
    assert.equal(seen.has(entry), false, 'duplicate app shell entry: ' + entry);
    seen.add(entry);
    const target = entry === './' ? ROOT : path.join(ROOT, entry.slice(2));
    assert.ok(existsSync(target), 'missing app shell asset: ' + entry);
    assert.ok(entry === './' || statSync(target).isFile(), 'app shell entry is not a file: ' + entry);
  });
});

test('every local script and stylesheet in index.html is cached', async function () {
  const worker = loadServiceWorker();
  const shell = new Set(appShellEntries(await worker.install()));
  const refs = htmlLocalRefs();

  assert.ok(refs.includes('./js/app.js'), 'index.html must load the main script');
  assert.ok(refs.includes('./css/styles.css'), 'index.html must load the stylesheet');
  refs.forEach(function (ref) {
    assert.ok(shell.has(ref), 'index.html references an uncached asset: ' + ref);
  });
});

test('index.html does not load local scripts outside js/', function () {
  const scripts = [];
  const pattern = /<script\b[^>]*?\bsrc="([^"]+)"/gi;
  let match;
  while ((match = pattern.exec(indexHtml))) {
    const ref = normalizeRef(match[1]);
    if (ref) scripts.push(ref);
  }

  scripts.forEach(function (ref) {
    assert.ok(ref.startsWith('./js/'), 'unexpected script location: ' + ref);
  });
});
