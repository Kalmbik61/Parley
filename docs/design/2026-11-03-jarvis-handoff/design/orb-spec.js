// «Джарвис» · спецификация сферы. Единый источник параметров:
// из него рисуется сфера (JarvisOrb.dc.html), таблица в прототипе и шкалы переходов на листе R21.
(function () {
  var PAL = {
    amber: { c1: '#EFB05C', c2: '#F48A64', c3: '#F0DDA5', c1w: '#F3C180', edge: '#975C00' },
    warm:  { c1: '#EFB05C', c2: '#F7A062', c3: '#F0DDA5', c1w: '#F3C180', edge: '#975C00' },
    coral: { c1: '#DC604C', c2: '#C43F40', c3: '#F8B287', c1w: '#E48373', edge: '#7A2E24' },
    gray:  { c1: '#9C948A', c2: '#6F665F', c3: '#C3BCB1', c1w: '#B2ABA4', edge: '#4A4540' }
  };

  var STATES = [
    { id: 'idle', n: '01', name: 'Покой', caption: 'на связи' },
    { id: 'listening', n: '02', name: 'Слушает', caption: 'слушаю' },
    { id: 'thinking', n: '03', name: 'Думает', caption: 'думаю' },
    { id: 'working', n: '04', name: 'Работает', caption: 'проверяю расписание' },
    { id: 'forming', n: '05', name: 'Формирует ответ', caption: 'отвечаю', alt: 'собираю карточку' },
    { id: 'speaking', n: '06', name: 'Говорит', caption: 'говорю' },
    { id: 'awaiting', n: '07', name: 'Ждёт решения', caption: 'нужно подтверждение' },
    { id: 'recording', n: '08', name: 'Записывает', caption: 'запись · 12:34' },
    { id: 'error', n: '09', name: 'Ошибка', caption: 'не удалось ответить' },
    { id: 'offline', n: '10', name: 'Нет связи', caption: 'нет связи' }
  ];
  var byId = {};
  STATES.forEach(function (s) { byId[s.id] = s; });
  var BUSY = { thinking: 1, working: 1, forming: 1 };

  function base() {
    return {
      pal: 'amber', xf: 300, ramp: 600,
      fB: 0, aB: 0, s0: 1,            // дыхание ядра: частота (Гц), амплитуда scale, базовый scale
      hLo: 0.35, hHi: 0.35, hS: 0, hs0: 0, // ореол: opacity lo→hi, scale-амплитуда, статичная добавка scale
      fD: 0, aD: 0,                   // дрейф пятен: базовая частота, множитель амплитуды
      fR: 0, rot0: 0,                 // вращение внутреннего слоя (об/с), статичный угол
      aP: 0, aL: 0,                   // голос: амплитуда пульса и добавка ореола × громкость
      dim: 0, op: 1,
      ring: null, arc: null, sector: null, dots: null, gap: false, badge: null,
      level: null, frozen: false, none: false
    };
  }
  function set(c, o) { for (var k in o) c[k] = o[k]; return c; }
  function breath(T, A, lo, hi, hS, dT, aD) {
    return { fB: 1 / T, aB: A, hLo: lo, hHi: hi, hS: hS, fD: 1 / (dT || T), aD: aD == null ? 1 : aD };
  }

  // o: { mini, reduced, card, voice, paused, arcT }
  function resolve(id, o) {
    o = o || {};
    var mini = !!o.mini, rm = !!o.reduced, c = base(), arcT = +o.arcT || 2;
    switch (id) {
      case 'idle':
        if (!mini) set(c, breath(7, 0.045, 0.5, 0.78, 0.07));
        break;
      case 'listening':
        if (!mini) set(c, breath(4, 0.045, 0.5, 0.78, 0.07));
        c.ring = (o.voice && !mini) ? { mode: 'level' } : { mode: 'cycle', T: 2.4 };
        if (o.voice && !mini) c.level = 'mic';
        break;
      case 'thinking':
        c.pal = 'warm';
        if (!mini) set(c, breath(3, 0.045, 0.5, 0.78, 0.07));
        c.fR = 1 / 7;
        break;
      case 'working':
        if (!mini) set(c, breath(7, 0.008, 0.6, 0.66, 0.015, 14, 0.6));
        c.arc = { T: arcT };
        break;
      case 'forming':
        if (!mini) set(c, breath(4, 0.02, 0.55, 0.72, 0.04, 5, 0.8));
        c.sector = { T: 2.4 };
        if (o.card && !mini) c.dots = { T: 1.2, lag: 0.4 };
        break;
      case 'speaking':
        if (!mini) { set(c, breath(2.4, 0.01, 0.5, 0.6, 0.02)); c.aP = 0.05; c.aL = 0.28; }
        else { c.aP = 0.02; c.badge = 'speaker'; }
        c.level = 'tts';
        break;
      case 'awaiting':
        set(c, { ramp: 300, gap: true, hLo: mini ? 0.5 : 0.95, hHi: mini ? 0.5 : 0.95, hs0: mini ? 0 : 0.06, aD: mini ? 0 : 1 });
        break;
      case 'recording':
        if (mini) { c.none = true; break; }
        set(c, breath(7, 0.015, 0.5, 0.6, 0.02, 7, 0.6));
        c.ring = { mode: 'level' }; c.level = 'mic';
        if (o.paused) set(c, { fB: 0, fD: 0, dim: 0.2, ramp: 300, frozen: true });
        break;
      case 'error':
        set(c, { pal: 'coral', xf: 180, ramp: 180, badge: 'alert', hLo: mini ? 0.35 : 0.55, hHi: mini ? 0.35 : 0.55, aD: mini ? 0 : 1 });
        break;
      case 'offline':
        if (!mini) set(c, breath(13, 0.015, 0.06, 0.1, 0.02, 13, 0.5)); else set(c, { hLo: 0.05, hHi: 0.05 });
        c.pal = 'gray'; c.op = 0.72;
        break;
    }
    if (rm) {
      var m = (c.hLo + c.hHi) / 2;
      set(c, { fB: 0, aB: 0, fD: 0, aD: 0, fR: 0, aP: 0, aL: 0, hLo: m, hHi: m, hs0: c.hs0 + c.hS / 2, hS: 0,
        xf: Math.min(c.xf, 100), ramp: 0, level: null, frozen: false });
      if (c.ring) c.ring = { mode: 'static' };
      if (c.arc) c.arc = { still: -30 };
      if (c.sector) c.sector = { still: 135 };
      if (c.dots) c.dots = { still: true };
      if (id === 'thinking') c.rot0 = 150;
      if (id === 'speaking') { c.badge = 'speaker'; if (!mini) c.s0 = 1.02; }
    }
    return c;
  }

  var f2 = function (x) { return String(Math.round(x * 1000) / 1000).replace('.', ','); };
  var sec = function (x) { return f2(Math.round(x * 100) / 100) + ' с'; };
  var ms = function (x) { return x ? x + ' мс' : 'мгновенно'; };

  // Таблица: свойство × from/to × длительность × easing × повтор
  function rows(id, o) {
    o = o || {};
    var c = resolve(id, o), P = PAL[c.pal], R = [], rm = !!o.reduced;
    function add(layer, prop, from, to, dur, ease, rep) { R.push({ layer: layer, prop: prop, from: from, to: to, dur: dur, ease: ease, rep: rep }); }
    if (c.none) { add('Мини-сфера', '—', '—', '—', '—', '—', 'не используется: REC-индикатор и таймер живут отдельно'); return R; }
    add('Палитра', 'opacity нового градиентного слоя', 'текущая', 'c1 ' + P.c1 + ' · c2 ' + P.c2 + ' · c3 ' + P.c3, ms(c.xf), c.xf <= 100 ? 'linear' : 'ease-in-out', 'однократно при смене');
    if (id === 'awaiting' || id === 'error') add('Все циклы', 'частота f, амплитуда A', 'текущие', '0', ms(c.ramp || (rm ? 0 : 300)), 'ease-in-out', 'однократно · движение останавливается');
    if (c.aB && c.fB) add('Ядро', 'scale', '1', f2(1 + c.aB), sec(1 / c.fB), 'sine in-out', '∞ · туда-обратно');
    else if (c.aB) add('Ядро', 'scale', 'текущее', 'замирает', ms(c.ramp), 'ease-in-out', 'однократно · пауза');
    else add('Ядро', 'scale', f2(c.s0), f2(c.s0), '—', '—', 'статично');
    if (c.aP) add('Ядро · голос', 'scale, добавка', '+0', '+' + f2(c.aP * 100) + ' % × громкость', '0,62 с', 'sine in-out', '∞ · пока играет звук, в паузах → 0');
    if (c.hHi !== c.hLo && c.fB) add('Ореол (140 % d)', 'opacity', f2(c.hLo), f2(c.hHi), sec(1 / c.fB), 'sine in-out', '∞ · в фазе с ядром');
    else add('Ореол (140 % d)', 'opacity', f2(c.hLo), f2(c.hLo), '—', '—', 'статично');
    if (c.hS && c.fB) add('Ореол', 'scale', '1', f2(1 + c.hS), sec(1 / c.fB), 'sine in-out', '∞ · в фазе с ядром');
    else if (c.hs0) add('Ореол', 'scale', f2(1 + c.hs0), f2(1 + c.hs0), '—', '—', 'статично');
    if (c.aL) add('Ореол · голос', 'opacity, добавка', '+0', '+' + f2(c.aL) + ' × громкость', 'по сигналу', 'атака 50 мс · спад 180 мс', '∞ · пока играет звук');
    if (c.aD && c.fD) add('Пятна 58 / 52 / 46 %', 'translate x, y, % размера пятна', '0, 0', '12, 9 · −11, 11 · 9, −11' + (c.aD < 1 ? ' × ' + f2(c.aD) : ''),
      [1.7, 2.1, 1.4].map(function (k) { return f2(Math.round(k / c.fD * 10) / 10); }).join(' / ') + ' с', 'sine in-out', '∞ · туда-обратно');
    else if (c.aD) add('Пятна 58 / 52 / 46 %', 'translate', 'текущее', 'замирают', ms(c.ramp), 'ease-in-out', 'однократно');
    else add('Пятна 58 / 52 / 46 %', 'translate', '0, 0', '0, 0', '—', '—', 'статично');
    if (c.fR) add('Внутренний слой', 'rotate', '0°', '360°', sec(1 / c.fR), 'linear', '∞');
    else if (c.rot0) add('Внутренний слой', 'rotate', c.rot0 + '°', c.rot0 + '°', '—', '—', 'статично');
    if (c.ring) {
      var rw = o.mini ? '1,5 px' : 'max(1,5 px; 0,9 % d)';
      if (c.ring.mode === 'cycle') {
        add('Кольцо, 108 % d, ' + rw, 'scale', '0,9', '1,22', '2,4 с', 'ease-out', '∞');
        add('Кольцо', 'opacity', '0,65', '0', '2,4 с', 'ease-out', '∞');
      } else if (c.ring.mode === 'level') {
        add('Кольцо, 108 % d, ' + rw, 'scale', '0,96', '0,96 + 0,26 × громкость', 'по сигналу', 'атака 50 мс · спад 180 мс', c.frozen ? 'замирает на паузе' : '∞ · пока идёт захват звука');
        add('Кольцо', 'opacity', '0,25', '0,25 + 0,6 × громкость', 'по сигналу', 'атака 50 мс · спад 180 мс', c.frozen ? 'замирает на паузе' : '∞');
      } else add('Кольцо, 108 % d', 'scale · opacity', '1,12 · 0,55', '1,12 · 0,55', '—', '—', 'статично');
    }
    if (c.arc) {
      if (c.arc.T) add('Дуга 120°, r 59,5 % d, 2 px', 'rotate', '0°', '360°', sec(c.arc.T), 'linear', '∞');
      else add('Дуга 120°, r 59,5 % d, 2 px', 'rotate', c.arc.still + '°', c.arc.still + '°', '—', '—', 'статично');
    }
    if (c.sector) {
      if (c.sector.T) add('Световой сектор', 'rotate', '0°', '360°', sec(c.sector.T), 'linear', '∞');
      else add('Световой сектор', 'rotate', c.sector.still + '°', c.sector.still + '°', '—', '—', 'статично');
    }
    if (c.dots) {
      if (c.dots.T) {
        add('Точки ×3, 5,5 % d, от нижнего края', 'translateY', '0', '+20 % d', '1,2 с', 'ease-in-out', '∞ · сдвиг фаз 0,4 с');
        add('Точки ×3', 'opacity', '0 → 0,9 на 25 %', '0', '1,2 с', 'ease-out', '∞ · сдвиг фаз 0,4 с');
      } else add('Точки ×3', 'translateY · opacity', '0 / 8 / 16 % d', '0,9 / 0,6 / 0,3', '—', '—', 'статично');
    }
    if (c.gap) add('Кольцо подтверждения, 2 px, разрыв 7 %', 'opacity', '0', '1', rm ? '100 мс' : '150 мс', rm ? 'linear' : 'ease-out', 'однократно, затем статично');
    if (c.dim) add('Затемнение ядра', 'opacity', '0', f2(c.dim), ms(c.ramp), 'ease-in-out', 'однократно · яркость −20 %');
    if (c.op < 1) add('Вся сфера', 'opacity', '1', f2(c.op), ms(c.xf), 'ease-in-out', 'однократно · приглушена');
    if (c.badge) add(c.badge === 'alert' ? 'Значок «!»' : 'Значок динамика', 'opacity', '0', '1', rm ? '100 мс' : '200 мс', rm ? 'linear' : 'ease-out', 'однократно');
    return R;
  }

  var RULES = [
    { what: 'Смена цвета', prop: 'opacity нового градиентного слоя поверх старого', from: '0', to: '1', dur: '300 мс', ease: 'ease-in-out', rep: 'однократно', note: 'старый слой снимается в конце; ошибка — 180 мс' },
    { what: 'Смена скорости и амплитуды', prop: 'частота f и амплитуда A осциллятора', from: 'текущие', to: 'целевые', dur: '600 мс', ease: 'ease-in-out', rep: 'однократно', note: 'фаза не сбрасывается: φ += f·dt' },
    { what: 'Остановка движения', prop: 'f, A (ждёт решения)', from: 'текущие', to: '0', dur: '300 мс', ease: 'ease-in-out', rep: 'однократно', note: 'ошибка — 180 мс' },
    { what: 'Появление слоя', prop: 'opacity кольца, дуги, сектора, точек, значка', from: '0', to: '1', dur: '200 мс', ease: 'ease-out', rep: 'однократно', note: 'кольцо подтверждения — 150 мс' },
    { what: 'Исчезновение слоя', prop: 'opacity', from: '1', to: '0', dur: '150 мс', ease: 'ease-in', rep: 'однократно', note: '' },
    { what: 'Вход в занятое', prop: 'задержка показа', from: '—', to: '—', dur: '150 мс', ease: '—', rep: '—', note: 'думает, работает, формирует; быстрый ответ не мелькает' },
    { what: 'Между занятыми', prop: 'минимум показа текущего', from: '—', to: '—', dur: '400 мс', ease: '—', rep: '—', note: 'следующее занятое ждёт своей очереди' },
    { what: 'Правдивые события', prop: 'задержка', from: '—', to: '—', dur: '0 мс', ease: '—', rep: '—', note: 'запись остановлена, связь пропала, нужно подтверждение, голос играет' },
    { what: 'Reduced motion', prop: 'все циклы выключены', from: '—', to: '—', dur: '≤ 100 мс', ease: 'linear', rep: '—', note: 'смена мгновенная или кроссфейд до 100 мс' }
  ];

  var SCENARIOS = [
    { id: 's1', title: 'Покой → думает → работает → формирует → покой', end: 5600,
      note: 'Запрос принят в 0,6 с, «думает» появляется через 150 мс. Поиск начался в 0,98 с, но «работает» ждёт до 1,15 с: занятое состояние держится не меньше 400 мс. Текст закончился — сразу покой.',
      events: [
        { t: 0, to: 'idle', cap: 'на связи' },
        { t: 600, to: 'thinking', cap: 'думаю', label: 'запрос принят' },
        { t: 980, to: 'working', cap: 'проверяю расписание', label: 'поиск расписания' },
        { t: 3100, to: 'forming', cap: 'отвечаю', label: 'пошёл текст' },
        { t: 4700, to: 'idle', cap: 'на связи', label: 'текст готов' }
      ] },
    { id: 's2', title: 'Слушает → думает → говорит', end: 5600,
      note: 'Микрофон выключился в 2,2 с — «слушает» снимается сразу. «Думает» — через 150 мс. Голос начал играть — «говорит» сразу, пульс следует звуку.',
      events: [
        { t: 0, to: 'listening', cap: 'слушаю', label: 'микрофон включён' },
        { t: 2200, to: 'idle', cap: 'на связи', label: 'микрофон выключен' },
        { t: 2200, to: 'thinking', cap: 'думаю', label: 'запрос принят' },
        { t: 3500, to: 'speaking', cap: 'говорю', label: 'играет голос' }
      ] },
    { id: 's3', title: 'Работает → ждёт решения → работает', end: 5600,
      note: 'Нужно подтверждение — сфера останавливается сразу, появляется кольцо с разрывом. После «Удалить заметку» кольцо снимается, дуга возвращается через 150 мс.',
      events: [
        { t: 0, to: 'working', cap: 'ищу заметку «Билеты»' },
        { t: 1300, to: 'awaiting', cap: 'нужно подтверждение', label: 'карточка подтверждения' },
        { t: 3600, to: 'idle', cap: 'на связи', label: '«Удалить заметку»' },
        { t: 3600, to: 'working', cap: 'удаляю заметку' }
      ] }
  ];

  // Правила 150 / 400 мс применяются к событиям сценария → полосы показанных состояний
  function simulate(sc) {
    var ev = sc.events.slice().sort(function (a, b) { return a.t - b.t; });
    var shown = ev[0].to, cap = ev[0].cap, since = 0, pend = null, bands = [], notes = [];
    function commit(t, to, c) { if (t > since) bands.push({ state: shown, caption: cap, from: since, to: t }); shown = to; cap = c; since = t; }
    for (var i = 1; i < ev.length; i++) {
      var e = ev[i];
      if (pend && pend.at <= e.t) { commit(pend.at, pend.to, pend.cap); pend = null; }
      if (!BUSY[e.to]) { pend = null; commit(e.t, e.to, e.cap); continue; }
      if (!BUSY[shown]) { pend = { to: e.to, cap: e.cap, at: e.t + 150 }; notes.push({ kind: 'delay', from: e.t, to: e.t + 150 }); continue; }
      var at = Math.max(e.t, since + 400);
      if (at > e.t) { notes.push({ kind: 'hold', from: since, to: at, ev: e.t }); pend = { to: e.to, cap: e.cap, at: at }; }
      else commit(e.t, e.to, e.cap);
    }
    if (pend && pend.at <= sc.end) commit(pend.at, pend.to, pend.cap);
    bands.push({ state: shown, caption: cap, from: since, to: sc.end });
    return { bands: bands, notes: notes };
  }

  window.JarvisOrbSpec = { PAL: PAL, STATES: STATES, byId: byId, BUSY: BUSY, resolve: resolve, rows: rows, RULES: RULES, SCENARIOS: SCENARIOS, simulate: simulate, f2: f2 };
})();
