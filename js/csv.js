(function () {
  'use strict';
  const NS = (window.TJ = window.TJ || {});
  const U = NS.utils;

  // Header aliases are deliberately permissive: journals are often exported
  // from brokers and spreadsheet apps with Russian or English column names.
  const HEADER_ALIASES = {
    date: ['дата', 'date', 'дата сделки', 'trade date', 'дата открытия', 'open date'],
    time: ['время', 'time', 'время входа', 'entry time', 'время открытия'],
    symbol: ['инструмент', 'symbol', 'ticker', 'тикер', 'актив', 'instrument', 'pair', 'торговая пара'],
    side: ['направление', 'side', 'direction', 'тип', 'позиция', 'long/short'],
    entry: ['вход', 'entry', 'цена входа', 'entry price', 'open price', 'цена открытия'],
    exit: ['выход', 'exit', 'цена выхода', 'exit price', 'close price', 'цена закрытия'],
    stop: ['стоп', 'stop', 'stop loss', 'стоп лосс', 'стоп при входе', 'stop price'],
    currentStop: ['текущий стоп', 'current stop', 'trailing stop', 'стоп текущий'],
    target: ['тейк', 'take profit', 'target', 'tp', 'тейк профит', 'take-profit'],
    qty: ['количество', 'qty', 'quantity', 'объем', 'объём', 'size', 'volume', 'кол-во', 'колво'],
    multiplier: ['множитель', 'multiplier', 'контракт', 'contract', 'contract size', 'множитель контракта', 'размер контракта'],
    fees: ['комиссия', 'fees', 'fee', 'commission', 'издержки'],
    setup: ['сетап', 'setup', 'стратегия', 'strategy'],
    emotion: ['эмоция', 'emotion', 'состояние', 'mood'],
    discipline: ['дисциплина', 'discipline', 'оценка'],
    tags: ['теги', 'tags', 'tag'],
    notes: ['заметка', 'заметки', 'notes', 'note', 'комментарий', 'comment'],
    exits: ['выходы', 'exits', 'частичные выходы', 'partial exits', 'exit legs', 'закрытия']
  };

  const EMOTION_ALIASES = {
    'спокоен': 'calm',
    'спокойно': 'calm',
    'уверен': 'confident',
    'уверенно': 'confident',
    'нейтрально': 'neutral',
    'нейтрален': 'neutral',
    'fomo': 'fomo',
    'страх': 'fear',
    'жадность': 'greed',
    'месть': 'revenge',
    'скука': 'boredom',
    'эйфория': 'euphoria'
  };

  function todayISO() {
    if (U && typeof U.todayISO === 'function') return U.todayISO();
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  }

  function normalizeHeader(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
      .replace(/[.:()]/g, '')
      .replace(/\s+/g, ' ');
  }

  function detectDelimiter(text) {
    const sample = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 12).join('\n');
    const counts = { ';': 0, ',': 0, '\t': 0 };
    let quoted = false;
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i];
      if (ch === '"') {
        if (quoted && sample[i + 1] === '"') { i++; continue; }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (counts[ch] !== undefined) counts[ch]++;
    }
    let best = ';';
    let bestCount = -1;
    [';', ',', '\t'].forEach(function (delimiter) {
      if (counts[delimiter] > bestCount) {
        best = delimiter;
        bestCount = counts[delimiter];
      }
    });
    return best;
  }

  function parse(text, options) {
    const source = String(text === null || text === undefined ? '' : text).replace(/^\uFEFF/, '');
    const delimiter = (options && options.delimiter) || detectDelimiter(source);
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"') {
          if (source[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        quoted = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\r') {
        // CRLF is handled by the following \n. A lone CR also ends a row.
        if (source[i + 1] !== '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        }
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }

    while (rows.length && rows[rows.length - 1].every(function (cell) { return String(cell).trim() === ''; })) {
      rows.pop();
    }

    return { delimiter: delimiter, rows: rows };
  }

  function mapHeaders(headers) {
    const normalized = (headers || []).map(normalizeHeader);
    const mapping = {};
    Object.keys(HEADER_ALIASES).forEach(function (field) {
      const aliases = HEADER_ALIASES[field];
      const index = normalized.findIndex(function (header) {
        return aliases.indexOf(header) !== -1;
      });
      if (index !== -1) mapping[field] = index;
    });
    return mapping;
  }

  function cell(row, mapping, field) {
    const index = mapping[field];
    return index === undefined ? '' : (row[index] === undefined ? '' : row[index]);
  }

  function number(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    let negative = false;
    if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
    text = text
      .replace(/[\s']/g, '')
      .replace(/[€$£¥₽₸]/g, '')
      .replace(/%$/, '');
    if (!text) return null;
    if (text.indexOf(',') !== -1 && text.indexOf('.') !== -1) {
      if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
        text = text.replace(/\./g, '').replace(',', '.');
      } else {
        text = text.replace(/,/g, '');
      }
    } else if (text.indexOf(',') !== -1) {
      text = text.replace(',', '.');
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return null;
    return negative ? -parsed : parsed;
  }

  function isoDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
    return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  function date(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return '';
    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const dotted = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
    if (dotted) {
      let day = Number(dotted[1]);
      let month = Number(dotted[2]);
      let year = Number(dotted[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      if (month > 12 && day <= 12) {
        const swap = day;
        day = month;
        month = swap;
      }
      return isoDate(year, month, day);
    }
    if (/^\d{5}(?:\.\d+)?$/.test(text)) {
      const serial = Number(text);
      if (serial > 20000 && serial < 80000) {
        const epoch = new Date(Date.UTC(1899, 11, 30));
        const dateValue = new Date(epoch.getTime() + serial * 86400000);
        return dateValue.getUTCFullYear() + '-' + String(dateValue.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dateValue.getUTCDate()).padStart(2, '0');
      }
    }
    return '';
  }

  function time(value) {
    const match = String(value === null || value === undefined ? '' : value).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return '';
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return '';
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
  }

  function side(value) {
    const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    if (!text) return 'long';
    if (/short|шорт|sell|прода|^s$/.test(text)) return 'short';
    if (/long|лонг|buy|покуп|^l$/.test(text)) return 'long';
    return '';
  }

  function emotion(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return '';
    return EMOTION_ALIASES[text.toLowerCase()] || text;
  }

  function tags(value) {
    return String(value === null || value === undefined ? '' : value)
      .split(/[,;|]/)
      .map(function (tag) { return tag.trim(); })
      .filter(Boolean)
      .slice(0, 12);
  }

  function parseExits(value, fallbackDate) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return { exits: [], errors: [] };
    const exits = [];
    const errors = [];
    text.split(/\s*[|;]\s*/).filter(Boolean).forEach(function (part, index) {
      const match = part.match(/^([^@]+)@([^@]+)(?:@(.+))?$/);
      if (!match) {
        errors.push('выход ' + (index + 1) + ': ожидается формат «количество@цена»');
        return;
      }
      const qty = number(match[1]);
      const price = number(match[2]);
      if (qty === null || qty <= 0) {
        errors.push('выход ' + (index + 1) + ': некорректное количество');
        return;
      }
      if (price === null) {
        errors.push('выход ' + (index + 1) + ': некорректная цена');
        return;
      }
      const exitDate = date(match[3]) || fallbackDate;
      exits.push({ qty: qty, price: price, date: exitDate });
    });
    return { exits: exits, errors: errors };
  }

  function roundKey(value) {
    const num = number(value);
    return num === null ? '' : String(Math.round(num * 1e8) / 1e8);
  }

  function exitsOf(trade) {
    if (trade && Array.isArray(trade.exits) && trade.exits.length) return trade.exits;
    if (trade && trade.exit !== null && trade.exit !== undefined && trade.exit !== '') {
      return [{ qty: trade.qty, price: trade.exit, date: trade.date }];
    }
    return [];
  }

  function fingerprint(trade) {
    if (!trade) return '';
    const exits = exitsOf(trade).map(function (exit) {
      return roundKey(exit.qty) + '@' + roundKey(exit.price);
    }).join('|');
    return [
      String(trade.date || ''),
      String(trade.time || ''),
      String(trade.symbol || '').trim().toUpperCase(),
      trade.side === 'short' ? 'short' : 'long',
      roundKey(trade.entry),
      roundKey(trade.qty),
      roundKey(trade.multiplier === undefined ? 1 : trade.multiplier),
      exits
    ].join('~');
  }

  function analyze(text, existingTrades) {
    const parsed = parse(text);
    const result = {
      delimiter: parsed.delimiter,
      headers: [],
      mapping: {},
      trades: [],
      errors: [],
      warnings: [],
      duplicates: 0,
      stats: { rows: 0, valid: 0, duplicates: 0, errors: 0, warnings: 0, exits: 0 }
    };
    if (!parsed.rows.length) {
      result.errors.push('Файл пуст.');
      result.stats.errors = 1;
      return result;
    }

    result.headers = parsed.rows[0].map(function (header) { return String(header).trim(); });
    result.mapping = mapHeaders(result.headers);
    const required = ['symbol', 'entry', 'qty'];
    const missing = required.filter(function (field) { return result.mapping[field] === undefined; });
    if (missing.length) {
      const labels = { symbol: 'Инструмент', entry: 'Вход', qty: 'Количество' };
      result.errors.push('Не найдены обязательные колонки: ' + missing.map(function (field) { return labels[field]; }).join(', ') + '.');
      result.stats.errors = 1;
      return result;
    }

    const existingKeys = new Set((existingTrades || []).map(fingerprint).filter(Boolean));
    const dataRows = parsed.rows.slice(1);
    result.stats.rows = dataRows.length;

    dataRows.forEach(function (row, index) {
      const line = index + 2;
      if (!row.length || row.every(function (value) { return String(value).trim() === ''; })) return;

      const symbol = String(cell(row, result.mapping, 'symbol')).trim().toUpperCase();
      if (!symbol) {
        result.errors.push('Строка ' + line + ': не указан инструмент.');
        return;
      }
      const entry = number(cell(row, result.mapping, 'entry'));
      if (entry === null) {
        result.errors.push('Строка ' + line + ': некорректная цена входа.');
        return;
      }
      const qty = number(cell(row, result.mapping, 'qty'));
      if (qty === null || qty <= 0) {
        result.errors.push('Строка ' + line + ': количество должно быть больше нуля.');
        return;
      }

      const rawDate = cell(row, result.mapping, 'date');
      let tradeDate = date(rawDate);
      if (rawDate && !tradeDate) {
        result.warnings.push('Строка ' + line + ': дата «' + rawDate + '» не распознана, использована сегодняшняя.');
      }
      if (!tradeDate) tradeDate = todayISO();

      const tradeTime = time(cell(row, result.mapping, 'time'));
      const tradeSide = side(cell(row, result.mapping, 'side'));
      if (!tradeSide) {
        result.errors.push('Строка ' + line + ': направление должно быть Long/Short (или покупка/продажа).');
        return;
      }

      const stop = number(cell(row, result.mapping, 'stop'));
      const currentStop = number(cell(row, result.mapping, 'currentStop'));
      const target = number(cell(row, result.mapping, 'target'));
      const multiplierRaw = number(cell(row, result.mapping, 'multiplier'));
      const multiplier = multiplierRaw !== null && multiplierRaw > 0 ? multiplierRaw : 1;
      if (multiplierRaw !== null && multiplierRaw <= 0) {
        result.warnings.push('Строка ' + line + ': множитель должен быть больше нуля, использован 1.');
      }
      let fees = number(cell(row, result.mapping, 'fees'));
      if (fees === null || fees < 0) {
        if (fees !== null) result.warnings.push('Строка ' + line + ': комиссия не может быть отрицательной, использован 0.');
        fees = 0;
      }

      const parsedExits = parseExits(cell(row, result.mapping, 'exits'), tradeDate);
      if (parsedExits.errors.length) {
        result.errors.push('Строка ' + line + ': ' + parsedExits.errors.join('; ') + '.');
        return;
      }
      let exits = parsedExits.exits;
      if (!exits.length) {
        const exitPrice = number(cell(row, result.mapping, 'exit'));
        if (exitPrice !== null) exits = [{ qty: qty, price: exitPrice, date: tradeDate }];
      }
      const exitQty = exits.reduce(function (sum, exit) { return sum + exit.qty; }, 0);
      if (exitQty > qty + 1e-9) {
        result.errors.push('Строка ' + line + ': сумма частичных выходов больше количества (' + exitQty + ' > ' + qty + ').');
        return;
      }

      const trade = {
        date: tradeDate,
        time: tradeTime,
        symbol: symbol,
        side: tradeSide,
        entry: entry,
        stop: stop,
        currentStop: currentStop,
        target: target,
        qty: qty,
        multiplier: multiplier,
        fees: fees,
        exits: exits,
        setup: String(cell(row, result.mapping, 'setup')).trim(),
        emotion: emotion(cell(row, result.mapping, 'emotion')),
        discipline: number(cell(row, result.mapping, 'discipline')),
        tags: tags(cell(row, result.mapping, 'tags')),
        notes: String(cell(row, result.mapping, 'notes')).trim()
      };

      const key = fingerprint(trade);
      if (existingKeys.has(key)) {
        result.duplicates++;
        return;
      }
      existingKeys.add(key);
      result.trades.push(trade);
      result.stats.exits += exits.length;
    });

    result.stats.valid = result.trades.length;
    result.stats.duplicates = result.duplicates;
    result.stats.errors = result.errors.length;
    result.stats.warnings = result.warnings.length;
    return result;
  }

  NS.csv = {
    HEADER_ALIASES: HEADER_ALIASES,
    detectDelimiter: detectDelimiter,
    parse: parse,
    mapHeaders: mapHeaders,
    number: number,
    date: date,
    time: time,
    side: side,
    parseExits: parseExits,
    fingerprint: fingerprint,
    analyze: analyze
  };
})();
