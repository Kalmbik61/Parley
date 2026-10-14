# Расход токенов комнаты и сессии — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** итог токенов комнаты с момента входа каждого участника — общий, по провайдерам и по сессиям, с Copy в Markdown — и значок расхода одной сессии в Chat.

**Architecture:** ядро получает журнал участия в комнате (`Room.memberLog`), срез учёта P36 по окнам времени и чистую функцию `roomUsage` с подставляемым источником цифр. Хост отдаёт итог методом `rooms.usage`: готовый итог сессии, если она целиком внутри окна, иначе перечитывает лог со срезом (с кэшем). Окно показывает значок в шапке комнаты и в панели Chat.

**Tech Stack:** TypeScript, Node 20, vitest, zod (протокол), React + Radix Popover + Tailwind (окно), Playwright + Electron (E2E), pnpm workspace.

**Spec:** [`docs/specs/2026-10-14-room-token-usage-design.md`](2026-10-14-room-token-usage-design.md) — читать вместе с планом.

## Global Constraints

- Тексты окна — только английские, в `packages/desktop/src/shared/strings.ts` (раздел `S.usage`); комментарии, тесты и документы — по-русски.
- Токены, не деньги и не процент лимита подписки. Неизвестное — `?`, а не `0`. Нативные id разговоров и пути логов в ответ `rooms.usage` не попадают.
- Без окон (`windows` / `usageWindows` не заданы) учёт работает как раньше: существующие тесты `usage-ledger`, `session-index`, `codex`, `log-index`, `activity-service` проходят без правок.
- Карта без `memberLog` читается; битый `memberLog` убирается, а карта остаётся читаемой.
- Хост без `rooms.usage` (окно новее хоста) — значка комнаты нет (`useHostSupports('rooms.usage')`).
- Окно спрашивает `rooms.usage` только при `active` и не чаще раза в 10 секунд.
- Раскладка проверяется в окне 800×500 при масштабе 1 и 2.
- Хост и окно берут ядро и протокол собранными: после правок ядра или протокола перед их тестами — `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Перед тяжёлыми прогонами (полные наборы, E2E) — `uptime`; при загрузке не меньше числа ядер прогон отложить.
- Один коммит на задачу, сообщение по-русски в стиле репозитория (`feat(core): …`), последней строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Ведущий долго работал до комнаты — его прежний расход не попадает в итог комнаты (тесты: задача 5 «срез по окну участия», задача 6 «Claude: только ответы внутри окна»).
2. Агент только что запущен, ответов модели в логе ещё нет — в строке `0`, а не `n/a` (задача 6, `wholeSessionUsage`).
3. Сессию перетащили в другую комнату — старая комната считает её расход до ухода, новая — после входа (задача 1, задача 5).
4. Комната в архиве, участник продолжает работать в другой комнате — итог архивной не растёт (задача 5, «архив режет окна»).
5. Codex не сообщает запись в кэш — `Cache write` остаётся `?`, в том числе когда в окно не попало ни одной записи (задача 2, «ноль по сообщаемым полям»).

---

### Task 1: Журнал участия в карте

**Files:**
- Modify: `packages/core/src/work/types.ts` (тип `RoomMembership`, поле `Room.memberLog`)
- Modify: `packages/core/src/work/map.ts` (`migrateRoom` и проверка журнала)
- Modify: `packages/core/src/work/rooms.ts` (`joinedLine`, `addRoom`, `addMember`, `leaveOtherRooms`)
- Modify: `packages/host/src/rooms/rooms-service.ts:129`
- Modify: `packages/core/src/mcp/tools.ts:1168`
- Modify: `packages/core/src/index.ts` (экспорт `joinedLine`, тип `RoomMembership`)
- Test: `packages/core/src/work/rooms.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `interface RoomMembership { session: string; from: string; to: string | null }`; `Room.memberLog?: RoomMembership[]`
  - `joinedLine(sessionId: string): string` — `'@s01 joined the room'` для `'s-01'`
  - `leaveOtherRooms(map: WorkMap, sessionId: string, exceptRoomId: string, at?: string): void`

- [ ] **Step 1: Write the failing tests**

В `packages/core/src/work/rooms.test.ts` добавить `joinedLine` в импорт из `./rooms.js` и в конец файла:

```ts
describe('журнал участия (спека расхода токенов, 4)', () => {
  const T0 = '2026-10-14T10:00:00.000Z';
  const T1 = '2026-10-14T11:00:00.000Z';
  const T2 = '2026-10-14T12:00:00.000Z';

  it('addRoom пишет создателя-сессию и участников с моментом создания; человек в журнал не попадает', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    addSession(map, { provider: 'claude', label: 'b', task: 'x' });
    const byLead = addRoom(map, { title: 'r', creator: 's-01', members: ['s-02'] }, T0);
    expect(byLead.memberLog).toEqual([
      { session: 's-01', from: T0, to: null },
      { session: 's-02', from: T0, to: null },
    ]);
    const byHuman = addRoom(map, { title: 'h', creator: HUMAN, members: ['s-02'] }, T0);
    expect(byHuman.memberLog).toEqual([{ session: 's-02', from: T0, to: null }]);
  });

  it('addMember закрывает запись в прежней комнате тем же моментом и открывает новую; повторный вход — новая запись', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const first = addRoom(map, { title: 'r1', creator: HUMAN, members: ['s-01'] }, T0);
    const second = addRoom(map, { title: 'r2', creator: HUMAN, members: [] }, T0);
    addMember(map, second.id, 's-01', T1);
    expect(first.memberLog).toEqual([{ session: 's-01', from: T0, to: T1 }]);
    expect(second.memberLog).toEqual([{ session: 's-01', from: T1, to: null }]);
    addMember(map, first.id, 's-01', T2);
    expect(first.memberLog).toEqual([
      { session: 's-01', from: T0, to: T1 },
      { session: 's-01', from: T2, to: null },
    ]);
    expect(second.memberLog).toEqual([{ session: 's-01', from: T1, to: T2 }]);
  });

  it('комната без журнала (карта до него) журнал не заводит ни при входе, ни при уходе', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const legacy = addRoom(map, { title: 'old', creator: HUMAN, members: ['s-01'] }, T0);
    delete legacy.memberLog;
    const fresh = addRoom(map, { title: 'new', creator: HUMAN, members: [] }, T0);
    addMember(map, fresh.id, 's-01', T1);
    expect(legacy.memberLog).toBeUndefined();
    addMember(map, legacy.id, 's-01', T2);
    expect(legacy.memberLog).toBeUndefined();
    expect(fresh.memberLog).toEqual([{ session: 's-01', from: T1, to: T2 }]);
  });

  it('строка входа — joinedLine, та же, что пишет addMember', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const room = addRoom(map, { title: 'r', creator: HUMAN, members: [] }, T0);
    expect(addMember(map, room.id, 's-01', T1).text).toBe(joinedLine('s-01'));
    expect(joinedLine('s-01')).toBe('@s01 joined the room');
  });

  it('parseMap: целый журнал читается как есть, битый убирается, нет поля — не подставляется', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    addRoom(map, { title: 'r1', creator: HUMAN, members: ['s-01'] }, T0);
    addRoom(map, { title: 'r2', creator: HUMAN, members: [] }, T0);
    addRoom(map, { title: 'r3', creator: HUMAN, members: [] }, T0);
    const raw = JSON.parse(JSON.stringify(map)) as { rooms: Array<Record<string, unknown>> };
    raw.rooms[1]!['memberLog'] = [{ session: '', from: 'вчера', to: 5 }];
    delete raw.rooms[2]!['memberLog'];
    const parsed = parseMap(JSON.stringify(raw), 'map.json');
    expect(parsed.rooms[0]?.memberLog).toEqual([{ session: 's-01', from: T0, to: null }]);
    expect(parsed.rooms[1]?.memberLog).toBeUndefined();
    expect(parsed.rooms[2]?.memberLog).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/work/rooms.test.ts -t "журнал участия"`
Expected: FAIL — `joinedLine` не экспортируется, `memberLog` равен `undefined`.

- [ ] **Step 3: Implement**

`packages/core/src/work/types.ts` — перед `export interface Room`:

```ts
/** Запись журнала участия (спека расхода токенов, 4.1). */
export interface RoomMembership {
  /** Id сессии; человек в журнал не пишется. */
  session: string;
  /** Вход: создание комнаты для создателя и начальных участников, иначе момент `addMember`. */
  from: string;
  /** Уход (`leaveOtherRooms`); `null` — участник до сих пор в комнате. */
  to: string | null;
}
```

и в `Room` после `archivedAt?`:

```ts
  /**
   * Журнал участия (спека расхода токенов, 4.1): кто, когда вошёл и вышел. Нет поля — комната создана до журнала, её
   * история восстанавливается по ленте (`roomMembership`). Битый журнал `parseMap` убирает.
   */
  memberLog?: RoomMembership[];
```

`packages/core/src/work/map.ts` — над `migrateRoom`:

```ts
const isIsoTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Журнал участия комнаты: записи с id сессии, моментом входа и уходом (`null` — ещё в комнате). */
function isMemberLog(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry['session'] === 'string' && entry['session'] !== '' &&
    isIsoTime(entry['from']) && (entry['to'] === null || isIsoTime(entry['to'])));
}
```

и в конец тела `migrateRoom`:

```ts
  // Журнал участия (спека расхода токенов, 4.1): битый убирается — комната читается как созданная до журнала,
  // а карта из-за него не становится нечитаемой.
  if (room['memberLog'] !== undefined && !isMemberLog(room['memberLog'])) delete room['memberLog'];
```

`packages/core/src/work/rooms.ts`:

1. Новая функция рядом с `addSystemMessage`:

```ts
/** Строка ленты о входе сессии в комнату; по ней же восстанавливается участие в старых комнатах (спека расхода токенов, 4.3). */
export function joinedLine(sessionId: string): string {
  return `${sessionMention(sessionId)} joined the room`;
}
```

2. `addRoom` — в литерал `room` после `archivedAt: null,`:

```ts
    // Журнал участия (спека расхода токенов, 4.2): создатель-сессия и начальные участники входят в момент создания.
    memberLog: [...new Set([init.creator, ...init.members])]
      .filter((id) => id !== HUMAN)
      .map((session) => ({ session, from: at, to: null })),
```

3. `leaveOtherRooms` — новый параметр и закрытие записей:

```ts
export function leaveOtherRooms(map: WorkMap, sessionId: string, exceptRoomId: string, at = new Date().toISOString()): void {
  for (const room of map.rooms) {
    if (room.id === exceptRoomId) continue;
    room.members = room.members.filter((id) => id !== sessionId);
    if (room.creator === sessionId) room.creator = HUMAN;
    if (room.lead === sessionId) room.lead = null;
    // Уход — в журнал той комнаты, у которой он есть (спека расхода токенов, 4.2).
    for (const entry of room.memberLog ?? []) if (entry.session === sessionId && entry.to === null) entry.to = at;
  }
}
```

4. `addMember` — хвост функции заменить на:

```ts
  leaveOtherRooms(map, sessionId, roomId, at);
  if (!inRoom) room.members.push(sessionId);
  // Журнал ведут только комнаты, у которых он есть: старая восстанавливается по ленте (спека расхода токенов, 4.3).
  if (room.memberLog !== undefined && !room.memberLog.some((entry) => entry.session === sessionId && entry.to === null)) {
    room.memberLog.push({ session: sessionId, from: at, to: null });
  }
  return addSystemMessage(map, roomId, joinedLine(sessionId), at);
```

`packages/host/src/rooms/rooms-service.ts:129`:

```ts
    for (const id of members) leaveOtherRooms(map, id, room.id, room.createdAt);
```

`packages/core/src/mcp/tools.ts:1168`:

```ts
    for (const memberId of [sessionId, ...members]) leaveOtherRooms(current, memberId, room.id, room.createdAt);
```

`packages/core/src/index.ts`: `joinedLine` — в список экспорта из `./work/rooms.js` (там, где `leaveOtherRooms`); `RoomMembership` — в блок `export type { … } from './work/types.js'`, где стоит `Room`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/work/rooms.test.ts`
Expected: PASS.

Run: `pnpm --filter @parley/core test`
Expected: PASS. Если какой-то прежний тест сравнивает комнату целиком (`toEqual`) и падает только из-за нового поля — добавить в его ожидание `memberLog` с нужными записями, код не менять.

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/rooms`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/types.ts packages/core/src/work/map.ts packages/core/src/work/rooms.ts packages/core/src/work/rooms.test.ts packages/core/src/mcp/tools.ts packages/core/src/index.ts packages/host/src/rooms/rooms-service.ts
git commit -m "feat(core): журнал участия в комнате — вход и уход сессий с моментом"
```

---

### Task 2: Срез учёта по окнам времени

**Files:**
- Modify: `packages/core/src/work/usage-ledger.ts`
- Modify: `packages/core/src/index.ts` (типы `UsageWindow`, `UsageLedgerOptions`)
- Test: `packages/core/src/work/usage-ledger.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `interface UsageWindow { from: string; to: string | null }`
  - `interface UsageLedgerOptions { windows?: readonly UsageWindow[] }`
  - `createUsageLedger(options?: UsageLedgerOptions)` — то же API (`observe`, `markAmbiguous`, `summary`)

- [ ] **Step 1: Write the failing tests**

В конец `packages/core/src/work/usage-ledger.test.ts` (хелперы `delta`, `cumulative`, `counters` уже есть в файле):

```ts
describe('createUsageLedger со срезом по окнам (спека расхода токенов, 5.3)', () => {
  const at = (hhmm: string): string => `2026-10-04T${hhmm}:00.000Z`;
  const W = { from: at('12:00'), to: at('13:00') };

  it('разовые записи: учитываются только внутри окна, границы включительно', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(delta('a', { input: 1 }, at('11:59')));
    ledger.observe(delta('b', { input: 10 }, at('12:00')));
    ledger.observe(delta('c', { input: 20 }, at('12:30')));
    ledger.observe(delta('d', { input: 40 }, at('13:00')));
    ledger.observe(delta('e', { input: 80 }, at('13:01')));
    expect(ledger.summary()).toMatchObject({ input: 70, completeness: 'complete', observedAt: at('13:00') });
  });

  it('запись без времени при срезе не учитывается, итог неполный', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(delta('a', { input: 10 }, at('12:30')));
    ledger.observe(delta('b', { input: 99 }, null));
    expect(ledger.summary()).toMatchObject({ input: 10, completeness: 'partial' });
  });

  it('накопитель: наибольшее в окне минус значение до его начала', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(cumulative({ input: 100 }, { at: at('11:00') }));
    ledger.observe(cumulative({ input: 150 }, { at: at('12:30') }));
    ledger.observe(cumulative({ input: 300 }, { at: at('14:00') }));
    expect(ledger.summary()).toMatchObject({ input: 50, completeness: 'complete', observedAt: at('12:30') });
  });

  it('накопитель, начатый внутри окна, считается от нуля', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(cumulative({ input: 40 }, { at: at('12:10') }));
    ledger.observe(cumulative({ input: 70 }, { at: at('12:50') }));
    expect(ledger.summary()).toMatchObject({ input: 70 });
  });

  it('сброс внутри окна: закрытый период — от базы окна, новый — от нуля', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(cumulative({ input: 100 }, { at: at('11:00') }));
    ledger.observe(cumulative({ input: 150 }, { at: at('12:10') }));
    ledger.observe(cumulative({ input: 5 }, { at: at('12:20'), reset: true }));
    ledger.observe(cumulative({ input: 25 }, { at: at('12:50') }));
    expect(ledger.summary()).toMatchObject({ input: 75, completeness: 'complete' });
  });

  it('спад накопителя без сброса — итог неполный, как без среза', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(cumulative({ input: 100 }, { at: at('12:10') }));
    ledger.observe(cumulative({ input: 80 }, { at: at('12:20') }));
    expect(ledger.summary()).toMatchObject({ completeness: 'partial' });
  });

  it('два окна: разовые записи и накопитель считаются по каждому окну', () => {
    const windows = [W, { from: at('14:00'), to: at('15:00') }];
    const deltas = createUsageLedger({ windows });
    deltas.observe(delta('a', { input: 10 }, at('12:30')));
    deltas.observe(delta('b', { input: 20 }, at('13:30')));
    deltas.observe(delta('c', { input: 40 }, at('14:30')));
    expect(deltas.summary()).toMatchObject({ input: 50 });

    const stream = createUsageLedger({ windows });
    stream.observe(cumulative({ input: 100 }, { at: at('11:00') }));
    stream.observe(cumulative({ input: 150 }, { at: at('12:30') }));
    stream.observe(cumulative({ input: 200 }, { at: at('13:30') }));
    stream.observe(cumulative({ input: 260 }, { at: at('14:30') }));
    expect(stream.summary()).toMatchObject({ input: 110 });
  });

  it('открытое окно (to: null) берёт всё после начала', () => {
    const ledger = createUsageLedger({ windows: [{ from: at('12:00'), to: null }] });
    ledger.observe(delta('a', { input: 1 }, at('11:00')));
    ledger.observe(delta('b', { input: 10 }, at('23:00')));
    expect(ledger.summary()).toMatchObject({ input: 10 });
  });

  it('в окна ничего не попало, а записи в логе есть — ноль по сообщаемым полям, несообщаемое неизвестно', () => {
    const ledger = createUsageLedger({ windows: [W] });
    ledger.observe(cumulative({ input: 100, cacheWrite: null }, { at: at('11:00') }));
    expect(ledger.summary()).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: null,
      totalInput: 0,
      completeness: 'complete',
      observedAt: null,
    });
  });

  it('лог без записей с usage при срезе — неизвестно, как без среза', () => {
    expect(createUsageLedger({ windows: [W] }).summary()).toMatchObject({ input: null, completeness: 'unknown' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/work/usage-ledger.test.ts -t "срезом по окнам"`
Expected: FAIL — окна игнорируются, суммы больше ожидаемых.

- [ ] **Step 3: Implement**

В `packages/core/src/work/usage-ledger.ts` перед `createUsageLedger` добавить:

```ts
/** Окно среза учёта (спека расхода токенов, 5.3): `to: null` — открыто до «сейчас». */
export interface UsageWindow {
  from: string;
  to: string | null;
}

export interface UsageLedgerOptions {
  /** Учитывать только наблюдения внутри окон. Нет — весь лог, как раньше. */
  windows?: readonly UsageWindow[];
}

/** Окно в миллисекундах. */
interface Span {
  from: number;
  to: number;
}

/** Окна по порядку и без перекрытий; окно с нечитаемыми границами отбрасывается. */
function spansOf(windows: readonly UsageWindow[]): Span[] {
  const parsed = windows
    .map((window) => ({ from: Date.parse(window.from), to: window.to === null ? Number.POSITIVE_INFINITY : Date.parse(window.to) }))
    .filter((span) => !Number.isNaN(span.from) && !Number.isNaN(span.to) && span.from <= span.to)
    .sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const span of parsed) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

const inside = (spans: readonly Span[], t: number): boolean => spans.some((span) => t >= span.from && t <= span.to);

const zeroCounters = (): UsageCounters => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0 });

/** Поле за полем `end - base`; неизвестное у любой стороны — неизвестно. */
function difference(end: UsageCounters, base: UsageCounters): UsageCounters {
  const result = unknownCounters();
  for (const field of FIELDS) {
    const a = end[field];
    const b = base[field];
    result[field] = a === null || b === null ? null : Math.max(0, a - b);
  }
  return result;
}

/** Точка накопителя при срезе: значение и момент записи. */
interface StreamPoint {
  counters: UsageCounters;
  t: number;
  at: string;
  reset: boolean;
  child: boolean;
}

/**
 * Вклад накопителей в окна (5.3). Нить делится на периоды по сбросам; вклад периода в окно — наибольшее значение внутри
 * окна минус наибольшее до его начала (нет таких — ноль: период начался в окне). Спад внутри периода без сброса —
 * неоднозначность, как и без среза.
 */
function sliceStreams(streams: Map<string, StreamPoint[]>, spans: readonly Span[]) {
  const parts: UsageCounters[] = [];
  let ambiguous = false;
  let lastAt: string | null = null;
  let child = false;
  for (const points of streams.values()) {
    const periods: StreamPoint[][] = [];
    for (const point of points) {
      const current = periods[periods.length - 1];
      if (point.reset || current === undefined) periods.push([point]);
      else current.push(point);
    }
    for (const period of periods) {
      let peak = unknownCounters();
      for (const point of period) {
        if (FIELDS.some((field) => point.counters[field] !== null && peak[field] !== null && point.counters[field]! < peak[field]!)) {
          ambiguous = true;
        }
        peak = maxCounters(peak, point.counters);
      }
      for (const span of spans) {
        const within = period.filter((point) => point.t >= span.from && point.t <= span.to);
        if (within.length === 0) continue;
        const before = period.filter((point) => point.t < span.from);
        const base = before.length === 0 ? zeroCounters() : before.map((point) => point.counters).reduce(maxCounters);
        parts.push(difference(within.map((point) => point.counters).reduce(maxCounters), base));
        for (const point of within) {
          if (lastAt === null || point.at > lastAt) lastAt = point.at;
          if (point.child) child = true;
        }
      }
    }
  }
  return { parts, ambiguous, lastAt, child };
}
```

`createUsageLedger` заменить целиком (без окон — прежний путь, строка в строку):

```ts
export function createUsageLedger(options: UsageLedgerOptions = {}) {
  const deltas = new Map<string, UsageCounters>();
  const streams = new Map<string, UsageCounters[]>();
  const spans = options.windows === undefined ? null : spansOf(options.windows);
  /** Точки накопителей при срезе: итог по ним считается в `summary`. */
  const points = new Map<string, StreamPoint[]>();
  /** Поля, которые лог сообщает хоть в одной записи: при пустом срезе они ноль, прочие неизвестны. */
  const reported = new Set<keyof UsageCounters>();
  let ambiguous = false;
  let lastAt: string | null = null;
  let descendants = false;

  return {
    observe(observation: UsageObservation): void {
      const counters = pick(observation.counters);
      for (const field of FIELDS) if (counters[field] !== null) reported.add(field);
      if (spans !== null) {
        const t = observation.at === null ? Number.NaN : Date.parse(observation.at);
        // Запись без времени при срезе не отнести ни внутрь окна, ни наружу: не учитывается, итог неполный.
        if (Number.isNaN(t)) {
          ambiguous = true;
          return;
        }
        if (observation.kind === 'cumulative') {
          const list = points.get(observation.stream) ?? [];
          list.push({ counters, t, at: observation.at as string, reset: observation.reset === true, child: observation.child === true });
          points.set(observation.stream, list);
          return;
        }
        if (!inside(spans, t)) return;
      }
      if (observation.at !== null && (lastAt === null || observation.at > lastAt)) lastAt = observation.at;
      if (observation.child === true) descendants = true;

      if (observation.kind === 'delta') {
        const known = deltas.get(observation.id);
        deltas.set(observation.id, known === undefined ? counters : maxCounters(known, counters));
        return;
      }

      const periods = streams.get(observation.stream);
      if (periods === undefined) {
        streams.set(observation.stream, [counters]);
        return;
      }
      const current = periods[periods.length - 1]!;
      if (observation.reset === true) {
        periods.push(counters);
        return;
      }
      if (FIELDS.some((field) => counters[field] !== null && current[field] !== null && counters[field]! < current[field]!)) {
        ambiguous = true;
      }
      periods[periods.length - 1] = maxCounters(current, counters);
    },

    /** Адаптер нашёл перекрытие, которое нечем разрешить: запись не учтена, итог неполный. */
    markAmbiguous(): void {
      ambiguous = true;
    },

    summary(): UsageSummary {
      const sliced = spans === null ? null : sliceStreams(points, spans);
      const contributions = [...deltas.values(), ...(sliced === null ? [...streams.values()].flat() : sliced.parts)];
      const unclear = ambiguous || sliced?.ambiguous === true;
      if (contributions.length === 0) {
        // Срез: в окна не попало ничего, а записи с usage в логе есть — расход в окнах известен и равен нулю по полям,
        // которые лог сообщает (у Codex записи в кэш нет — она остаётся неизвестной).
        if (sliced !== null && reported.size > 0) {
          const zero = unknownCounters();
          for (const field of reported) zero[field] = 0;
          return {
            ...zero,
            source: 'native-index',
            observedAt: null,
            stale: false,
            completeness: unclear ? 'partial' : 'complete',
            coverage: 'conversation',
          };
        }
        return { ...unknownCounters(), ...unobserved('native-index') };
      }

      const totals = unknownCounters();
      let mixed = false;
      for (const field of FIELDS) {
        const known = contributions.filter((item) => item[field] !== null);
        // Поле есть не у всех записей — сумма была бы заниженной, поэтому неизвестна.
        if (known.length === contributions.length) {
          totals[field] = contributions.reduce<number | null>((acc, item) => sum(acc, item[field]), 0);
        } else if (known.length > 0) {
          mixed = true;
        }
      }
      const observedAt = sliced?.lastAt != null && (lastAt === null || sliced.lastAt > lastAt) ? sliced.lastAt : lastAt;
      return {
        ...totals,
        source: 'native-index',
        observedAt,
        stale: false,
        completeness: unclear || mixed ? 'partial' : 'complete',
        coverage: descendants || sliced?.child === true ? 'conversation-and-descendants' : 'conversation',
      };
    },
  };
}
```

Важно: строки `lastAt` и `descendants` в начале `observe` теперь стоят **после** фильтра окон — иначе запись вне окна сдвинула бы `observedAt` и пометила потомков. Без окон порядок не важен: фильтра нет.

`packages/core/src/index.ts` — в блок `export type { … } from './work/usage-ledger.js'` добавить `UsageLedgerOptions` и `UsageWindow`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/work/usage-ledger.test.ts`
Expected: PASS — и новые, и все прежние тесты файла.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/usage-ledger.ts packages/core/src/work/usage-ledger.test.ts packages/core/src/index.ts
git commit -m "feat(core): срез учёта токенов по окнам времени"
```

---

### Task 3: Окна в индексах логов Claude и Codex

**Files:**
- Modify: `packages/core/src/session-index.ts` (`IndexSessionOptions.usageWindows`)
- Modify: `packages/core/src/codex/index-session.ts` (третий параметр `indexCodexSession`)
- Test: `packages/core/src/session-index.test.ts`
- Test: `packages/core/src/codex/index-session-slice.test.ts` (новый)

**Interfaces:**
- Consumes: `UsageWindow`, `createUsageLedger(options)` (задача 2)
- Produces:
  - `indexSessionFile(file, root, { …, usageWindows?: readonly UsageWindow[] })` — `usage` только из окон
  - `indexCodexSession(file: string, signal?: AbortSignal, options?: { usageWindows?: readonly UsageWindow[] })`

- [ ] **Step 1: Write the failing tests**

В конец `packages/core/src/session-index.test.ts` (импорты `mkdtemp`, `mkdir`, `writeFile`, `rm`, `tmpdir`, `path`, `discoverSession`, `indexSessionFile` уже есть):

```ts
describe('indexSessionFile со срезом по окнам (спека расхода токенов, 5.3)', () => {
  it('в usage только ответы внутри окна, подагенты режутся тем же окном', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'parley-slice-'));
    try {
      const dir = path.join(root, '-proj');
      await mkdir(path.join(dir, 'sess', 'subagents'), { recursive: true });
      const answer = (msg: string, at: string, input: number): string =>
        JSON.stringify({ type: 'assistant', sessionId: 'sess', timestamp: at, message: { role: 'assistant', id: msg, usage: { input_tokens: input, output_tokens: 1 } } });
      const file = path.join(dir, 'sess.jsonl');
      await writeFile(file, [answer('m1', '2026-10-14T09:00:00.000Z', 100), answer('m2', '2026-10-14T11:00:00.000Z', 10)].join('\n'));
      await writeFile(
        path.join(dir, 'sess', 'subagents', 'agent-a1.jsonl'),
        [answer('a1', '2026-10-14T09:30:00.000Z', 1000), answer('a2', '2026-10-14T11:30:00.000Z', 5)].join('\n'),
      );
      const { subagents } = await discoverSession(file, root);
      const index = await indexSessionFile(file, root, {
        subagents,
        usageWindows: [{ from: '2026-10-14T10:00:00.000Z', to: null }],
      });
      expect(index.usage).toMatchObject({ input: 15, coverage: 'conversation-and-descendants' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Новый файл `packages/core/src/codex/index-session-slice.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexCodexSession } from './index-session.js';

describe('indexCodexSession со срезом по окнам (спека расхода токенов, 5.3)', () => {
  it('накопитель режется окном: наибольшее в окне минус значение до него; запись в кэш остаётся неизвестной', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-codex-slice-'));
    try {
      const file = path.join(dir, 'rollout-2026-10-14T09-00-00-t1.jsonl');
      const count = (at: string, input: number) => ({
        type: 'event_msg',
        timestamp: at,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } },
      });
      await writeFile(
        file,
        [
          { type: 'session_meta', timestamp: '2026-10-14T09:00:00.000Z', payload: { id: 't1', cwd: '/codex', source: 'cli' } },
          count('2026-10-14T09:10:00.000Z', 100),
          count('2026-10-14T11:00:00.000Z', 160),
        ]
          .map((line) => JSON.stringify(line))
          .join('\n'),
      );
      const whole = await indexCodexSession(file);
      expect(whole.usage).toMatchObject({ input: 160 });
      const sliced = await indexCodexSession(file, undefined, { usageWindows: [{ from: '2026-10-14T10:00:00.000Z', to: null }] });
      expect(sliced.usage).toMatchObject({ input: 60, cacheWrite: null, completeness: 'complete' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/session-index.test.ts src/codex/index-session-slice.test.ts -t "срезом по окнам"`
Expected: FAIL — `input` 1115 и 160 вместо 15 и 60.

- [ ] **Step 3: Implement**

`packages/core/src/session-index.ts`: импорт `type UsageWindow` из `./work/usage-ledger.js`; в `IndexSessionOptions`:

```ts
  /**
   * Окна среза учёта (спека расхода токенов, 5.3): в `usage` (и в `tokens`) только записи из них. Нет — весь лог.
   * Вызывающий со срезом берёт из индекса только `usage`.
   */
  usageWindows?: readonly UsageWindow[];
```

в сигнатуре `indexSessionFile` добавить `usageWindows` в деструктуризацию и заменить создание учёта:

```ts
  const ledger = createUsageLedger(usageWindows === undefined ? {} : { windows: usageWindows });
```

`packages/core/src/codex/index-session.ts`: импорт `type UsageWindow`; сигнатура и учёт:

```ts
export async function indexCodexSession(
  file: string,
  signal?: AbortSignal,
  options: { usageWindows?: readonly UsageWindow[] } = {},
): Promise<SessionIndex> {
```

```ts
  const ledger = createUsageLedger(options.usageWindows === undefined ? {} : { windows: options.usageWindows });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/session-index.test.ts src/codex`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-index.ts packages/core/src/session-index.test.ts packages/core/src/codex/index-session.ts packages/core/src/codex/index-session-slice.test.ts
git commit -m "feat(core): индексы логов Claude и Codex режут учёт по окнам"
```

---

### Task 4: История участия комнаты

**Files:**
- Create: `packages/core/src/work/room-membership.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/work/room-membership.test.ts`

**Interfaces:**
- Consumes: `joinedLine`, `Room.memberLog` (задача 1); `UsageWindow` (задача 2)
- Produces:
  - `interface MemberPeriods { session: string; periods: UsageWindow[] }`
  - `interface RoomMembershipView { members: MemberPeriods[]; reconstructed: boolean }`
  - `roomMembership(map: WorkMap, roomId: string): RoomMembershipView` — окна без обрезки архивом
  - `isCurrentMember(room: Room, sessionId: string): boolean`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/work/room-membership.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { roomMembership } from './room-membership.js';
import { addMember, addRoom } from './rooms.js';
import { HUMAN, type WorkMap } from './types.js';

const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T11:00:00.000Z';
const T2 = '2026-10-14T12:00:00.000Z';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

describe('roomMembership (спека расхода токенов, 4.3, 5.1)', () => {
  it('журнал: окна как записаны, повторный вход — второе окно', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const r1 = addRoom(map, { title: 'r1', creator: HUMAN, members: ['s-01'] }, T0);
    const r2 = addRoom(map, { title: 'r2', creator: HUMAN, members: [] }, T0);
    addMember(map, r2.id, 's-01', T1);
    addMember(map, r1.id, 's-01', T2);
    expect(roomMembership(map, r1.id)).toEqual({
      reconstructed: false,
      members: [{ session: 's-01', periods: [{ from: T0, to: T1 }, { from: T2, to: null }] }],
    });
  });

  it('старая комната: создатель — с создания, вошедший позже — по строке «joined», ушедший — до входа в другую комнату; ушедший начальный участник не восстанавливается', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    addSession(map, { provider: 'claude', label: 'b', task: 'x' });
    addSession(map, { provider: 'claude', label: 'c', task: 'x' });
    const old = addRoom(map, { title: 'old', creator: 's-01', members: ['s-02'] }, T0);
    addMember(map, old.id, 's-03', T1);
    const fresh = addRoom(map, { title: 'new', creator: HUMAN, members: [] }, T0);
    addMember(map, fresh.id, 's-03', T2);
    addMember(map, fresh.id, 's-02', T2);
    delete old.memberLog;
    expect(roomMembership(map, old.id)).toEqual({
      reconstructed: true,
      members: [
        { session: 's-01', periods: [{ from: T0, to: null }] },
        { session: 's-03', periods: [{ from: T1, to: T2 }] },
      ],
    });
  });

  it('старая карта: текущий участник, числящийся и в другой комнате, из этой не уходил', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 'x' });
    const r1 = addRoom(map, { title: 'r1', creator: HUMAN, members: ['s-01'] }, T0);
    const r2 = addRoom(map, { title: 'r2', creator: HUMAN, members: ['s-01'] }, T1);
    delete r1.memberLog;
    delete r2.memberLog;
    expect(roomMembership(map, r1.id).members).toEqual([{ session: 's-01', periods: [{ from: T0, to: null }] }]);
  });

  it('неизвестная комната — ошибка', () => {
    expect(() => roomMembership(emptyMap(), 'r-09')).toThrow('room r-09 is not in the map');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/work/room-membership.test.ts`
Expected: FAIL — модуля `./room-membership.js` нет.

- [ ] **Step 3: Implement**

`packages/core/src/work/room-membership.ts`:

```ts
/**
 * Окна участия сессий в комнате (спека расхода токенов, 4.3, 5.1): по журналу `Room.memberLog`, а у комнаты, созданной
 * до журнала, — восстановленные по ленте и составу. Обрезки архивом здесь нет: её делает подсчёт (`roomUsage`).
 */

import { joinedLine } from './rooms.js';
import { HUMAN, SYSTEM, type Room, type WorkMap } from './types.js';
import type { UsageWindow } from './usage-ledger.js';

export interface MemberPeriods {
  session: string;
  /** По времени входа, без перекрытий; `to: null` — ещё в комнате. */
  periods: UsageWindow[];
}

export interface RoomMembershipView {
  /** По времени первого входа. */
  members: MemberPeriods[];
  /** Комната без журнала: история восстановлена и может быть неполной. */
  reconstructed: boolean;
}

interface Entry {
  room: string;
  at: string;
}

const ms = (iso: string): number => Date.parse(iso);
const end = (to: string | null): number => (to === null ? Number.POSITIVE_INFINITY : ms(to));

/** Текущий участник из сессий: создатель-сессия или запись в `members`. */
export const isCurrentMember = (room: Room, sessionId: string): boolean =>
  sessionId !== HUMAN && (room.creator === sessionId || room.members.includes(sessionId));

/** Входы в старую комнату: строки «joined» её ленты, а у текущих участников без строки — создание комнаты. */
function legacyEntries(map: WorkMap, room: Room): Array<{ session: string; at: string }> {
  const lines = new Map<string, string[]>();
  for (const message of map.messages) {
    if (message.roomId !== room.id || message.from !== SYSTEM) continue;
    lines.set(message.text, [...(lines.get(message.text) ?? []), message.at]);
  }
  const candidates = new Set([...map.sessions.map((session) => session.id), ...room.members, room.creator]);
  candidates.delete(HUMAN);
  const entries: Array<{ session: string; at: string }> = [];
  for (const session of candidates) {
    const times = lines.get(joinedLine(session)) ?? [];
    for (const at of times) entries.push({ session, at });
    if (times.length === 0 && isCurrentMember(room, session)) entries.push({ session, at: room.createdAt });
  }
  return entries;
}

/** Все входы каждой сессии во все комнаты работы, по времени. */
function entriesBySession(map: WorkMap): Map<string, Entry[]> {
  const result = new Map<string, Entry[]>();
  for (const room of map.rooms) {
    const entries =
      room.memberLog !== undefined
        ? room.memberLog.map((record) => ({ session: record.session, at: record.from }))
        : legacyEntries(map, room);
    for (const { session, at } of entries) result.set(session, [...(result.get(session) ?? []), { room: room.id, at }]);
  }
  for (const list of result.values()) list.sort((a, b) => ms(a.at) - ms(b.at));
  return result;
}

/** Окна одной сессии по порядку, перекрытия склеены. */
function merge(periods: readonly UsageWindow[]): UsageWindow[] {
  const merged: UsageWindow[] = [];
  for (const period of [...periods].sort((a, b) => ms(a.from) - ms(b.from))) {
    const last = merged[merged.length - 1];
    if (last !== undefined && ms(period.from) <= end(last.to)) {
      if (end(period.to) > end(last.to)) last.to = period.to;
    } else merged.push({ ...period });
  }
  return merged;
}

function group(periods: ReadonlyArray<{ session: string } & UsageWindow>): MemberPeriods[] {
  const bySession = new Map<string, UsageWindow[]>();
  for (const { session, from, to } of periods) bySession.set(session, [...(bySession.get(session) ?? []), { from, to }]);
  return [...bySession]
    .map(([session, list]) => ({ session, periods: merge(list) }))
    .sort((a, b) => ms(a.periods[0]!.from) - ms(b.periods[0]!.from));
}

/**
 * Окна участия в комнате. По журналу — как записаны. Без журнала: каждый вход длится до ближайшего входа той же сессии
 * в другую комнату (одна комната на сессию); последний вход текущего участника открыт — в старых картах сессия
 * числилась в нескольких комнатах разом. Ушедшего начального участника и ушедшего создателя восстановить не по чему.
 */
export function roomMembership(map: WorkMap, roomId: string): RoomMembershipView {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`room ${roomId} is not in the map`);
  if (room.memberLog !== undefined) {
    return { reconstructed: false, members: group(room.memberLog.map(({ session, from, to }) => ({ session, from, to }))) };
  }
  const periods: Array<{ session: string } & UsageWindow> = [];
  for (const [session, entries] of entriesBySession(map)) {
    const here = entries.filter((entry) => entry.room === roomId);
    here.forEach((entry, index) => {
      const open = index === here.length - 1 && isCurrentMember(room, session);
      const exit = open ? undefined : entries.find((next) => next.room !== roomId && ms(next.at) > ms(entry.at));
      periods.push({ session, from: entry.at, to: exit?.at ?? null });
    });
  }
  return { reconstructed: true, members: group(periods) };
}
```

`packages/core/src/index.ts`:

```ts
export { isCurrentMember, roomMembership } from './work/room-membership.js';
export type { MemberPeriods, RoomMembershipView } from './work/room-membership.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/work/room-membership.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/room-membership.ts packages/core/src/work/room-membership.test.ts packages/core/src/index.ts
git commit -m "feat(core): окна участия сессий в комнате — по журналу и восстановленные"
```

---

### Task 5: Итог комнаты

**Files:**
- Create: `packages/core/src/work/room-usage.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/work/room-usage.test.ts`

**Interfaces:**
- Consumes: `roomMembership`, `isCurrentMember` (задача 4); `roomLead` (`rooms.ts`); `sumUsage`, `UsageSummary`, `UsageTotal`, `UsageWindow`, `KeyedUsage` (`usage-ledger.ts`)
- Produces:

```ts
export interface UsageResolver {
  whole(session: WorkSession): UsageSummary | null;
  bounds(session: WorkSession): { startedAt: string | null; endedAt: string | null } | null;
  slice(session: WorkSession, windows: readonly UsageWindow[]): Promise<UsageSummary | null>;
}
export interface RoomUsageMember {
  sessionId: string; provider: string | null; lead: boolean; periods: UsageWindow[]; current: boolean;
  status: 'counted' | 'not-started' | 'unavailable'; reason: 'log-missing' | 'deleted' | null;
  method: 'whole-session' | 'sliced' | null; usage: UsageSummary | null; sharedWith: string[];
}
export interface RoomUsage {
  roomId: string; computedAt: string; reconstructed: boolean; total: UsageTotal;
  byProvider: Array<{ provider: string; total: UsageTotal }>; members: RoomUsageMember[];
}
export function roomUsage(map: WorkMap, roomId: string, resolver: UsageResolver, now: string): Promise<RoomUsage>;
```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/work/room-usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addSession } from './map.js';
import { roomUsage, type UsageResolver } from './room-usage.js';
import { addMember, addRoom, archiveRoom } from './rooms.js';
import { HUMAN, type WorkMap, type WorkSession } from './types.js';
import type { UsageSummary, UsageWindow } from './usage-ledger.js';

const T0 = '2026-10-14T10:00:00.000Z';
const T1 = '2026-10-14T11:00:00.000Z';
const T2 = '2026-10-14T12:00:00.000Z';
const T3 = '2026-10-14T13:00:00.000Z';
const NOW = '2026-10-14T14:00:00.000Z';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

function usage(input: number, over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalInput: input,
    source: 'native-index',
    observedAt: T1,
    stale: false,
    completeness: 'complete',
    coverage: 'conversation',
    ...over,
  };
}

/** Сессия с разговором у провайдера: без него она `not started`. */
function bound(map: WorkMap, label: string, provider = 'claude', conversation = `conv-${label}`): WorkSession {
  const session = addSession(map, { provider, label, task: 'x' });
  session.providerSessionId = conversation;
  return session;
}

interface FakeResolver extends UsageResolver {
  sliced: Array<{ session: string; windows: readonly UsageWindow[] }>;
}

function resolver(
  over: { whole?: UsageResolver['whole']; bounds?: UsageResolver['bounds']; slice?: (session: WorkSession) => UsageSummary | null } = {},
): FakeResolver {
  const sliced: FakeResolver['sliced'] = [];
  return {
    sliced,
    whole: over.whole ?? (() => usage(100)),
    bounds: over.bounds ?? (() => ({ startedAt: T1, endedAt: T2 })),
    slice: async (session, windows) => {
      sliced.push({ session: session.id, windows });
      return over.slice === undefined ? usage(10) : over.slice(session);
    },
  };
}

describe('roomUsage (спека расхода токенов, 5)', () => {
  it('целиком в окне — готовый итог; с историей до комнаты — срез по окну участия', async () => {
    const map = emptyMap();
    const lead = bound(map, 'lead');
    const agent = bound(map, 'agent');
    addRoom(map, { title: 'r', creator: HUMAN, members: [lead.id, agent.id], lead: lead.id }, T0);
    const fake = resolver({
      bounds: (session) => ({ startedAt: session.id === lead.id ? '2026-10-14T09:00:00.000Z' : T1, endedAt: T2 }),
    });
    const result = await roomUsage(map, 'r-01', fake, NOW);
    expect(result.members.map((member) => [member.sessionId, member.lead, member.status, member.method, member.usage?.input])).toEqual([
      [lead.id, true, 'counted', 'sliced', 10],
      [agent.id, false, 'counted', 'whole-session', 100],
    ]);
    expect(fake.sliced).toEqual([{ session: lead.id, windows: [{ from: T0, to: null }] }]);
    expect(result.total).toMatchObject({ input: 110, completeness: 'complete', conversations: 2 });
    expect(result.byProvider).toEqual([{ provider: 'claude', total: expect.objectContaining({ input: 110 }) }]);
    expect(result).toMatchObject({ roomId: 'r-01', computedAt: NOW, reconstructed: false });
  });

  it('перетащенную в другую комнату старая считает до ухода, новая — после входа', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    addRoom(map, { title: 'r1', creator: HUMAN, members: [session.id] }, T0);
    addRoom(map, { title: 'r2', creator: HUMAN, members: [] }, T0);
    addMember(map, 'r-02', session.id, T2);
    const fake = resolver({ bounds: () => ({ startedAt: T1, endedAt: T3 }) });
    const old = await roomUsage(map, 'r-01', fake, NOW);
    expect(old.members[0]).toMatchObject({ sessionId: session.id, current: false, periods: [{ from: T0, to: T2 }], method: 'sliced', sharedWith: [] });
    const fresh = await roomUsage(map, 'r-02', fake, NOW);
    expect(fresh.members[0]).toMatchObject({ sessionId: session.id, current: true, periods: [{ from: T2, to: null }] });
  });

  it('архив режет окна: работа после архивации в итог комнаты не входит', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    addRoom(map, { title: 'r', creator: HUMAN, members: [session.id] }, T0);
    archiveRoom(map, 'r-01', T2);
    const fake = resolver({ bounds: () => ({ startedAt: T1, endedAt: T3 }) });
    const result = await roomUsage(map, 'r-01', fake, NOW);
    expect(fake.sliced).toEqual([{ session: session.id, windows: [{ from: T0, to: T2 }] }]);
    expect(result.members[0]).toMatchObject({ current: true, periods: [{ from: T0, to: T2 }] });
  });

  it('не запущенная — not started; без лога и удалённая — n/a; порядок: ведущий, текущие, вышедшие', async () => {
    const map = emptyMap();
    const idle = addSession(map, { provider: 'claude', label: 'idle', task: 'x' });
    const lost = bound(map, 'lost');
    const room = addRoom(map, { title: 'r', creator: HUMAN, members: [idle.id, lost.id] }, T0);
    room.memberLog!.push({ session: 's-09', from: T1, to: null });
    const result = await roomUsage(map, 'r-01', resolver({ whole: () => null }), NOW);
    expect(result.members.map((member) => [member.sessionId, member.status, member.reason, member.provider])).toEqual([
      [idle.id, 'not-started', null, 'claude'],
      [lost.id, 'unavailable', 'log-missing', 'claude'],
      ['s-09', 'unavailable', 'deleted', null],
    ]);
    expect(result.total).toMatchObject({ input: null, completeness: 'unknown' });
  });

  it('все участники не запускались — итог ноль, а не неизвестно', async () => {
    const map = emptyMap();
    const idle = addSession(map, { provider: 'claude', label: 'idle', task: 'x' });
    addRoom(map, { title: 'r', creator: HUMAN, members: [idle.id] }, T0);
    const result = await roomUsage(map, 'r-01', resolver(), NOW);
    expect(result.total).toMatchObject({ input: 0, output: 0, completeness: 'complete', conversations: 0 });
  });

  it('участник без лога делает неполным итог и итог своего провайдера', async () => {
    const map = emptyMap();
    const ok = bound(map, 'ok');
    const lost = bound(map, 'lost');
    addRoom(map, { title: 'r', creator: HUMAN, members: [ok.id, lost.id] }, T0);
    const result = await roomUsage(map, 'r-01', resolver({ whole: (session) => (session.id === lost.id ? null : usage(100)) }), NOW);
    expect(result.total).toMatchObject({ input: 100, completeness: 'partial' });
    expect(result.byProvider[0]?.total.completeness).toBe('partial');
  });

  it('разбивка по провайдерам; один разговор у двух записей карты — в итоге один раз', async () => {
    const map = emptyMap();
    const a = bound(map, 'a', 'claude', 'conv-1');
    const b = bound(map, 'b', 'claude', 'conv-1');
    const c = bound(map, 'c', 'codex', 'thread-1');
    addRoom(map, { title: 'r', creator: HUMAN, members: [a.id, b.id, c.id] }, T0);
    const result = await roomUsage(map, 'r-01', resolver({ whole: (session) => usage(session.provider === 'codex' ? 7 : 100) }), NOW);
    expect(result.total).toMatchObject({ input: 107, conversations: 2 });
    expect(result.byProvider.map((item) => [item.provider, item.total.input])).toEqual([
      ['claude', 100],
      ['codex', 7],
    ]);
  });

  it('старая карта, сессия в двух комнатах сразу — shared with, история восстановлена', async () => {
    const map = emptyMap();
    const session = bound(map, 'a');
    const r1 = addRoom(map, { title: 'r1', creator: HUMAN, members: [session.id] }, T0);
    const r2 = addRoom(map, { title: 'r2', creator: HUMAN, members: [session.id] }, T1);
    delete r1.memberLog;
    delete r2.memberLog;
    const result = await roomUsage(map, 'r-01', resolver(), NOW);
    expect(result.reconstructed).toBe(true);
    expect(result.members[0]?.sharedWith).toEqual(['r-02']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/work/room-usage.test.ts`
Expected: FAIL — модуля `./room-usage.js` нет.

- [ ] **Step 3: Implement**

`packages/core/src/work/room-usage.ts`:

```ts
/**
 * Итог комнаты (спека расхода токенов, 5): по каждому участнику — расход за его окна в комнате, затем сумма без двойного
 * счёта — целиком и по провайдерам. Цифры даёт `UsageResolver`: хост — индекс логов и срез, тесты — свои данные.
 */

import { isCurrentMember, roomMembership } from './room-membership.js';
import { roomLead } from './rooms.js';
import type { WorkMap, WorkSession } from './types.js';
import { sumUsage, type KeyedUsage, type UsageSummary, type UsageTotal, type UsageWindow } from './usage-ledger.js';

/** Источник цифр итога комнаты (5.2). */
export interface UsageResolver {
  /** Итог сессии целиком — тот же, что в `LiveMetrics.usage`; `null` — посчитать нечем. */
  whole(session: WorkSession): UsageSummary | null;
  /** Время первой и последней записи лога; `null` — лога нет (тогда берутся времена из карты). */
  bounds(session: WorkSession): { startedAt: string | null; endedAt: string | null } | null;
  /** Итог по логу за окна, с потомками; `null` — лога нет. */
  slice(session: WorkSession, windows: readonly UsageWindow[]): Promise<UsageSummary | null>;
}

export interface RoomUsageMember {
  sessionId: string;
  /** `null` — сессии уже нет в карте. */
  provider: string | null;
  lead: boolean;
  /** Окна участия, уже обрезанные архивом. */
  periods: UsageWindow[];
  /** Участник сейчас в комнате. */
  current: boolean;
  status: 'counted' | 'not-started' | 'unavailable';
  reason: 'log-missing' | 'deleted' | null;
  method: 'whole-session' | 'sliced' | null;
  /** Публичная часть итога (P36): без `binding`, `epoch`, нативных id и путей. */
  usage: UsageSummary | null;
  /** Старые карты: другие комнаты, где сессия числилась в то же время (5.5). */
  sharedWith: string[];
}

export interface RoomUsage {
  roomId: string;
  computedAt: string;
  /** Комната без журнала участия: история восстановлена (4.3). */
  reconstructed: boolean;
  total: UsageTotal;
  byProvider: Array<{ provider: string; total: UsageTotal }>;
  members: RoomUsageMember[];
}

const ms = (iso: string): number => Date.parse(iso);
const end = (to: string | null): number => (to === null ? Number.POSITIVE_INFINITY : ms(to));

/** Окна, обрезанные архивом: после `archivedAt` расход в комнату не идёт (5.1). */
function cutByArchive(periods: readonly UsageWindow[], archivedAt: string | null): UsageWindow[] {
  if (archivedAt === null) return [...periods];
  const limit = ms(archivedAt);
  return periods
    .filter((period) => ms(period.from) <= limit)
    .map((period) => ({ from: period.from, to: end(period.to) > limit ? archivedAt : period.to }));
}

const overlaps = (a: readonly UsageWindow[], b: readonly UsageWindow[]): boolean =>
  a.some((x) => b.some((y) => ms(x.from) < end(y.to) && ms(y.from) < end(x.to)));

/** Вся активность сессии внутри окна: начало не раньше входа, конец не позже ухода (или окно открыто). */
function wholeInside(bounds: { startedAt: string | null; endedAt: string | null }, period: UsageWindow): boolean {
  if (bounds.startedAt === null || ms(bounds.startedAt) < ms(period.from)) return false;
  if (period.to === null) return true;
  return bounds.endedAt !== null && ms(bounds.endedAt) <= ms(period.to);
}

/** Ключ разговора для `sumUsage`: семейство логов и id у провайдера (эпоха не входит). */
const conversationKey = (session: WorkSession): string =>
  `${session.provider === 'codex' ? 'codex' : 'claude'}\u0000${session.providerSessionId ?? session.id}`;

/** Итог группы: никого не посчитали и никто не пропал — ноль; кто-то пропал — итог не полнее нижней границы. */
function settle(total: UsageTotal, missing: boolean): UsageTotal {
  if (total.conversations === 0 && !missing) {
    return { ...total, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0, completeness: 'complete' };
  }
  return missing && total.completeness === 'complete' ? { ...total, completeness: 'partial' } : total;
}

export async function roomUsage(map: WorkMap, roomId: string, resolver: UsageResolver, now: string): Promise<RoomUsage> {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`room ${roomId} is not in the map`);
  const view = roomMembership(map, roomId);
  const others = map.rooms
    .filter((other) => other.id !== roomId)
    .map((other) => ({ id: other.id, members: roomMembership(map, other.id).members }));
  const lead = roomLead(room);
  const sessions = new Map(map.sessions.map((session) => [session.id, session]));

  const members: RoomUsageMember[] = [];
  for (const { session: sessionId, periods: raw } of view.members) {
    const periods = cutByArchive(raw, room.archivedAt ?? null);
    if (periods.length === 0) continue;
    const base = {
      sessionId,
      lead: sessionId === lead,
      periods,
      current: isCurrentMember(room, sessionId),
      sharedWith: others
        .filter((other) => other.members.some((member) => member.session === sessionId && overlaps(member.periods, raw)))
        .map((other) => other.id),
    };
    const session = sessions.get(sessionId);
    if (session === undefined) {
      members.push({ ...base, provider: null, status: 'unavailable', reason: 'deleted', method: null, usage: null });
      continue;
    }
    if (session.providerSessionId === null) {
      members.push({ ...base, provider: session.provider, status: 'not-started', reason: null, method: null, usage: null });
      continue;
    }
    const bounds = resolver.bounds(session) ?? { startedAt: session.startedAt, endedAt: session.endedAt };
    const whole = periods.length === 1 && wholeInside(bounds, periods[0] as UsageWindow);
    const usage = whole ? resolver.whole(session) : await resolver.slice(session, periods);
    members.push(
      usage === null
        ? { ...base, provider: session.provider, status: 'unavailable', reason: 'log-missing', method: null, usage: null }
        : { ...base, provider: session.provider, status: 'counted', reason: null, method: whole ? 'whole-session' : 'sliced', usage },
    );
  }

  // Порядок строк (3.2): ведущий, текущие участники по составу, вышедшие — по времени ухода.
  const order = [room.creator, ...room.members];
  const rank = (member: RoomUsageMember): number => (member.lead ? 0 : member.current ? 1 : 2);
  const lastExit = (member: RoomUsageMember): number => end(member.periods[member.periods.length - 1]?.to ?? null);
  members.sort(
    (a, b) =>
      rank(a) - rank(b) || (rank(a) === 1 ? order.indexOf(a.sessionId) - order.indexOf(b.sessionId) : lastExit(a) - lastExit(b)),
  );

  const totalOf = (group: readonly RoomUsageMember[]): UsageTotal => {
    const keyed: KeyedUsage[] = group.flatMap((member) => {
      const session = sessions.get(member.sessionId);
      return member.status === 'counted' && member.usage !== null && session !== undefined
        ? [{ key: conversationKey(session), usage: member.usage }]
        : [];
    });
    return settle(sumUsage(keyed), group.some((member) => member.status === 'unavailable'));
  };
  const providers = [...new Set(members.flatMap((member) => (member.provider === null ? [] : [member.provider])))];
  return {
    roomId,
    computedAt: now,
    reconstructed: view.reconstructed,
    total: totalOf(members),
    byProvider: providers.map((provider) => ({ provider, total: totalOf(members.filter((member) => member.provider === provider)) })),
    members,
  };
}
```

`packages/core/src/index.ts`:

```ts
export { roomUsage } from './work/room-usage.js';
export type { RoomUsage, RoomUsageMember, UsageResolver } from './work/room-usage.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/work/room-usage.test.ts src/work/room-membership.test.ts`
Expected: PASS.

Run: `pnpm --filter @parley/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/room-usage.ts packages/core/src/work/room-usage.test.ts packages/core/src/index.ts
git commit -m "feat(core): итог токенов комнаты — участники, провайдеры, сумма без двойного счёта"
```

---

### Task 6: Хост — срез по логу и источник цифр

**Files:**
- Modify: `packages/host/src/activity/log-index.ts` (`usageIn`, общий обход потомков Codex, кэш)
- Modify: `packages/host/src/activity/activity-service.ts` (`selectedUsage`, `wholeSessionUsage`, `usageResolver`)
- Test: `packages/host/src/activity/log-index.test.ts`
- Test: `packages/host/src/activity/activity-service.test.ts`

**Interfaces:**
- Consumes: `indexSessionFile(…, { usageWindows })`, `indexCodexSession(file, signal, { usageWindows })` (задача 3); `UsageResolver`, `UsageWindow` (задачи 2, 5)
- Produces:
  - `LogIndex.usageIn(session: WorkSession, windows: readonly UsageWindow[]): Promise<UsageSummary | undefined>`
  - `ActivityService.usageResolver(): UsageResolver`
  - `wholeSessionUsage(selected: UsageSummary, hasLog: boolean, provider: string): UsageSummary | null` (экспорт `activity-service.ts`)

- [ ] **Step 1: Write the failing tests**

Сначала собрать ядро: `pnpm --filter @parley/core build`.

В `packages/host/src/activity/log-index.test.ts` в конец верхнего `describe` (рядом с `describe('usage: потомки (P36c)')`):

```ts
  describe('usageIn: срез по окнам (спека расхода токенов, 5.3)', () => {
    const windows = [{ from: '2026-10-14T10:00:00.000Z', to: null }];
    const answer = (id: string, msg: string, at: string, input: number): string =>
      `${JSON.stringify({ type: 'assistant', sessionId: id, timestamp: at, message: { role: 'assistant', id: msg, usage: { input_tokens: input, output_tokens: 1 } } })}\n`;

    async function writeRollout(id: string, points: Array<[string, number]>, meta: Record<string, unknown> = {}): Promise<void> {
      const dir = path.join(codexRoot, '2026', '10', '14');
      await mkdir(dir, { recursive: true });
      const lines = [
        { type: 'session_meta', timestamp: points[0]![0], payload: { id, cwd: '/codex', source: 'cli', ...meta } },
        ...points.map(([at, input]) => ({
          type: 'event_msg',
          timestamp: at,
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } },
        })),
      ];
      await writeFile(path.join(dir, `rollout-2026-10-14T09-00-00-${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'));
    }

    it('Claude: только ответы внутри окна, подагенты — тем же окном; лога нет — undefined', async () => {
      const id = 's-slice';
      await writeClaudeSession(id, answer(id, 'm1', '2026-10-14T09:00:00.000Z', 100) + answer(id, 'm2', '2026-10-14T11:00:00.000Z', 10));
      await mkdir(path.join(claudeRoot, '-proj', id, 'subagents'), { recursive: true });
      await writeFile(path.join(claudeRoot, '-proj', id, 'subagents', 'agent-a1.jsonl'), answer(id, 'a1', '2026-10-14T11:30:00.000Z', 5));
      const idx = index();
      await idx.start();

      expect(await idx.usageIn(session({ providerSessionId: id }), windows)).toMatchObject({ input: 15 });
      expect(await idx.usageIn(session({ providerSessionId: 'нет-такого' }), windows)).toBeUndefined();
    });

    it('Codex: накопитель родителя и порождённого треда режутся окном', async () => {
      await writeRollout('p-thread', [['2026-10-14T09:00:00.000Z', 100], ['2026-10-14T11:00:00.000Z', 160]]);
      await writeRollout('c-thread', [['2026-10-14T09:30:00.000Z', 10], ['2026-10-14T11:30:00.000Z', 40]], { parent_thread_id: 'p-thread' });
      const idx = index();
      await idx.start();

      expect(await idx.usageIn(session({ provider: 'codex', providerSessionId: 'p-thread' }), windows)).toMatchObject({
        input: 90,
        cacheWrite: null,
        coverage: 'conversation-and-descendants',
      });
    });

    it('повторный срез без новых записей берётся из кэша, дописанный лог — пересчитывается', async () => {
      const id = 's-cache';
      const file = await writeClaudeSession(id, answer(id, 'm1', '2026-10-14T11:00:00.000Z', 10));
      const idx = index();
      await idx.start();
      const ref = session({ providerSessionId: id });

      const first = await idx.usageIn(ref, windows);
      expect(await idx.usageIn(ref, windows)).toBe(first);
      await appendFile(file, answer(id, 'm2', '2026-10-14T11:10:00.000Z', 5));
      expect(await idx.usageIn(ref, windows)).toMatchObject({ input: 15 });
    });
  });
```

В конец `packages/host/src/activity/activity-service.test.ts` (добавить `wholeSessionUsage` в импорт из `./activity-service.js`, `UsageSummary` — `import type` из `@parley/core`):

```ts
describe('wholeSessionUsage (спека расхода токенов, 5.2)', () => {
  const unavailable: UsageSummary = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    totalInput: null,
    source: 'unavailable',
    observedAt: null,
    stale: false,
    completeness: 'unknown',
    coverage: 'conversation',
  };

  it('выбранный итог отдаётся как есть', () => {
    const live = { ...unavailable, input: 5, output: 1, source: 'native-index' as const, completeness: 'complete' as const };
    expect(wholeSessionUsage(live, true, 'claude')).toBe(live);
  });

  it('лог есть, ответов модели ещё нет — ноль; у Codex запись в кэш неизвестна', () => {
    expect(wholeSessionUsage(unavailable, true, 'claude')).toMatchObject({ input: 0, output: 0, cacheWrite: 0, completeness: 'complete' });
    expect(wholeSessionUsage(unavailable, true, 'codex')).toMatchObject({ input: 0, cacheWrite: null });
  });

  it('ни лога, ни снимка — посчитать нечем', () => {
    expect(wholeSessionUsage(unavailable, false, 'claude')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/activity/log-index.test.ts src/activity/activity-service.test.ts -t "usageIn|wholeSessionUsage"`
Expected: FAIL — `usageIn` и `wholeSessionUsage` не существуют.

- [ ] **Step 3: Implement**

`packages/host/src/activity/log-index.ts`:

1. Импорты: `import { stat } from 'node:fs/promises';` и в список из `@parley/core` — `defaultRoot`, `discoverSession`, `indexCodexSession`, `indexSessionFile`, `type UsageWindow`.

2. Константа над `createLogIndex`:

```ts
/** Сколько срезов держит кэш (спека расхода токенов, 6.2). */
const SLICE_CACHE_SIZE = 64;
```

3. В интерфейс `LogIndex` после `usage(…)`:

```ts
  /**
   * Токены разговора за окна времени — срез для итога комнаты (спека расхода токенов, 5.3), с потомками: подагенты
   * Claude и порождённые треды Codex режутся теми же окнами. `undefined` — лога нет. Срез кэшируется по окнам, размеру
   * и mtime всех прочитанных файлов: повтор без новых записей файлов не читает.
   */
  usageIn(session: WorkSession, windows: readonly UsageWindow[]): Promise<UsageSummary | undefined>;
```

4. `descendantsOf` заменить общим обходом и его применением:

```ts
  /** Порождённые треды Codex под корнем (дети, внуки…); цикл в данных их не зациклит. */
  const descendantIndexes = (root: SessionIndex): SessionIndex[] => {
    const seen = new Set([logKey('codex', root.id)]);
    const found: SessionIndex[] = [];
    const queue = [root];
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const child of byParent.get(logKey('codex', parent.id)) ?? []) {
        const key = logKey('codex', child.id);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(child);
        found.push(child);
      }
    }
    return found;
  };

  /** Потомок с итогом. Форк унаследовал чужую историю: что в его итоге своё, не доказать. */
  const descendantOf = (child: SessionIndex, usage: UsageSummary): DescendantUsage => ({
    key: usageKey('codex', child.id, child.startedAt),
    usage,
    ...(child.forkedFrom === undefined ? {} : { overlapUnresolved: true }),
  });

  const descendantsOf = (root: SessionIndex): DescendantUsage[] =>
    descendantIndexes(root).flatMap((child) => (child.usage === undefined ? [] : [descendantOf(child, child.usage)]));

  const slices = new Map<string, UsageSummary>();
  const remember = (key: string, value: UsageSummary): UsageSummary => {
    slices.delete(key);
    slices.set(key, value);
    if (slices.size > SLICE_CACHE_SIZE) slices.delete(slices.keys().next().value as string);
    return value;
  };
  /** Подпись прочитанных файлов: размер и mtime каждого; пропавший файл — своя метка. */
  const signature = async (files: readonly string[]): Promise<string> =>
    (
      await Promise.all(
        files.map(async (file) => {
          try {
            const info = await stat(file);
            return `${file}:${info.size}:${info.mtimeMs}`;
          } catch {
            return `${file}:-`;
          }
        }),
      )
    ).join('\u0000');
```

5. В возвращаемый объект после `usage(session) { … }`:

```ts
    async usageIn(session, windows) {
      const found = indexOf(session);
      if (found === undefined) return undefined;
      const options = { usageWindows: windows };
      if (found.provider === 'codex') {
        const children = descendantIndexes(found);
        const key = `codex\u0000${JSON.stringify(windows)}\u0000${await signature([found.file, ...children.map((child) => child.file)])}`;
        const cached = slices.get(key);
        if (cached !== undefined) return remember(key, cached);
        const own = (await indexCodexSession(found.file, undefined, options)).usage;
        if (own === undefined) return undefined;
        const descendants: DescendantUsage[] = [];
        for (const child of children) {
          const usage = (await indexCodexSession(child.file, undefined, options)).usage;
          if (usage !== undefined) descendants.push(descendantOf(child, usage));
        }
        return remember(key, withDescendants(own, descendants));
      }
      const root = roots.claudeRoot ?? defaultRoot();
      const { subagents } = await discoverSession(found.file, root);
      const key = `claude\u0000${JSON.stringify(windows)}\u0000${await signature([found.file, ...subagents.map((agent) => agent.file)])}`;
      const cached = slices.get(key);
      if (cached !== undefined) return remember(key, cached);
      const usage = (await indexSessionFile(found.file, root, { subagents, ...options })).usage;
      return usage === undefined ? undefined : remember(key, usage);
    },
```

`packages/host/src/activity/activity-service.ts`:

1. В импорт из `@parley/core` — `type UsageResolver`.

2. Экспортируемая функция над `createActivityService`:

```ts
/**
 * Итог сессии целиком для комнаты (спека расхода токенов, 5.2): выбранный `selectUsage`. Лог уже есть, а ответов модели
 * в нём ещё нет — ноль, а не «нет данных» (запись в кэш у Codex не наблюдается — она неизвестна). Ни лога, ни снимка — `null`.
 */
export function wholeSessionUsage(selected: UsageSummary, hasLog: boolean, provider: string): UsageSummary | null {
  if (selected.source !== 'unavailable') return selected;
  if (!hasLog) return null;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: provider === 'codex' ? null : 0,
    totalInput: 0,
    source: 'native-index',
    observedAt: null,
    stale: false,
    completeness: 'complete',
    coverage: 'conversation',
  };
}
```

3. Внутри `createActivityService` вынести выбор цифр из `metricsFor` в функцию (комментарий про выбор источника переезжает вместе с кодом):

```ts
  /**
   * Токены сессии: у идущей побеждает свежий индекс лога, а снимок из карты (его ставят `report` и усыпление) годится для
   * остановленной и как запасной, когда свежего индекса нет. Какой источник выбран, видно в `usage.source`; сумма не
   * выдумывается (`selectUsage`). Снимок чужого разговора (сессию перепривязали) за свой не принимается.
   */
  function selectedUsage(session: WorkSession): UsageSummary {
    const snapshot = session.metrics;
    const frozen =
      snapshot === null
        ? null
        : snapshot.usage === undefined
          ? legacyUsage(snapshot.tokens)
          : snapshot.usage.binding === session.providerSessionId
            ? snapshot.usage
            : null;
    return selectUsage({
      active: session.lifecycle === 'active',
      epoch: session.startedAtProcess,
      live: logIndex.usage(session) ?? null,
      frozen,
    });
  }
```

а в `metricsFor` вместо прежнего блока:

```ts
    // Модель в карте не хранится никогда (work-rows.ts, sidebar.tsx).
    const snapshot = session.metrics;
    const selected = selectedUsage(session);
```

(дальше `metricsFor` без изменений: `usage = { ...selected, attribution }`, `durationMs` по `snapshot` и `indexed`).

4. В интерфейс `ActivityService` после `onLogChange`:

```ts
  /** Источник цифр итога комнаты (спека расхода токенов, 5.2): итог сессии целиком, границы её лога и срез по окнам. */
  usageResolver(): UsageResolver;
```

и в возвращаемый объект:

```ts
    usageResolver() {
      return {
        whole: (session) => wholeSessionUsage(selectedUsage(session), logIndex.index(session) !== undefined, session.provider),
        bounds: (session) => {
          const found = logIndex.index(session);
          return found === undefined ? null : { startedAt: found.startedAt, endedAt: found.endedAt };
        },
        slice: async (session, windows) => (await logIndex.usageIn(session, windows)) ?? null,
      };
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/activity`
Expected: PASS — новые тесты и все прежние (`usage: потомки (P36c)` проверяет перенос обхода потомков).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/activity/log-index.ts packages/host/src/activity/log-index.test.ts packages/host/src/activity/activity-service.ts packages/host/src/activity/activity-service.test.ts
git commit -m "feat(host): срез токенов по логу за окна и источник цифр итога комнаты"
```

---

### Task 7: Метод `rooms.usage`

**Files:**
- Modify: `packages/protocol/src/methods.ts` (схема и тип ответа)
- Create: `packages/host/src/rooms/room-usage.ts`
- Modify: `packages/host/src/methods/index.ts` (регистрация)
- Test: `packages/protocol/src/methods.test.ts`
- Test: `packages/host/src/rooms/room-usage.test.ts`
- Test: `packages/host/src/server.test.ts`

**Interfaces:**
- Consumes: `roomUsage`, `RoomUsage`, `UsageResolver` (задача 5); `ActivityService.usageResolver()` (задача 6)
- Produces:
  - метод `rooms.usage { projectPath, workId, roomId } → RoomUsage`
  - `createRoomsUsage(works: { entry(projectPath: string, workId: string): Pick<WorkEntry, 'map'> | undefined }, activity: { usageResolver(): UsageResolver }, now?: () => string): Handler<'rooms.usage'>`

- [ ] **Step 1: Write the failing tests**

`packages/protocol/src/methods.test.ts` — внутрь `describe('комнаты: ведущий и решение (дизайн комнат, 3.2)')`, где есть `const room`:

```ts
  it('rooms.usage: комната обязательна', () => {
    expect(METHODS['rooms.usage'].safeParse(room).success).toBe(true);
    expect(METHODS['rooms.usage'].safeParse({ projectPath: '/p', workId: 'w-0001' }).success).toBe(false);
  });
```

`packages/host/src/server.test.ts` — рядом с `expect(methods).toContain('rooms.reopen');`:

```ts
    // Расход токенов комнаты: без метода окно значок не показывает (useHostSupports).
    expect(methods).toContain('rooms.usage');
```

Новый `packages/host/src/rooms/room-usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addRoom, addSession, HUMAN, type UsageResolver, type UsageSummary, type WorkMap } from '@parley/core';
import { createRoomsUsage } from './room-usage.js';

const T0 = '2026-10-14T10:00:00.000Z';
const NOW = '2026-10-14T12:00:00.000Z';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'расход', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
  sessions: [],
  messages: [],
  rooms: [],
});

const usage = (input: number): UsageSummary => ({
  input,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalInput: input,
  source: 'native-index',
  observedAt: NOW,
  stale: false,
  completeness: 'complete',
  coverage: 'conversation',
});

function roomWithLead(): WorkMap {
  const map = emptyMap();
  const session = addSession(map, { provider: 'claude', label: 'lead', task: 'x' });
  session.providerSessionId = 'conv-secret-1';
  addRoom(map, { title: 'r', creator: HUMAN, members: [session.id] }, T0);
  return map;
}

const request = {} as never;

describe('rooms.usage (спека расхода токенов, 6.1)', () => {
  it('итог комнаты по карте работы и источнику цифр, без нативных id', async () => {
    const map = roomWithLead();
    const resolver: UsageResolver = {
      whole: () => usage(42),
      bounds: () => ({ startedAt: '2026-10-14T10:05:00.000Z', endedAt: null }),
      slice: async () => null,
    };
    const handler = createRoomsUsage({ entry: () => ({ projectPath: '/p', map }) }, { usageResolver: () => resolver }, () => NOW);
    const result = await handler({ projectPath: '/p', workId: 'w-0001', roomId: 'r-01' }, request);
    expect(result).toMatchObject({ roomId: 'r-01', computedAt: NOW, total: { input: 42 } });
    expect(JSON.stringify(result)).not.toContain('conv-secret-1');
  });

  it('нет работы или комнаты — not_found', async () => {
    const map = roomWithLead();
    const resolver: UsageResolver = { whole: () => null, bounds: () => null, slice: async () => null };
    const missingWork = createRoomsUsage({ entry: () => undefined }, { usageResolver: () => resolver });
    await expect(missingWork({ projectPath: '/p', workId: 'w-0009', roomId: 'r-01' }, request)).rejects.toMatchObject({ code: 'not_found' });
    const handler = createRoomsUsage({ entry: () => ({ projectPath: '/p', map }) }, { usageResolver: () => resolver });
    await expect(handler({ projectPath: '/p', workId: 'w-0001', roomId: 'r-09' }, request)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('одновременные запросы одной комнаты — один расчёт', async () => {
    const map = roomWithLead();
    let slices = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver: UsageResolver = {
      whole: () => null,
      // Начало лога раньше комнаты — путь среза.
      bounds: () => ({ startedAt: '2026-10-14T09:00:00.000Z', endedAt: null }),
      slice: async () => {
        slices += 1;
        await gate;
        return usage(7);
      },
    };
    const handler = createRoomsUsage({ entry: () => ({ projectPath: '/p', map }) }, { usageResolver: () => resolver }, () => NOW);
    const params = { projectPath: '/p', workId: 'w-0001', roomId: 'r-01' };
    const both = Promise.all([handler(params, request), handler(params, request)]);
    release();
    const [a, b] = await both;
    expect(slices).toBe(1);
    expect(a).toBe(b);
    await handler(params, request);
    expect(slices).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/protocol exec vitest run src/methods.test.ts -t "rooms.usage"`
Expected: FAIL — `METHODS['rooms.usage']` нет.

Run: `pnpm --filter @parley/host exec vitest run src/rooms/room-usage.test.ts`
Expected: FAIL — модуля `./room-usage.js` нет.

- [ ] **Step 3: Implement**

`packages/protocol/src/methods.ts`:

1. В `import type { … } from '@parley/core'` добавить `RoomUsage`.
2. В карту схем после `'rooms.reopen'`:

```ts
  // Расход токенов комнаты (спека расхода токенов, 6.1): итог с момента входа каждого участника. Только чтение. Старый
  // хост метода не знает — окно по списку методов значок не показывает.
  'rooms.usage': z.object({ projectPath: z.string(), workId: z.string(), roomId: z.string() }),
```

3. В `Results` после `'rooms.reopen': { ok: true };`:

```ts
  /** Итог токенов комнаты: целиком, по провайдерам и по участникам. Токены, а не деньги и не доля лимита. */
  'rooms.usage': RoomUsage;
```

Новый `packages/host/src/rooms/room-usage.ts`:

```ts
/**
 * `rooms.usage` (спека расхода токенов, 6.1–6.2): итог комнаты по карте работы и логам провайдеров. Расчёт — `roomUsage`
 * ядра, цифры — `ActivityService.usageResolver` (готовый итог сессии или срез лога). Одновременные запросы одной комнаты
 * склеиваются в один расчёт.
 */

import { roomUsage, type RoomUsage, type UsageResolver, type WorkEntry } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

export function createRoomsUsage(
  works: { entry(projectPath: string, workId: string): Pick<WorkEntry, 'map'> | undefined },
  activity: { usageResolver(): UsageResolver },
  now: () => string = () => new Date().toISOString(),
): Handler<'rooms.usage'> {
  const running = new Map<string, Promise<RoomUsage>>();
  return async ({ projectPath, workId, roomId }) => {
    const map = works.entry(projectPath, workId)?.map;
    if (map === undefined) throw new HostError('not_found', `work ${workId} is not open`);
    if (!map.rooms.some((room) => room.id === roomId)) throw new HostError('not_found', `room ${roomId} is not in the work`);
    const key = `${projectPath}\u0000${workId}\u0000${roomId}`;
    const known = running.get(key);
    if (known !== undefined) return known;
    const job = roomUsage(map, roomId, activity.usageResolver(), now()).finally(() => running.delete(key));
    running.set(key, job);
    return job;
  };
}
```

`packages/host/src/methods/index.ts`: импорт `import { createRoomsUsage } from '../rooms/room-usage.js';` и после `'rooms.reopen': roomsReopen as AnyHandler,`:

```ts
    'rooms.usage': createRoomsUsage(deps.works, deps.activity) as AnyHandler,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/protocol test && pnpm --filter @parley/protocol build`
Expected: PASS.

Run: `pnpm --filter @parley/host exec vitest run src/rooms/room-usage.test.ts src/server.test.ts`
Expected: PASS.

Run: `pnpm --filter @parley/host test`
Expected: PASS. Если падает тест, не связанный с правкой (флейки хоста под нагрузкой), — перезапустить один раз и сравнить с прогоном на `origin/master`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/methods.ts packages/protocol/src/methods.test.ts packages/host/src/rooms/room-usage.ts packages/host/src/rooms/room-usage.test.ts packages/host/src/methods/index.ts packages/host/src/server.test.ts
git commit -m "feat(host): метод rooms.usage — итог токенов комнаты"
```

---

### Task 8: Формат и тексты окна

**Files:**
- Modify: `packages/desktop/src/shared/strings.ts` (раздел `usage`)
- Create: `packages/desktop/src/renderer/lib/usage-format.ts`
- Test: `packages/desktop/src/renderer/lib/usage-format.test.ts`

**Interfaces:**
- Consumes: `RoomUsage`, `RoomUsageMember`, `UsageSummary`, `UsageCounters` (типы ядра); `formatTokens` (`metrics-line.ts`); `sessionRowLabel` (`lib/participant.ts`)
- Produces:
  - `knownTokens(value: number | null): string`
  - `usageChipText(value: { input: number | null; output: number | null; completeness: string }): string`
  - `usageCells(counters: UsageCounters | null): string[]` — 4 значения
  - `usageMarks(usage: UsageSummary): string[]`
  - `memberMarks(member: RoomUsageMember): string[]`
  - `interface UsageLabels { member(member: RoomUsageMember): string; provider(id: string): string }`
  - `createUsageLabels(sessions: ReadonlyArray<{ id: string; label: string }>, providers: ReadonlyArray<{ id: string; label: string }>): UsageLabels`
  - `usageStamp(iso: string): string`, `usageMarkdown(usage: RoomUsage, title: string, labels: UsageLabels): string`

- [ ] **Step 1: Write the failing tests**

`packages/desktop/src/renderer/lib/usage-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RoomUsage, RoomUsageMember, UsageSummary, UsageTotal } from '@parley/core';
import { createUsageLabels, memberMarks, usageChipText, usageMarkdown, usageMarks } from './usage-format.js';

const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  input: 500_000,
  output: 30_000,
  cacheRead: 5_200_000,
  cacheWrite: 180_000,
  totalInput: 5_880_000,
  source: 'native-index',
  observedAt: '2026-10-14T11:00:00.000Z',
  stale: false,
  completeness: 'complete',
  coverage: 'conversation',
  ...over,
});

const total = (over: Partial<UsageTotal> = {}): UsageTotal => ({
  input: 1_200_000,
  output: 84_000,
  cacheRead: 9_100_000,
  cacheWrite: null,
  totalInput: null,
  completeness: 'complete',
  stale: false,
  coverage: 'conversation',
  conversations: 2,
  ...over,
});

const member = (over: Partial<RoomUsageMember> = {}): RoomUsageMember => ({
  sessionId: 's-01',
  provider: 'claude',
  lead: false,
  periods: [{ from: '2026-10-14T10:00:00.000Z', to: null }],
  current: true,
  status: 'counted',
  reason: null,
  method: 'whole-session',
  usage: summary(),
  sharedWith: [],
  ...over,
});

const labels = createUsageLabels(
  [
    { id: 's-01', label: 'Planner' },
    { id: 's-04', label: 'Tests | e2e' },
  ],
  [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
  ],
);

describe('usage-format (спека расхода токенов, 3)', () => {
  it('значок: числа, неизвестное — ?, нижняя граница — с ≥', () => {
    expect(usageChipText({ input: 1_200_000, output: 84_000, completeness: 'complete' })).toBe('↑1.2M ↓84k');
    expect(usageChipText({ input: null, output: 0, completeness: 'complete' })).toBe('↑? ↓0');
    expect(usageChipText({ input: 10, output: 2, completeness: 'partial' })).toBe('≥ ↑10 ↓2');
  });

  it('пометки итога сессии: n/a, snapshot, stale, partial', () => {
    expect(usageMarks(summary())).toEqual([]);
    expect(usageMarks(summary({ source: 'unavailable' }))).toEqual(['n/a']);
    expect(usageMarks(summary({ source: 'frozen-snapshot', stale: true, completeness: 'partial' }))).toEqual(['snapshot', 'stale', 'partial']);
  });

  it('пометки строки участника', () => {
    expect(memberMarks(member({ status: 'not-started', usage: null }))).toEqual(['not started']);
    expect(memberMarks(member({ status: 'unavailable', reason: 'log-missing', usage: null }))).toEqual(['n/a — log not found']);
    expect(memberMarks(member({ status: 'unavailable', reason: 'deleted', usage: null, provider: null }))).toEqual(['n/a — session deleted']);
    const left = memberMarks(member({ current: false, periods: [{ from: '2026-10-14T10:00:00.000Z', to: '2026-10-14T11:40:00.000Z' }] }));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^left \d/);
    expect(memberMarks(member({ sharedWith: ['r-02'] }))).toEqual(['shared with r-02']);
  });

  it('подписи: номер и название сессии, ведущий, провайдер; удалённая — только номер', () => {
    expect(labels.member(member({ lead: true }))).toBe('S01 Planner · lead · Claude');
    expect(labels.member(member({ sessionId: 's-09', provider: null }))).toBe('S09');
    expect(labels.provider('glm')).toBe('glm');
  });

  it('Markdown: заголовок, время, итог с пометкой, провайдеры при двух и больше, участники, примечания; | экранируется', () => {
    const usage: RoomUsage = {
      roomId: 'r-03',
      computedAt: '2026-10-14T12:03:00.000Z',
      reconstructed: true,
      total: total({ completeness: 'partial' }),
      byProvider: [
        { provider: 'claude', total: total({ input: 900_000 }) },
        { provider: 'codex', total: total({ input: 300_000 }) },
      ],
      members: [
        member({ lead: true }),
        member({ sessionId: 's-04', provider: 'codex', usage: summary({ completeness: 'partial', cacheWrite: null }) }),
        member({ sessionId: 's-05', status: 'unavailable', reason: 'log-missing', usage: null }),
      ],
    };
    const text = usageMarkdown(usage, 'Payment refactor', labels).split('\n');
    expect(text[0]).toBe('**Room “Payment refactor” (r-03) — token usage**');
    expect(text[1]).toMatch(/^Since each member joined · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(text).toContain('| | In | Out | Cache read | Cache write |');
    expect(text).toContain('| **Total** (partial) | 1.2M | 84k | 9.1M | ? |');
    expect(text).toContain('| Claude | 900k | 84k | 9.1M | ? |');
    expect(text).toContain('| S01 Planner · lead · Claude | 500k | 30k | 5.2M | 180k |');
    expect(text).toContain('| S04 Tests \\| e2e · Codex (partial) | 500k | 30k | 5.2M | ? |');
    expect(text).toContain('| S05 · Claude (n/a — log not found) | ? | ? | ? | ? |');
    expect(text).toContain('Tokens, not money or plan limit. Providers count tokens differently. `?` — not reported.');
    expect(text).toContain('Membership before usage tracking is partly reconstructed.');
  });

  it('Markdown: один провайдер — строк провайдеров нет', () => {
    const usage: RoomUsage = {
      roomId: 'r-01',
      computedAt: '2026-10-14T12:03:00.000Z',
      reconstructed: false,
      total: total(),
      byProvider: [{ provider: 'claude', total: total() }],
      members: [member()],
    };
    const text = usageMarkdown(usage, 'r', labels);
    expect(text).not.toContain('| Claude |');
    expect(text).not.toContain('reconstructed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/lib/usage-format.test.ts`
Expected: FAIL — модуля `./usage-format.js` нет.

- [ ] **Step 3: Implement**

`packages/desktop/src/shared/strings.ts` — в объект `S` после раздела `roomHistory`:

```ts
  usage: {
    title: 'Token usage',
    since: 'Since each member joined',
    sessionScope: 'This session, all time',
    columns: ['In', 'Out', 'Cache read', 'Cache write'],
    total: 'Total',
    lead: 'lead',
    partial: 'partial',
    snapshot: 'snapshot',
    stale: 'stale',
    notAvailable: 'n/a',
    left: (iso: string): string => `left ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    sharedWith: (rooms: readonly string[]): string => `shared with ${rooms.join(', ')}`,
    logMissing: 'n/a — log not found',
    sessionDeleted: 'n/a — session deleted',
    notStarted: 'not started',
    footnote: 'Tokens, not money or plan limit. Providers count tokens differently.',
    legend: '`?` — not reported.',
    reconstructed: 'Membership before usage tracking is partly reconstructed.',
    updated: (iso: string): string => `Updated ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    markdownTitle: (title: string, roomId: string): string => `Room “${title}” (${roomId}) — token usage`,
    copy: 'Copy',
    copied: 'Copied',
    unavailable: 'Usage unavailable',
    counting: 'Counting…',
  },
```

`packages/desktop/src/renderer/lib/usage-format.ts`:

```ts
/**
 * Расход токенов в окне (спека расхода токенов, 3): текст значка, пометки строк, подписи и Markdown для Copy. Это токены,
 * а не деньги и не доля лимита подписки; неизвестное — `?`, а не `0`.
 */

import type { RoomUsage, RoomUsageMember, UsageCounters, UsageSummary } from '@parley/core';
import { S } from '../../shared/strings.js';
import { formatTokens } from './metrics-line.js';
import { sessionRowLabel } from './participant.js';

const U = S.usage;

/** Счётчик строкой: неизвестный — `?`. */
export const knownTokens = (value: number | null): string => (value === null ? '?' : formatTokens(value));

/** Значок: `↑1.2M ↓84k`; нижняя граница — с `≥` впереди. */
export function usageChipText(value: { input: number | null; output: number | null; completeness: string }): string {
  const text = `↑${knownTokens(value.input)} ↓${knownTokens(value.output)}`;
  return value.completeness === 'partial' ? `≥ ${text}` : text;
}

/** Четыре колонки: In, Out, Cache read, Cache write. Строки без цифр — `?`. */
export const usageCells = (counters: UsageCounters | null): string[] =>
  counters === null ? ['?', '?', '?', '?'] : [counters.input, counters.output, counters.cacheRead, counters.cacheWrite].map(knownTokens);

/** Пометки итога сессии — те же слова, что в строке метрик сайдбара (`formatMetricsLine`). */
export function usageMarks(usage: UsageSummary): string[] {
  const marks: string[] = [];
  if (usage.source === 'unavailable') marks.push(U.notAvailable);
  if (usage.source === 'frozen-snapshot' || usage.source === 'legacy-snapshot') marks.push(U.snapshot);
  if (usage.stale) marks.push(U.stale);
  if (usage.completeness === 'partial') marks.push(U.partial);
  return marks;
}

/** Пометки строки участника (3.2): одинаковые в поповере и в Markdown. */
export function memberMarks(member: RoomUsageMember): string[] {
  if (member.status === 'not-started') return [U.notStarted];
  if (member.status === 'unavailable') return [member.reason === 'deleted' ? U.sessionDeleted : U.logMissing];
  const marks = member.usage === null ? [] : usageMarks(member.usage);
  const last = member.periods[member.periods.length - 1];
  if (!member.current && last?.to != null) marks.push(U.left(last.to));
  if (member.sharedWith.length > 0) marks.push(U.sharedWith(member.sharedWith));
  return marks;
}

export interface UsageLabels {
  /** `S01 Planner · lead · Claude`. */
  member(member: RoomUsageMember): string;
  provider(id: string): string;
}

/** Подписи строк по сессиям карты и списку провайдеров (`providers.list`); незнакомый провайдер — его id. */
export function createUsageLabels(
  sessions: ReadonlyArray<{ id: string; label: string }>,
  providers: ReadonlyArray<{ id: string; label: string }>,
): UsageLabels {
  const provider = (id: string): string => providers.find((item) => item.id === id)?.label ?? id;
  return {
    provider,
    member: (member) => {
      const label = sessions.find((session) => session.id === member.sessionId)?.label ?? '';
      return [
        sessionRowLabel(member.sessionId, label),
        ...(member.lead ? [U.lead] : []),
        ...(member.provider === null ? [] : [provider(member.provider)]),
      ].join(' · ');
    },
  };
}

const two = (value: number): string => String(value).padStart(2, '0');

/** Местное время отчёта: `2026-10-14 12:03`. */
export function usageStamp(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Ячейка таблицы Markdown: `|` и перевод строки ломали бы строку таблицы. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const withMarks = (label: string, marks: readonly string[]): string => (marks.length === 0 ? label : `${label} (${marks.join(', ')})`);

/** Таблица для Copy (3.3): итог, провайдеры (если их больше одного), участники, примечания. */
export function usageMarkdown(usage: RoomUsage, title: string, labels: UsageLabels): string {
  const row = (label: string, counters: UsageCounters | null): string => `| ${label} | ${usageCells(counters).join(' | ')} |`;
  const totalMarks = (completeness: string): string[] => (completeness === 'partial' ? [U.partial] : []);
  const lines = [
    `**${U.markdownTitle(title, usage.roomId)}**`,
    `${U.since} · ${usageStamp(usage.computedAt)}`,
    '',
    `| | ${U.columns.join(' | ')} |`,
    '|---|---:|---:|---:|---:|',
    row(withMarks(`**${U.total}**`, totalMarks(usage.total.completeness)), usage.total),
  ];
  if (usage.byProvider.length > 1) {
    for (const item of usage.byProvider) {
      lines.push(row(withMarks(cell(labels.provider(item.provider)), totalMarks(item.total.completeness)), item.total));
    }
  }
  for (const member of usage.members) lines.push(row(withMarks(cell(labels.member(member)), memberMarks(member)), member.usage));
  lines.push('', `${U.footnote} ${U.legend}`);
  if (usage.reconstructed) lines.push(U.reconstructed);
  return lines.join('\n');
}
```

Примечание к тесту Markdown: строка Claude в тесте собрана из `total({ input: 900_000 })` — остальные поля по умолчанию (`84k`, `9.1M`, `?`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/lib/usage-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/lib/usage-format.ts packages/desktop/src/renderer/lib/usage-format.test.ts
git commit -m "feat(desktop): формат расхода токенов — значок, пометки, Markdown"
```

---

### Task 9: Значок и поповер комнаты

**Files:**
- Create: `packages/desktop/src/renderer/components/rooms/RoomUsageChip.tsx`
- Modify: `packages/desktop/src/renderer/components/rooms/RoomHeader.tsx` (слот `usageChip`)
- Modify: `packages/desktop/src/renderer/components/rooms/RoomPanel.tsx:434`
- Test: `packages/desktop/src/renderer/components/rooms/RoomUsageChip.test.tsx`

**Interfaces:**
- Consumes: `rooms.usage` (задача 7); всё из `usage-format.ts` (задача 8); `useHostSupports`, `useHostStore`, `useActivityStore`, `activityFor`
- Produces:
  - `RoomUsageChip(props: { bridge: ParleyBridge; entry: WorkEntry; roomId: string; active: boolean; providers: ReadonlyArray<{ id: string; label: string }> }): JSX.Element | null`
  - `ROOM_USAGE_MIN_INTERVAL_MS = 10_000`
  - `RoomHeaderProps.usageChip?: ReactNode`

- [ ] **Step 1: Write the failing tests**

`packages/desktop/src/renderer/components/rooms/RoomUsageChip.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomUsage, UsageTotal } from '@parley/core';
import { useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { ROOM_USAGE_MIN_INTERVAL_MS, RoomUsageChip } from './RoomUsageChip.js';

const T0 = '2026-10-14T10:00:00.000Z';
const total = (input: number, over: Partial<UsageTotal> = {}): UsageTotal => ({
  input,
  output: 84_000,
  cacheRead: 9_100_000,
  cacheWrite: null,
  totalInput: null,
  completeness: 'complete',
  stale: false,
  coverage: 'conversation',
  conversations: 1,
  ...over,
});
const USAGE: RoomUsage = {
  roomId: 'r-01',
  computedAt: '2026-10-14T12:03:00.000Z',
  reconstructed: false,
  total: total(1_200_000),
  byProvider: [{ provider: 'claude', total: total(1_200_000) }],
  members: [
    {
      sessionId: 's-01',
      provider: 'claude',
      lead: true,
      periods: [{ from: T0, to: null }],
      current: true,
      status: 'counted',
      reason: null,
      method: 'sliced',
      usage: { ...total(1_200_000), source: 'native-index', observedAt: T0, completeness: 'partial' },
      sharedWith: [],
    },
    {
      sessionId: 's-02',
      provider: 'claude',
      lead: false,
      periods: [{ from: T0, to: null }],
      current: true,
      status: 'not-started',
      reason: null,
      method: null,
      usage: null,
      sharedWith: [],
    },
  ],
};

const entry = makeWork('w-01', {
  projectPath: '/p',
  sessions: [makeSession('s-01', 'Planner'), makeSession('s-02', 'Backend')],
  rooms: [
    {
      id: 'r-01',
      title: 'Payments',
      creator: 'human',
      members: ['s-01', 's-02'],
      createdAt: T0,
      lead: 's-01',
      proposal: null,
      memberLog: [
        { session: 's-01', from: T0, to: null },
        { session: 's-02', from: T0, to: null },
      ],
    },
  ],
});
const PROVIDERS = [{ id: 'claude', label: 'Claude' }];
let bridge: FakeBridge;
const show = (active = true) => <RoomUsageChip bridge={bridge} entry={entry} roomId="r-01" active={active} providers={PROVIDERS} />;
const usageCalls = () => bridge.calls.filter((call) => call.method === 'rooms.usage');
const metrics = (tokensIn: number) => ({ tokensIn, tokensOut: 1, durationMs: null, unread: 0, subagents: 0, model: null });

beforeEach(() => {
  bridge = createFakeBridge();
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: ['rooms.usage'] }, connections: 1 });
  useActivityStore.setState({ byRef: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RoomUsageChip (спека расхода токенов, 3.1–3.3)', () => {
  it('хост без rooms.usage — значка нет, хост не спрашивается', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [] }, connections: 1 });
    render(show());
    expect(screen.queryByTestId('room-usage-chip')).toBeNull();
    expect(usageCalls()).toHaveLength(0);
  });

  it('активная вкладка спрашивает сразу; значок — итог, поповер — участники и пометки', async () => {
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show());
    const chip = await screen.findByText('↑1.2M ↓84k');
    expect(usageCalls()).toEqual([{ method: 'rooms.usage', params: { projectPath: '/p', workId: 'w-01', roomId: 'r-01' } }]);
    fireEvent.click(chip);
    const popover = await screen.findByTestId('room-usage-popover');
    expect(popover.textContent).toContain('S01 Planner · lead · Claude');
    expect(popover.textContent).toContain('partial');
    expect(popover.textContent).toContain('not started');
    expect(popover.textContent).toContain('Tokens, not money or plan limit.');
  });

  it('неактивная вкладка хост не спрашивает', () => {
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show(false));
    expect(usageCalls()).toHaveLength(0);
  });

  it('ошибка хоста — «—» и Usage unavailable', async () => {
    bridge.setHandler('rooms.usage', () => {
      throw new Error('boom');
    });
    render(show());
    const chip = await screen.findByText('—');
    expect(chip.closest('button')?.getAttribute('title')).toBe('Usage unavailable');
  });

  it('новые цифры участников — повтор не чаще раза в 10 секунд', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(usageCalls()).toHaveLength(1);
    const ref = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'working', { metrics: metrics(10) })]) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOM_USAGE_MIN_INTERVAL_MS - 1000);
    });
    expect(usageCalls()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(usageCalls()).toHaveLength(2);
  });

  it('Copy кладёт в буфер таблицу Markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show());
    fireEvent.click(await screen.findByText('↑1.2M ↓84k'));
    fireEvent.click(await screen.findByTestId('room-usage-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('**Room “Payments” (r-01) — token usage**');
  });
});
```


- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms/RoomUsageChip.test.tsx`
Expected: FAIL — модуля `./RoomUsageChip.js` нет.

- [ ] **Step 3: Implement**

`packages/desktop/src/renderer/components/rooms/RoomUsageChip.tsx`:

```tsx
/**
 * Значок расхода токенов в шапке комнаты (спека расхода токенов, 3.1–3.3): `↑1.2M ↓84k`, по клику — поповер с итогом,
 * провайдерами, участниками и Copy. Хост спрашивается только при `active` (6.3): при открытии, при смене состава или
 * архива и при изменении живых цифр участников, но не чаще раза в 10 секунд. Старый хост метода не знает — значка нет.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RoomUsage, UsageCounters, WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import {
  createUsageLabels,
  memberMarks,
  usageCells,
  usageChipText,
  usageMarkdown,
  type UsageLabels,
} from '../../lib/usage-format.js';
import { activityFor, useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';

const U = S.usage;

/** Не чаще раза в 10 секунд (6.3). */
export const ROOM_USAGE_MIN_INTERVAL_MS = 10_000;

/** Колонки одной ширины в итоге и в списке участников: две сетки не разъезжаются. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_repeat(4,4.5rem)] items-baseline gap-x-3 gap-y-1';

export interface RoomUsageChipProps {
  bridge: ParleyBridge;
  entry: WorkEntry;
  roomId: string;
  /** Вкладка комнаты активна (`RoomBody.active`): неактивная хост не спрашивает. */
  active: boolean;
  providers: ReadonlyArray<{ id: string; label: string }>;
}

export function RoomUsageChip({ bridge, entry, roomId, active, providers }: RoomUsageChipProps): JSX.Element | null {
  const supported = useHostSupports('rooms.usage');
  const connected = useHostStore((state) => state.status.state === 'connected');
  const projectPath = entry.projectPath;
  const workId = entry.map.work.id;
  const room = entry.map.rooms.find((candidate) => candidate.id === roomId);
  // Состав, журнал и архив: смена любого — повод спросить заново.
  const composition =
    room === undefined ? '' : JSON.stringify([room.creator, room.members, room.archivedAt ?? null, room.memberLog?.length ?? 0]);
  const sessionIds = useMemo(
    () => (room === undefined ? [] : [...new Set([room.creator, ...room.members, ...(room.memberLog ?? []).map((record) => record.session)])]),
    // `composition` — снимок ровно тех полей, из которых собран список.
    [composition],
  );
  // Строка из живых цифр участников: изменилась — расход мог вырасти.
  const signal = useActivityStore((state) =>
    sessionIds
      .map((sessionId) => {
        const metrics = activityFor(state.byRef, { projectPath, workId, sessionId })?.metrics;
        return `${metrics?.tokensIn ?? ''}/${metrics?.tokensOut ?? ''}`;
      })
      .join('|'),
  );
  const [usage, setUsage] = useState<RoomUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const lastRequest = useRef(0);
  const identity = `${projectPath}\u0000${workId}\u0000${roomId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  // Другая комната — прежние цифры не её.
  useEffect(() => {
    setUsage(null);
    setFailed(false);
    lastRequest.current = 0;
  }, [identity]);

  useEffect(() => {
    if (!active || !supported || !connected) return;
    const wait = Math.max(0, lastRequest.current + ROOM_USAGE_MIN_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      lastRequest.current = Date.now();
      const asked = identity;
      bridge.call('rooms.usage', { projectPath, workId, roomId }).then(
        (value) => {
          if (currentIdentity.current !== asked) return;
          setUsage(value);
          setFailed(false);
        },
        () => {
          if (currentIdentity.current === asked) setFailed(true);
        },
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [active, supported, connected, identity, composition, signal, bridge, projectPath, workId, roomId]);

  if (!supported || room === undefined) return null;
  const labels = createUsageLabels(entry.map.sessions, providers);
  const broken = failed && usage === null;
  const copy = (): void => {
    if (usage === null) return;
    navigator.clipboard.writeText(usageMarkdown(usage, room.title, labels)).then(
      () => toast(U.copied),
      (error: unknown) => console.warn('[parley] clipboard', error),
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="room-usage-chip"
          title={broken ? U.unavailable : U.title}
          className="shrink-0 font-mono tabular-nums"
        >
          {broken ? '—' : usage === null ? '…' : usageChipText(usage.total)}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-testid="room-usage-popover"
        className="max-h-[calc(var(--radix-popover-content-available-height)-8px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto p-3 text-xs"
      >
        {usage === null ? (
          <p className="text-muted-foreground">{failed ? U.unavailable : U.counting}</p>
        ) : (
          <UsageTable usage={usage} labels={labels} onCopy={copy} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function UsageTable({ usage, labels, onCopy }: { usage: RoomUsage; labels: UsageLabels; onCopy: () => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {U.title} · {U.since}
        </span>
        <Button type="button" size="xs" variant="outline" data-testid="room-usage-copy" onClick={onCopy} className="shrink-0">
          {U.copy}
        </Button>
      </div>
      <div className={GRID}>
        <span />
        {U.columns.map((column) => (
          <span key={column} className="truncate text-right text-muted-foreground">
            {column}
          </span>
        ))}
        <UsageRow label={U.total} marks={usage.total.completeness === 'partial' ? [U.partial] : []} counters={usage.total} strong />
        {usage.byProvider.length > 1
          ? usage.byProvider.map((item) => (
              <UsageRow
                key={item.provider}
                label={labels.provider(item.provider)}
                marks={item.total.completeness === 'partial' ? [U.partial] : []}
                counters={item.total}
                indent
              />
            ))
          : null}
      </div>
      <div data-testid="room-usage-members" className={`${GRID} max-h-[min(40vh,240px)] overflow-y-auto border-t border-border pt-2`}>
        {usage.members.map((member) => (
          <UsageRow key={member.sessionId} label={labels.member(member)} marks={memberMarks(member)} counters={member.usage} />
        ))}
      </div>
      <p className="text-muted-foreground">{U.footnote}</p>
      {usage.reconstructed ? <p className="text-muted-foreground">{U.reconstructed}</p> : null}
      <p className="text-muted-foreground">{U.updated(usage.computedAt)}</p>
    </div>
  );
}

function UsageRow({
  label,
  marks,
  counters,
  strong = false,
  indent = false,
}: {
  label: string;
  marks: readonly string[];
  counters: UsageCounters | null;
  strong?: boolean;
  indent?: boolean;
}): JSX.Element {
  // У строки без цифр (не запущена, нет лога) — прочерки: `?` значил бы «число есть, но неизвестно».
  const cells = counters === null ? ['—', '—', '—', '—'] : usageCells(counters);
  return (
    <>
      <span
        data-usage-label=""
        title={[label, ...marks].join(' · ')}
        className={`min-w-0 truncate${strong ? ' font-medium' : ''}${indent ? ' pl-3' : ''}`}
      >
        {label}
        {marks.length > 0 ? <span className="text-muted-foreground"> · {marks.join(' · ')}</span> : null}
      </span>
      {cells.map((value, index) => (
        <span key={index} data-usage-value="" className="text-right font-mono tabular-nums">
          {value}
        </span>
      ))}
    </>
  );
}
```

`RoomHeader.tsx`: в `RoomHeaderProps` после `historyMenu?`:

```ts
  /** Значок расхода токенов комнаты (`RoomUsageChip`) рядом с режимом. */
  usageChip?: ReactNode;
```

в деструктуризацию добавить `usageChip`, а строку с режимом заменить:

```tsx
      {recipeChip === undefined && usageChip === undefined ? modeControl : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">{modeControl}{recipeChip}{usageChip}</div>
      )}
```

`RoomPanel.tsx:434` — в `<RoomHeader …>` добавить проп (импорт `RoomUsageChip` из `./RoomUsageChip.js`):

```tsx
usageChip={<RoomUsageChip bridge={bridge} entry={entry} roomId={roomId} active={active} providers={providers} />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms`
Expected: PASS — новые тесты и прежние `RoomPanel*`, `RoomHistoryMenu`, `ParticipantStrip`.

Run: `pnpm --filter @parley/desktop typecheck`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/components/rooms/RoomUsageChip.tsx packages/desktop/src/renderer/components/rooms/RoomUsageChip.test.tsx packages/desktop/src/renderer/components/rooms/RoomHeader.tsx packages/desktop/src/renderer/components/rooms/RoomPanel.tsx
git commit -m "feat(desktop): значок и поповер расхода токенов в шапке комнаты"
```

---

### Task 10: Значок расхода в Chat

**Files:**
- Create: `packages/desktop/src/renderer/chat/SessionUsageChip.tsx`
- Modify: `packages/desktop/src/renderer/chat/ChatToolbar.tsx` (проп `metrics`)
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx:395` (передать `metrics`)
- Test: `packages/desktop/src/renderer/chat/SessionUsageChip.test.tsx`
- Test: `packages/desktop/src/renderer/chat/ChatToolbar.test.tsx`

**Interfaces:**
- Consumes: `usageChipText`, `usageCells`, `usageMarks`, `knownTokens` (задача 8); `LiveMetrics` (`@parley/protocol`)
- Produces:
  - `SessionUsageChip(props: { metrics: LiveMetrics }): JSX.Element`
  - `ChatToolbarProps.metrics?: LiveMetrics | null`

- [ ] **Step 1: Write the failing tests**

`packages/desktop/src/renderer/chat/SessionUsageChip.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveMetrics } from '@parley/protocol';
import { SessionUsageChip } from './SessionUsageChip.js';

afterEach(cleanup);

const base: LiveMetrics = { tokensIn: 500_000, tokensOut: 30_000, durationMs: null, unread: 0, subagents: 0, model: null };

describe('SessionUsageChip (спека расхода токенов, 3.4)', () => {
  it('значок по usage, поповер — четыре колонки и пометки', () => {
    render(
      <SessionUsageChip
        metrics={{
          ...base,
          usage: {
            input: 500_000,
            output: 30_000,
            cacheRead: 5_200_000,
            cacheWrite: null,
            totalInput: null,
            source: 'frozen-snapshot',
            observedAt: null,
            stale: true,
            completeness: 'complete',
            coverage: 'conversation',
          },
        }}
      />,
    );
    fireEvent.click(screen.getByText('↑500k ↓30k'));
    const popover = screen.getByTestId('chat-usage-popover');
    expect(popover.textContent).toContain('This session, all time');
    expect(popover.textContent).toContain('5.2M');
    expect(popover.textContent).toContain('snapshot · stale');
  });

  it('хост без usage — цифры строки сайдбара; цифр нет вовсе — прочерк', () => {
    const { rerender } = render(<SessionUsageChip metrics={base} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('↑500k ↓30k');
    rerender(<SessionUsageChip metrics={{ ...base, tokensIn: null, tokensOut: null }} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('—');
  });
});
```

В `packages/desktop/src/renderer/chat/ChatToolbar.test.tsx` добавить:

```tsx
describe('ChatToolbar — расход токенов сессии (спека расхода токенов, 3.4)', () => {
  it('metrics — значок в тулбаре; без них — нет', () => {
    const metrics = { tokensIn: 10, tokensOut: 2, durationMs: null, unread: 0, subagents: 0, model: null };
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={metrics} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('↑10 ↓2');
    rerender(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={null} />);
    expect(screen.queryByTestId('chat-usage-chip')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/chat/SessionUsageChip.test.tsx src/renderer/chat/ChatToolbar.test.tsx`
Expected: FAIL — модуля `./SessionUsageChip.js` нет, у `ChatToolbar` нет пропа `metrics`.

- [ ] **Step 3: Implement**

`packages/desktop/src/renderer/chat/SessionUsageChip.tsx`:

```tsx
/**
 * Значок расхода токенов сессии в панели Chat (спека расхода токенов, 3.4): вся жизнь сессии — `LiveMetrics.usage`, ничего
 * нового не считается. Хост без `usage` — цифры строки сайдбара (`tokensIn`/`tokensOut`). Токены, а не деньги и не лимит.
 */

import { Fragment } from 'react';
import type { LiveMetrics } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { knownTokens, usageCells, usageChipText, usageMarks } from '../lib/usage-format.js';
import { Button } from '../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';

const U = S.usage;

export function SessionUsageChip({ metrics }: { metrics: LiveMetrics }): JSX.Element {
  const usage = metrics.usage;
  const text =
    usage !== undefined
      ? usageChipText(usage)
      : metrics.tokensIn === null && metrics.tokensOut === null
        ? '—'
        : `↑${knownTokens(metrics.tokensIn ?? 0)} ↓${knownTokens(metrics.tokensOut ?? 0)}`;
  const cells = usage !== undefined ? usageCells(usage) : [knownTokens(metrics.tokensIn), knownTokens(metrics.tokensOut), '?', '?'];
  const marks = usage === undefined ? [] : usageMarks(usage);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline" data-testid="chat-usage-chip" title={U.title} className="shrink-0 font-mono tabular-nums">
          {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="chat-usage-popover" className="w-[min(320px,calc(100vw-32px))] p-3 text-xs">
        <p className="mb-2 font-medium">
          {U.title} · {U.sessionScope}
        </p>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
          {U.columns.map((column, index) => (
            <Fragment key={column}>
              <dt className="text-muted-foreground">{column}</dt>
              <dd className="m-0 text-right font-mono tabular-nums">{cells[index]}</dd>
            </Fragment>
          ))}
        </dl>
        {marks.length > 0 ? <p className="mt-2 text-muted-foreground">{marks.join(' · ')}</p> : null}
        <p className="mt-2 text-muted-foreground">{U.footnote}</p>
      </PopoverContent>
    </Popover>
  );
}
```

`ChatToolbar.tsx`: импорт `import type { LiveMetrics } from '@parley/protocol';` и `import { SessionUsageChip } from './SessionUsageChip.js';`; в `ChatToolbarProps`:

```ts
  /** Живые цифры сессии: значок расхода токенов (спека расхода токенов, 3.4); нет или `null` — значка нет. */
  metrics?: LiveMetrics | null;
```

в деструктуризацию — `metrics = null`; сразу после `<span className="min-w-0 flex-1" />`:

```tsx
      {metrics === null ? null : <SessionUsageChip metrics={metrics} />}
```

`ChatView.tsx`: рядом с прочими чтениями `useActivityStore` (строка ~190):

```ts
  const metrics = useActivityStore((state) => activityFor(state.byRef, sessionRef)?.metrics ?? null);
```

и в `<ChatToolbar …>` (строка ~395) добавить `metrics={metrics}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/chat`
Expected: PASS.

Run: `pnpm --filter @parley/desktop typecheck`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/chat/SessionUsageChip.tsx packages/desktop/src/renderer/chat/SessionUsageChip.test.tsx packages/desktop/src/renderer/chat/ChatToolbar.tsx packages/desktop/src/renderer/chat/ChatToolbar.test.tsx packages/desktop/src/renderer/chat/ChatView.tsx
git commit -m "feat(desktop): значок расхода токенов сессии в панели Chat"
```

---

### Task 11: E2E 800×500, замер среза и живая проверка

**Files:**
- Create: `packages/desktop/e2e/room-usage.spec.ts`

**Interfaces:**
- Consumes: всё выше; `data-testid="room-usage-chip"`, `"room-usage-popover"`, `[data-usage-label]`, `[data-usage-value]`, `[data-room-header]`
- Produces: —

- [ ] **Step 1: Write the E2E test**

`packages/desktop/e2e/room-usage.spec.ts`:

```ts
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Значок и поповер расхода токенов комнаты в окне 800×500 (спека расхода токенов, 3.1–3.2, 8): длинные названия комнаты
 * и сессий, масштаб 1 и 2. Настоящий `claude` не запускается (стаб): участники не запускались, их строки `not started`,
 * итог — ноль. Проверяется раскладка; цифры — модульными тестами ядра и хоста. Снимки — в `test-results/room-usage/`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/room-usage');
const LONG_LABEL = 'backend-refactor-of-the-payments-ledger-and-invoices';
const LONG_TITLE = 'Payments ledger refactor with invoices, refunds, reconciliation and reporting';
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('расход токенов комнаты в окне 800×500', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-usage');
    project = await makeTempProject('room-usage');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  for (const dpr of [1, 2]) {
    test(`значок в шапке и поповер в границах окна (масштаб ${dpr})`, async () => {
      test.setTimeout(90_000);
      const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry, `--force-device-scale-factor=${dpr}`], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
      await expect(window.getByTestId('landing')).toBeVisible();

      const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-usage', goal: '' });
      const members: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
          projectPath: project,
          workId,
          provider: 'claude',
          label: LONG_LABEL,
          task: '',
          parent: null,
        });
        members.push(ref.sessionId);
      }
      const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
        projectPath: project,
        workId,
        title: LONG_TITLE,
        members,
        lead: members[0],
        quiet: true,
      });
      await expect(window.getByTestId('app-shell')).toBeVisible();

      const roomRow = window.locator(`[data-room-row="${roomId}"]`);
      await roomRow.locator('> div').first().click();
      await expect(window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`)).toHaveAttribute('data-active', 'true');
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
      await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(800);

      // Никто не запускался — итог ноль, а не `?`.
      const chip = window.getByTestId('room-usage-chip');
      await expect(chip).toHaveText('↑0 ↓0', { timeout: 15_000 });
      const header = window.locator('[data-room-header]');
      const chipBox = await chip.boundingBox();
      const headerBox = await header.boundingBox();
      expect(chipBox).not.toBeNull();
      expect(headerBox).not.toBeNull();
      expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 0.5);

      await chip.click();
      const popover = window.getByTestId('room-usage-popover');
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('not started');
      const box = await popover.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(800.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(500.5);

      // Длинное название сессии обрезано многоточием, а цифры и прочерки — целиком.
      const label = popover.locator('[data-usage-label]').filter({ hasText: 'S01' }).first();
      expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      for (const value of await popover.locator('[data-usage-value]').all()) {
        expect(await value.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await mkdir(shots, { recursive: true });
      await window.waitForTimeout(300);
      await window.screenshot({ path: path.join(shots, `room-usage-800x500-dpr${dpr}.png`) });
    });
  }
});
```

- [ ] **Step 2: Build and run the E2E test**

Run: `uptime` — при загрузке не меньше числа ядер отложить.
Run: `pnpm -r build && pnpm --filter @parley/desktop exec playwright test e2e/room-usage.spec.ts`
Expected: PASS (2 теста). Открыть снимки `packages/desktop/test-results/room-usage/*.png` и убедиться глазами: значок в шапке, поповер целиком в окне, названия с многоточием.

Если тест падает на раскладке — чинить стили `RoomUsageChip.tsx` / `RoomHeader.tsx`, не ослабляя проверки.

- [ ] **Step 3: Measure the slice on the largest real log**

Run:

```bash
LOG=$(find ~/.claude/projects -name '*.jsonl' -not -path '*/subagents/*' -print0 | xargs -0 ls -S | head -1); ls -lh "$LOG"
```

Run:

```bash
node --input-type=module -e "
import { indexSessionFile, defaultRoot } from './packages/core/dist/index.js';
const file = process.argv[1];
const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const started = performance.now();
const index = await indexSessionFile(file, defaultRoot(), { usageWindows: [{ from, to: null }] });
console.log(JSON.stringify({ ms: Math.round(performance.now() - started), input: index.usage?.input ?? null }));
" "$LOG"
```

Expected: `ms` не больше 1500 на самом большом логе. Записать размер файла и время в описание PR. Если больше — остановиться и сообщить человеку (спека 6.2: следующий шаг — дочитывание хвоста), дальше не идти.

- [ ] **Step 4: Full suites**

Run: `pnpm -r test && pnpm --filter @parley/desktop typecheck && pnpm lint`
Expected: PASS. Падения, которые есть и на `origin/master` без этих правок (флейки под нагрузкой), отметить в PR с указанием теста; новых падений быть не должно.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/e2e/room-usage.spec.ts
git commit -m "test(desktop): E2E значка и поповера расхода токенов в окне 800×500"
```

- [ ] **Step 6: Live check with the human**

Живую проверку проводит человек в dev-окне (`pnpm dev`), исполнитель готовит сценарий и сверяет ответы:

1. Комната с ведущим, у которого есть история до комнаты, и двумя агентами разных провайдеров (Claude и Codex или GLM), запущенными под комнату. Дать каждому сделать по ходу.
2. Значок в шапке растёт после ходов (не чаще раза в 10 секунд); у ведущего в поповере нет расхода до входа; у агентов — `whole-session` (в поповере это видно по отсутствию пометок).
3. Перетащить одного агента в другую комнату: в старой у него `left HH:MM`, его цифры после ухода в старой не растут.
4. Copy → вставить в любой редактор: таблица Markdown читается.
5. Chat агента: значок в панели совпадает со строкой метрик в подсказке сайдбара.

Итог проверки — строкой в описании PR.

---

## Вне плана

- Запись в `CHANGELOG.md` делается при подготовке релиза (раздел версии собирается по списку PR).
- Дочитывание хвоста лога вместо полного чтения при срезе — только если замер в задаче 11 покажет, что это нужно.
