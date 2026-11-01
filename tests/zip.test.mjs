import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTradeJournal } from './helpers/load-tj.mjs';

const { TJ } = loadTradeJournal();
const zip = TJ.zip;

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
