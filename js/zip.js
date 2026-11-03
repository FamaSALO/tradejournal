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

  var MAX_ENTRIES = 2000;
  var MAX_TOTAL_SIZE = 200 * 1024 * 1024;
  var MAX_ENTRY_SIZE = 50 * 1024 * 1024;

  function zip64Warning() {
    return new Error('Архив использует ZIP64, который не поддерживается.');
  }

  function unsupportedMethod(method) {
    return new Error('Неподдерживаемый метод сжатия: ' + method + '. Поддерживаются stored (0) и Deflate (8).');
  }

  function invalidEntryName(name) {
    return new Error('Некорректное имя файла в архиве: ' + JSON.stringify(name) + '.');
  }

  function findEocd(view, length) {
    var min = Math.max(0, length - 22 - 0xFFFF);
    for (var i = length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function decodeName(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      throw invalidEntryName('');
    }
  }

  function isValidName(name) {
    if (!name) return false;
    if (name.charAt(0) === '/' || /^[a-z]:/i.test(name)) return false;
    if (name.indexOf('\\') >= 0) return false;
    for (var c = 0; c < name.length; c++) {
      var code = name.charCodeAt(c);
      if (code < 0x20 || code === 0x7f) return false;
    }
    var parts = name.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') return false;
    }
    return true;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Браузер не поддерживает распаковку Deflate.');
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function read(arrayBuffer) {
    if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number') {
      throw new Error('zip.read ожидает ArrayBuffer.');
    }
    var bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 22) {
      throw new Error('Файл слишком короткий для ZIP-архива.');
    }
    var view = new DataView(arrayBuffer);
    var eocd = findEocd(view, bytes.length);
    if (eocd < 0) {
      throw new Error('Не найден центральный каталог ZIP: файл повреждён или обрезан.');
    }

    var diskNumber = view.getUint16(eocd + 4, true);
    var cdDisk = view.getUint16(eocd + 6, true);
    var recordsOnDisk = view.getUint16(eocd + 8, true);
    var totalRecords = view.getUint16(eocd + 10, true);
    var cdSize = view.getUint32(eocd + 12, true);
    var cdOffset = view.getUint32(eocd + 16, true);

    if (diskNumber !== 0 || cdDisk !== 0 || recordsOnDisk !== totalRecords) {
      throw zip64Warning();
    }
    if (totalRecords === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw zip64Warning();
    }
    if (totalRecords > MAX_ENTRIES) {
      throw new Error('Слишком много файлов в архиве: ' + totalRecords + ' (максимум ' + MAX_ENTRIES + ').');
    }
    if (cdOffset < 0 || cdOffset + cdSize > bytes.length) {
      throw new Error('Центральный каталог ZIP выходит за пределы файла.');
    }
    if (totalRecords === 0) return [];

    var entries = [];
    var offset = cdOffset;
    var totalUncompressed = 0;

    for (var index = 0; index < totalRecords; index++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error('Повреждён центральный каталог ZIP.');
      }
      var flags = view.getUint16(offset + 8, true);
      var method = view.getUint16(offset + 10, true);
      var crc = view.getUint32(offset + 16, true);
      var compressedSize = view.getUint32(offset + 20, true);
      var uncompressedSize = view.getUint32(offset + 24, true);
      var nameLength = view.getUint16(offset + 28, true);
      var extraLength = view.getUint16(offset + 30, true);
      var commentLength = view.getUint16(offset + 32, true);
      var localOffset = view.getUint32(offset + 42, true);

      if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF ||
          localOffset === 0xFFFFFFFF) {
        throw zip64Warning();
      }
      if (offset + 46 + nameLength + extraLength + commentLength > bytes.length) {
        throw new Error('Повреждён центральный каталог ZIP.');
      }

      var name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (!isValidName(name)) {
        throw invalidEntryName(name);
      }
      if (flags & 0x0001) {
        throw new Error('Зашифрованные файлы в архиве не поддерживаются: ' + JSON.stringify(name) + '.');
      }
      if (method !== 0 && method !== 8) {
        throw unsupportedMethod(method);
      }
      if (compressedSize > MAX_ENTRY_SIZE || uncompressedSize > MAX_ENTRY_SIZE) {
        throw new Error('Файл ' + JSON.stringify(name) + ' слишком большой для импорта.');
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_TOTAL_SIZE) {
        throw new Error('Общий распакованный размер превышает лимит ' + (MAX_TOTAL_SIZE / 1024 / 1024) + ' МБ.');
      }

      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error('Повреждён локальный заголовок файла ' + JSON.stringify(name) + '.');
      }
      var localNameLength = view.getUint16(localOffset + 26, true);
      var localExtraLength = view.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > bytes.length) {
        throw new Error('Файл ' + JSON.stringify(name) + ' выходит за пределы архива.');
      }
      var raw = bytes.subarray(dataStart, dataStart + compressedSize);

      var data;
      if (method === 0) {
        if (compressedSize !== uncompressedSize) {
          throw new Error('Размер файла ' + JSON.stringify(name) + ' не совпадает с заявленным.');
        }
        data = raw;
      } else {
        try {
          data = await inflateRaw(raw);
        } catch (err) {
          if (err && err.message && err.message.indexOf('Браузер не поддерживает') === 0) throw err;
          throw new Error('Не удалось распаковать файл ' + JSON.stringify(name) + ': данные повреждены.', { cause: err });
        }
        if (data.length !== uncompressedSize) {
          throw new Error('Размер распакованного файла ' + JSON.stringify(name) + ' не совпадает с заявленным.');
        }
      }
      if (crc32(data) !== crc) {
        throw new Error('CRC-32 не совпадает для файла ' + JSON.stringify(name) + '.');
      }
      entries.push({ name: name, data: data });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  }

  async function readJournal(arrayBuffer) {
    var entries = await read(arrayBuffer);
    var journal = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name.toLowerCase() === 'journal.json') {
        journal = entries[i];
        break;
      }
    }
    if (!journal) {
      throw new Error('В архиве не найден journal.json.');
    }
    var text;
    try {
      text = new TextDecoder('utf-8').decode(journal.data);
    } catch (err) {
      throw new Error('Не удалось прочитать journal.json из архива.', { cause: err });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('journal.json в архиве не является корректным JSON.', { cause: err });
    }
  }

  NS.zip = {
    crc32: crc32,
    utf8: utf8,
    create: create,
    read: read,
    readJournal: readJournal,
    MAX_ENTRIES: MAX_ENTRIES,
    MAX_TOTAL_SIZE: MAX_TOTAL_SIZE,
    MAX_ENTRY_SIZE: MAX_ENTRY_SIZE
  };
})();
