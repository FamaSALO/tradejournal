(function () {
  'use strict';
  const NS = (window.TJ = window.TJ || {});

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    const encoded = unescape(encodeURIComponent(String(text)));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
    return bytes;
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    return utf8(value);
  }

  function dosDateTime(value) {
    let date = value instanceof Date ? value : new Date(value || Date.now());
    if (isNaN(date.getTime())) date = new Date();
    let year = date.getFullYear();
    if (year < 1980) year = 1980;
    if (year > 2107) year = 2107;
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: dosTime, date: dosDate };
  }

  function writeU16(view, offset, value) {
    view.setUint16(offset, value & 0xFFFF, true);
  }

  function writeU32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function create(entries) {
    const files = (entries || []).map(function (entry) {
      const name = String(entry && entry.name || '').replace(/\\/g, '/');
      if (!name || name.charAt(0) === '/') throw new Error('Некорректное имя файла в архиве.');
      const data = asBytes(entry && entry.data);
      const stamp = dosDateTime(entry && entry.date);
      return {
        name: name,
        nameBytes: utf8(name),
        data: data,
        crc: crc32(data),
        time: stamp.time,
        date: stamp.date
      };
    });

    let localSize = 0;
    let centralSize = 0;
    files.forEach(function (file) {
      localSize += 30 + file.nameBytes.length + file.data.length;
      centralSize += 46 + file.nameBytes.length;
    });

    const output = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(output.buffer);
    let offset = 0;
    const offsets = [];

    files.forEach(function (file) {
      offsets.push(offset);
      writeU32(view, offset, 0x04034b50);
      writeU16(view, offset + 4, 20);
      writeU16(view, offset + 6, 0x0800);
      writeU16(view, offset + 8, 0);
      writeU16(view, offset + 10, file.time);
      writeU16(view, offset + 12, file.date);
      writeU32(view, offset + 14, file.crc);
      writeU32(view, offset + 18, file.data.length);
      writeU32(view, offset + 22, file.data.length);
      writeU16(view, offset + 26, file.nameBytes.length);
      writeU16(view, offset + 28, 0);
      output.set(file.nameBytes, offset + 30);
      output.set(file.data, offset + 30 + file.nameBytes.length);
      offset += 30 + file.nameBytes.length + file.data.length;
    });

    const centralOffset = offset;
    files.forEach(function (file, index) {
      writeU32(view, offset, 0x02014b50);
      writeU16(view, offset + 4, 20);
      writeU16(view, offset + 6, 20);
      writeU16(view, offset + 8, 0x0800);
      writeU16(view, offset + 10, 0);
      writeU16(view, offset + 12, file.time);
      writeU16(view, offset + 14, file.date);
      writeU32(view, offset + 16, file.crc);
      writeU32(view, offset + 20, file.data.length);
      writeU32(view, offset + 24, file.data.length);
      writeU16(view, offset + 28, file.nameBytes.length);
      writeU16(view, offset + 30, 0);
      writeU16(view, offset + 32, 0);
      writeU16(view, offset + 34, 0);
      writeU16(view, offset + 36, 0);
      writeU32(view, offset + 38, 0);
      writeU32(view, offset + 42, offsets[index]);
      output.set(file.nameBytes, offset + 46);
      offset += 46 + file.nameBytes.length;
    });

    writeU32(view, offset, 0x06054b50);
    writeU16(view, offset + 4, 0);
    writeU16(view, offset + 6, 0);
    writeU16(view, offset + 8, files.length);
    writeU16(view, offset + 10, files.length);
    writeU32(view, offset + 12, offset - centralOffset);
    writeU32(view, offset + 16, centralOffset);
    writeU16(view, offset + 20, 0);
    return output;
  }

  NS.zip = {
    crc32: crc32,
    utf8: utf8,
    create: create
  };
})();
