(function () {
  'use strict';
  const NS = window.TJ;
  const U = NS.utils;

  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULT_SEED = 30;
  let rand = mulberry32(DEFAULT_SEED);

  function weighted(list) {
    let total = 0;
    list.forEach(function (item) { total += item[1]; });
    let roll = rand() * total;
    for (let i = 0; i < list.length; i++) {
      roll -= list[i][1];
      if (roll <= 0) return list[i][0];
    }
    return list[list.length - 1][0];
  }

  function round(value, digits) {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  const SPECS = [
    { symbol: 'EURUSD', base: 1.0860, stop: 0.0035, qty: 30000, digits: 5, weight: 18 },
    { symbol: 'GBPUSD', base: 1.2705, stop: 0.0042, qty: 26000, digits: 5, weight: 12 },
    { symbol: 'XAUUSD', base: 2350.0, stop: 6.5, qty: 16, digits: 2, weight: 16 },
    { symbol: 'BTCUSD', base: 64800, stop: 720, qty: 0.16, digits: 1, weight: 12 },
    { symbol: 'NAS100', base: 18350, stop: 85, qty: 1.2, digits: 1, weight: 14 },
    { symbol: 'AAPL', base: 192.40, stop: 2.4, qty: 46, digits: 2, weight: 10 },
    { symbol: 'TSLA', base: 248.60, stop: 6.2, qty: 18, digits: 2, weight: 10 },
    { symbol: 'USDJPY', base: 151.20, stop: 0.42, qty: 300, digits: 3, weight: 8 }
  ];

  const SETUP_WEIGHTS = [
    ['Пробой уровня', 22],
    ['Откат к уровню', 20],
    ['Ретест', 15],
    ['Тренд по старшему ТФ', 15],
    ['Контртренд', 8],
    ['Новости', 6],
    ['Скальпинг', 8],
    ['Пин-бар', 3],
    ['Двойное дно / вершина', 3]
  ];

  const EMOTION_WEIGHTS = [
    ['calm', 28],
    ['confident', 22],
    ['neutral', 14],
    ['fomo', 12],
    ['fear', 8],
    ['greed', 5],
    ['revenge', 4],
    ['boredom', 4],
    ['euphoria', 3]
  ];

  const NOTES_POOL = [
    'Вошёл после ретеста, держал до тейка. Не трогал стоп — это главное.',
    'Стоп выбило за несколько минут до движения. Вход был слишком ранним.',
    'Сократил объём из-за высокой волатильности, решение оказалось верным.',
    'Не было подтверждения, но всё равно нажал. Классическая ошибка.',
    'Перед новостями закрыл половину позиции — стало спокойнее.',
    'Дисциплинированно пропустил сетап: не совпадал контекст.',
    'Вышел раньше плана из-за страха отдать прибыль.',
    'Работал по чек-листу, оба входа были понятными.'
  ];

  const NOTE_TEXT = {
    great: [
      'Работал строго по плану. Вошёл в два сетапа после подтверждения, не дёргал стоп и не увеличивал объём после удачной сделки. Такие дни нужно запомнить телом.',
      'Рынок дал ровно то, что ждал. Главное — не приписывать себе лишнего: это был хороший сетап, а не предвидение. Продолжаю работать тем же размером позиции.'
    ],
    good: [
      'Спокойный день. Сделки были понятными, риск соблюдён. Одна позиция закрылась по тейку, вторую закрыл вручную по плану. Ничего не меняю в системе.',
      'Отработал утреннюю сессию и остановился. После обеда рынок стал рваным — правильно, что не полез. Дисциплина важнее количества.'
    ],
    neutral: [
      'Качественных сетапов не было, поэтому остался вне рынка. Раньше в такой день обязательно что-нибудь открыл бы от скуки. Сейчас это тоже результат.',
      'Наблюдал за рынком без сделок. Записал уровни на завтра и проверил статистику по сетапам. Лучше сохранить капитал, чем искать сделку ради сделки.'
    ],
    bad: [
      'После первого стопа захотел отбить убыток и вошёл без подтверждения. Вторая потеря была больше первой. Стоп-правило: после двух убытков день заканчивается.',
      'Срезал прибыль слишком рано, а убыток держал до полного стопа. Асимметрия получилась не в мою пользу. Работаю над тем, чтобы не вмешиваться в позицию.'
    ],
    awful: [
      'Тильт. Две сделки вне плана, увеличенный объём, попытка отыграться. Дневной лимит превышен вдвое. Завтра без торговли: разбор ошибок и возврат к базовому риску.',
      'День вышел из-под контроля. FOMO на новостях, затем месть рынку. Останавливаюсь, перечитываю торговый план и возвращаюсь только с одной сделкой на счёт.'
    ]
  };

  const NOTE_TITLES = {
    great: ['День по плану', 'Терпение окупилось', 'Чистая работа'],
    good: ['Спокойный день', 'Без лишних движений', 'Держал рамку'],
    neutral: ['День вне рынка', 'Наблюдение', 'Пропущенный день'],
    bad: ['Переторговка', 'Срезал прибыль', 'Лишний вход'],
    awful: ['Тильт', 'Стоп на день', 'Разбор ошибок']
  };

  function makeTrade(dateISO, opts) {
    opts = opts || {};
    let spec;
    if (opts.symbol) {
      spec = SPECS.find(function (s) { return s.symbol === opts.symbol; }) || SPECS[0];
    } else {
      const total = SPECS.reduce(function (acc, s) { return acc + s.weight; }, 0);
      let roll = rand() * total;
      spec = SPECS[SPECS.length - 1];
      for (let i = 0; i < SPECS.length; i++) {
        roll -= SPECS[i].weight;
        if (roll <= 0) { spec = SPECS[i]; break; }
      }
    }

    const side = opts.side || (rand() < 0.56 ? 'long' : 'short');
    const dir = side === 'long' ? 1 : -1;
    const emotion = opts.emotion || weighted(EMOTION_WEIGHTS);
    const setup = opts.setup || weighted(SETUP_WEIGHTS);
    const entry = round(spec.base + (rand() - 0.5) * spec.stop * 7, spec.digits);
    const stop = round(entry - dir * spec.stop, spec.digits);
    const planRR = 1.5 + rand() * 1.7;
    const target = round(entry + dir * spec.stop * planRR, spec.digits);

    let R;
    if (opts.R !== undefined) {
      R = opts.R;
    } else {
      const roll = rand();
      if (roll < 0.05) R = (rand() - 0.5) * 0.08;
      else if (roll < 0.50) R = 0.4 + rand() * 2.3;
      else if (roll < 0.56) R = -0.2 - rand() * 0.4;
      else if (roll < 0.92) R = -0.75 - rand() * 0.35;
      else if (roll < 0.97) R = -1.2 - rand() * 0.7;
      else R = 1.9 + rand() * 2.0;

      if ((emotion === 'fomo' || emotion === 'revenge') && rand() < 0.6) R = -0.6 - rand() * 0.7;
      if (setup === 'Контртренд' && rand() < 0.35) R -= 0.4;
      if (setup === 'Пробой уровня') R += 0.08;
      if (emotion === 'calm' && rand() < 0.3) R += 0.18;
    }

    const exit = opts.open ? null : round(entry + dir * spec.stop * R, spec.digits);
    const beTrade = Math.abs(R) < 0.04;

    let discipline;
    if (emotion === 'calm' || emotion === 'confident') discipline = 4 + (rand() < 0.5 ? 1 : 0);
    else if (emotion === 'fomo' || emotion === 'revenge') discipline = 1 + Math.floor(rand() * 2);
    else if (emotion === 'fear' || emotion === 'boredom') discipline = 3;
    else discipline = 2 + Math.floor(rand() * 3);

    const hour = weighted([['09', 16], ['10', 18], ['11', 14], ['12', 8], ['13', 10], ['14', 14], ['15', 12], ['16', 10], ['17', 6], ['18', 4], ['19', 3], ['08', 5]]);
    const minute = String(Math.floor(rand() * 12) * 5).padStart(2, '0');
    const time = opts.time || (hour + ':' + minute);

    const tags = [];
    const session = U.sessionOf(time);
    if (session !== 'Без времени') tags.push(session.toLowerCase());
    if (discipline >= 4) tags.push('план');
    if (emotion === 'fomo' || emotion === 'revenge') tags.push('импульс');
    if (rand() < 0.28) tags.push('уровень');

    const notes = rand() < 0.2 ? NOTES_POOL[Math.floor(rand() * NOTES_POOL.length)] : '';

    return {
      id: U.uid(),
      date: dateISO,
      time: time,
      symbol: spec.symbol,
      side: side,
      entry: entry,
      exit: exit,
      stop: stop,
      target: target,
      qty: spec.qty,
      fees: beTrade ? 0 : Math.round((1.5 + rand() * 4) * 100) / 100,
      setup: setup,
      emotion: emotion,
      discipline: discipline,
      tags: tags,
      notes: notes,
      screenshot: ''
    };
  }

  function generate(seed) {
    rand = mulberry32(seed === undefined ? DEFAULT_SEED : seed);
    const trades = [];
    const today = U.todayISO();

    for (let offset = 100; offset >= 1; offset--) {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - offset);
      const day = date.getDay();
      if (day === 0 || day === 6) continue;
      if (rand() < 0.24) continue;
      const count = rand() < 0.52 ? 1 : (rand() < 0.84 ? 2 : 3);
      for (let i = 0; i < count; i++) {
        trades.push(makeTrade(U.isoOf(date)));
      }
    }

    // Пара свежих сделок, чтобы «сегодня» на дашборде было живым
    trades.push(makeTrade(today, { symbol: 'XAUUSD', side: 'long', setup: 'Откат к уровню', emotion: 'calm', R: 1.85, time: '10:25', discipline: 5 }));
    trades.push(makeTrade(today, { symbol: 'NAS100', side: 'short', setup: 'Пробой уровня', emotion: 'confident', R: -0.9, time: '14:10', discipline: 4 }));
    trades.push(makeTrade(U.addDaysISO(today, -1), { symbol: 'BTCUSD', side: 'long', setup: 'Тренд по старшему ТФ', emotion: 'calm', open: true, time: '16:40', discipline: 4 }));
    trades.push(makeTrade(U.addDaysISO(today, -4), { symbol: 'AAPL', side: 'long', setup: 'Ретест', emotion: 'fomo', open: true, time: '17:05', discipline: 2 }));

    trades.sort(function (a, b) {
      return (a.date + ' ' + a.time).localeCompare(b.date + ' ' + b.time);
    });

    const dayPnl = {};
    trades.forEach(function (trade) {
      const pnl = NS.store.tradePnl(trade);
      if (pnl === null) return;
      dayPnl[trade.date] = (dayPnl[trade.date] || 0) + pnl;
    });

    const candidateDays = Object.keys(dayPnl).sort().reverse().slice(0, 45);
    const noteDates = [];
    if (candidateDays.indexOf(today) >= 0) noteDates.push(today);
    const shuffled = candidateDays.filter(function (d) { return d !== today; });
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    for (let i = 0; i < shuffled.length && noteDates.length < 17; i++) {
      if (rand() < 0.72) noteDates.push(shuffled[i]);
    }
    noteDates.sort().reverse();

    const notes = noteDates.map(function (dateISO) {
      const pnl = dayPnl[dateISO] || 0;
      let mood;
      if (pnl > 250) mood = rand() < 0.75 ? 'great' : 'good';
      else if (pnl > 50) mood = rand() < 0.6 ? 'good' : 'neutral';
      else if (pnl > -50) mood = rand() < 0.5 ? 'neutral' : (pnl >= 0 ? 'good' : 'bad');
      else if (pnl > -250) mood = rand() < 0.6 ? 'bad' : 'neutral';
      else mood = rand() < 0.65 ? 'awful' : 'bad';

      if (dateISO === today) mood = 'good';

      const tagOptions = {
        great: ['план', 'риск', 'психология'],
        good: ['план', 'дисциплина'],
        neutral: ['наблюдение', 'терпение'],
        bad: ['ошибки', 'риск'],
        awful: ['тильт', 'психология', 'ошибки']
      }[mood];

      const titlePool = NOTE_TITLES[mood];
      const textPool = NOTE_TEXT[mood];
      const tags = tagOptions.filter(function () { return rand() < 0.45; });
      if (!tags.length) tags.push(tagOptions[0]);

      return {
        id: U.uid(),
        date: dateISO,
        mood: mood,
        title: titlePool[Math.floor(rand() * titlePool.length)],
        text: textPool[Math.floor(rand() * textPool.length)],
        tags: tags,
        createdAt: dateISO + 'T19:15:00.000Z'
      };
    });

    return {
      version: 1,
      demo: true,
      settings: {
        name: '',
        currency: '$',
        startBalance: 10000,
        riskPercent: 1,
        dailyLossLimit: 3,
        maxTradesPerDay: 3
      },
      trades: trades,
      notes: notes
    };
  }

  NS.sample = { generate: generate, DEFAULT_SEED: DEFAULT_SEED };
})();
