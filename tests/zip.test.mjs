import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const { TJ } = loadTradeJournal();
const zip = TJ.zip;
const PNG = 'data:image/png;base64,AAAA';

function readStoredEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    entries.push({ name: name, data: data, crc: crc, flags: flags, method: method });
    offset = dataStart + size;
  }
  return { entries: entries, centralOffset: offset };
}

// Builds a ZIP archive manually so tests can control compression method,
// declared sizes, CRC and unsafe names. Central directory is included.
function buildZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  files.forEach(function (file) {
    const nameBytes = encoder.encode(file.name);
    const raw = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
    const method = file.method === undefined ? 0 : file.method;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = file.crc === undefined ? zip.crc32(raw) : file.crc;
    const uncompressedSize = file.uncompressedSize === undefined ? raw.length : file.uncompressedSize;

    const local = new Uint8Array(30 + nameBytes.length + stored.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, stored.length, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(stored, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, stored.length, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  });

  const centralOffset = offset;
  const centralLength = centrals.reduce(function (sum, entry) { return sum + entry.length; }, 0);
  const output = new Uint8Array(centralOffset + centralLength + 22);
  let cursor = 0;
  locals.forEach(function (local) {
    output.set(local, cursor);
    cursor += local.length;
  });
  centrals.forEach(function (central) {
    output.set(central, cursor);
    cursor += central.length;
  });
  const view = new DataView(output.buffer);
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, files.length, true);
  view.setUint16(cursor + 10, files.length, true);
  view.setUint32(cursor + 12, centralLength, true);
  view.setUint32(cursor + 16, centralOffset, true);
  return output;
}

function archiveBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('computes standard CRC32 values', function () {
  assert.equal(zip.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(zip.crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

test('creates a valid stored ZIP archive with UTF-8 names', function () {
  const archive = zip.create([
    { name: 'journal.json', data: '{"ok":true}', date: new Date(2026, 0, 5, 10, 30, 0) },
    { name: 'скриншоты/заметка.txt', data: 'привет', date: new Date(2026, 0, 5, 10, 30, 0) }
  ]);

  assert.deepEqual(Array.from(archive.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  const parsed = readStoredEntries(archive);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].name, 'journal.json');
  assert.equal(parsed.entries[1].name, 'скриншоты/заметка.txt');
  assert.equal(parsed.entries[0].method, 0);
  assert.equal(parsed.entries[0].flags & 0x0800, 0x0800);
  assert.equal(parsed.entries[0].crc, zip.crc32(new TextEncoder().encode('{"ok":true}')));
  assert.equal(new TextDecoder('utf-8').decode(parsed.entries[1].data), 'привет');

  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  assert.equal(view.getUint32(parsed.centralOffset, true), 0x02014b50);
  assert.equal(view.getUint32(archive.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(archive.length - 12, true), 2);
  assert.equal(view.getUint16(archive.length - 14, true), 2);
});

test('rejects unsafe archive names', function () {
  assert.throws(function () { zip.create([{ name: '/absolute.txt', data: 'x' }]); });
  assert.throws(function () { zip.create([{ name: '', data: 'x' }]); });
});

test('reads stored and deflate entries through the central directory', async function () {
  const archive = buildZip([
    { name: 'stored.txt', data: 'stored payload', method: 0 },
    { name: 'deflate.txt', data: 'deflate payload '.repeat(50), method: 8 }
  ]);
  const entries = await zip.read(archiveBuffer(archive));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'stored.txt');
  assert.equal(new TextDecoder().decode(entries[0].data), 'stored payload');
  assert.equal(entries[1].name, 'deflate.txt');
  assert.equal(new TextDecoder().decode(entries[1].data), 'deflate payload '.repeat(50));
});

test('round-trips the ZIP export into analyzeImport without losses', async function () {
  const loaded = loadTradeJournal();
  const store = loaded.TJ.store;
  store.state.trades = [store.normalizeTrade({
    id: 'trade-1',
    date: '2026-01-05',
    time: '10:30',
    symbol: 'EURUSD',
    side: 'long',
    entry: 100,
    stop: 95,
    qty: 10,
    multiplier: 1,
    fees: 1,
    screenshot: PNG
  })];

  const snapshot = await store.exportSnapshot();
  const payload = Object.assign({}, snapshot, {
    app: 'TradeJournal',
    appVersion: '2.4.0',
    exportedAt: new Date().toISOString()
  });
  const archive = zip.create([
    { name: 'journal.json', data: JSON.stringify(payload) },
    { name: 'README.txt', data: 'backup' }
  ]);

  const entries = await zip.read(archiveBuffer(archive));
  assert.deepEqual(Array.from(entries, function (entry) { return String(entry.name); }), ['journal.json', 'README.txt']);

  const data = await zip.readJournal(archiveBuffer(archive));
  assert.equal(data.accounts[0].trades[0].screenshot, PNG);
  const stats = store.analyzeImport(data);
  assert.equal(stats.trades, 1);
  assert.equal(stats.tradesAccepted, 1);
  assert.equal(stats.tradesDropped, 0);
  assert.equal(stats.screenshotsAccepted, 1);
  assert.equal(stats.screenshotsDropped, 0);
});

test('rejects a corrupted CRC', async function () {
  const archive = buildZip([{ name: 'journal.json', data: '{"accounts":[]}', crc: 0x12345678 }]);
  await assert.rejects(function () { return zip.read(archiveBuffer(archive)); }, /CRC-32/);
});

test('rejects an entry whose declared size exceeds the limit', async function () {
  const archive = buildZip([{
    name: 'journal.json',
    data: 'small',
    uncompressedSize: zip.MAX_ENTRY_SIZE + 1
  }]);
  await assert.rejects(function () { return zip.read(archiveBuffer(archive)); }, /слишком большой/);
});

test('rejects names with a parent-directory segment', async function () {
  const archive = buildZip([{ name: '../evil.txt', data: 'x' }]);
  await assert.rejects(function () { return zip.read(archiveBuffer(archive)); }, /Некорректное имя/);
});

test('rejects an archive without journal.json', async function () {
  const archive = buildZip([{ name: 'README.txt', data: 'no journal here' }]);
  await assert.rejects(function () { return zip.readJournal(archiveBuffer(archive)); }, /journal\.json/);
});

test('rejects a file without the ZIP signature', async function () {
  const bytes = new TextEncoder().encode('{"accounts":[]} padded to look long enough');
  await assert.rejects(function () { return zip.read(archiveBuffer(bytes)); }, /сигнатура/);
});

test('rejects a truncated archive', async function () {
  const archive = buildZip([{ name: 'journal.json', data: '{"accounts":[]}' }]);
  const truncated = archive.slice(0, archive.length - 10);
  await assert.rejects(function () { return zip.read(archiveBuffer(truncated)); }, /повреждён или обрезан/);
});