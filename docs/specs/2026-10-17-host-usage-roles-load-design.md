# Дешёвые `rooms.usage` и `roles.list` — дизайн

Дата: 2026-10-17. Статус: черновик на утверждение. Продолжение `2026-10-16-host-diagnostics-and-load-design.md` (раздел «Baseline 2026-10-17»): по профилю хоста 0.15.0 два метода съедают главный поток, терминалы ни при чём.

## Зачем

При открытой комнате с семью живыми агентами хост держит 60–97 % CPU и лаг цикла событий до 1,3 с; без комнаты — 4–10 % при тех же 17 PTY. Причины две, обе — повторная тяжёлая работа на каждый запрос окна:

1. **`rooms.usage`.** Чип расхода токенов в шапке комнаты переспрашивает хост при любом изменении токенов участника, не чаще раза в 10 с. Хост считает срез участника по окнам участия из его лога, кэшируя результат по (окна, размер и mtime файлов). У работающего агента лог растёт постоянно, кэш не попадает, и `usageIn` перечитывает лог целиком через readline (`indexSessionFile` / `indexCodexSession`), плюс логи подагентов и порождённых тредов. Логи участников Room 1 — 21–120 МБ, ≈370 МБ суммарно; по профилю половина занятого времени хоста — это чтение JSONL. Старая спека расхода (6.2) этот путь предвидела: «если дорого — дочитывание хвоста с сохранённым состоянием учёта».
2. **`roles.list`.** На каждый вызов хост читает карту работы с диска (`readMap`, 1,1–1,5 МБ JSON), сканирует роли Claude по каталогам и запускает процесс `codex app-server --stdio`, чтобы прочитать его контекст (`readCodexRoleContext`, таймаут 8 с). Окно зовёт метод из каждого чипа роли: строка сайдбара, полоска участников, тулбар Chat, панель плана, панель проекта — по одному вызову на чип, 306 вызовов за 42 минуты, по 12 одинаковых в одну секунду при перерисовке сайдбара.

## Цели

1. При открытой Room 1 с семью живыми участниками `host: состояние` показывает cpuPct < 20, а `rooms.usage` после прогрева отвечает < 500 мс.
2. `roles.list` не читает карту с диска и запускает codex не чаще раза в минуту на рабочий каталог; на перерисовку сайдбара с 12 сессиями — не больше одного RPC на рабочий каталог.
3. Цифры расхода не меняются: срез по окнам даёт тот же `UsageSummary`, что и полный перечит (тест эквивалентности на фикстурах).
4. Старое окно с новым хостом и новое окно со старым хостом работают как раньше: протокол не меняется.

## Не-цели

- Переписывать подсчёт токенов (`createUsageLedger`, окна, потомки) — только способ доставки наблюдений в него.
- Хранить шкалу расхода на диске между запусками хоста: только в памяти, после рестарта первый запрос читает лог целиком один раз.
- Следить за файлами ролей и сбрасывать кэш по событию: хватает TTL.
- `handleLogChange`, который пересчитывает активность всех сессий всех работ на любое изменение лога (`recompute` 0,5 с в профиле), и вес карты работы — отдельные правки.

## Анти-цели

- Чип показывает устаревшие цифры без пометки: у поповера остаётся «Updated HH:MM», появляется кнопка обновления.
- Срез из шкалы расходится с полным перечитом хоть в одном поле (`input`, `output`, `cacheRead`, `cacheWrite`, `completeness`, `stale`, `observedAt`).
- Усечённый или подменённый лог (другой файл под тем же именем) даёт сумму старой шкалы и нового хвоста.

## Ограничения

- Хост — один поток, как и раньше; дочитывание хвоста идёт потоком кусками, без чтения файла целиком в память.
- Память шкал ограничена: не больше 256 файлов в кэше (LRU), у 120-МБ лога шкала — тысячи наблюдений, сотни килобайт.
- Текущие константы: `ROOM_USAGE_MIN_INTERVAL_MS` 10 000 → 60 000; новые `ROLE_CATALOG_TTL_MS = 60_000`, `SUBAGENT_DISCOVERY_TTL_MS = 30_000`, `USAGE_TIMELINE_CACHE_SIZE = 256`.
- Тексты окна по-английски в `strings.ts`; комментарии, тесты, документы по-русски; без мутационных прогонов.

## 1. Шкала расхода (core + host)

### 1.1 Наблюдения

Сейчас `indexSessionFile` (Claude) и `indexCodexSession` (Codex) по ходу чтения зовут `ledger.observe(...)`: Claude — `{ kind: 'delta', id, counters, at }` для записей `role === 'assistant'` с `usage`, подагенты — тем же ledger с `child: true`, при этом из записей родителя копятся множества sidechain (`isSidechain`, `agentId`, `messageId`), а запись подагента без `messageId`, пересекающаяся с родителем, даёт `ledger.markAmbiguous()`; Codex — `{ kind: 'cumulative', stream: 'rollout', counters, at }` по `event_msg` / `token_count` (сбросов адаптер не выдаёт, спад счётчика — `partial`). Тип `UsageObservation` уже экспортирован из `usage-ledger.ts`.

Правило «запись → наблюдение» и правило проигрывания в ledger выносятся в чистые функции ядра так, чтобы полный перечит и срез по шкале шли через один и тот же код:

```ts
// core/src/work/usage-observations.ts
export interface ClaudeSidechain { agents: Set<string>; unidentified: boolean }     // копится по записям родителя, монотонно
export function claudeUsageObservation(record: SessionRecord, file: string, lineNo: number): UsageObservation | null;
export function noteClaudeSidechain(state: ClaudeSidechain, record: SessionRecord): void;
export function codexUsageObservation(raw: RawRecord): UsageObservation | null;
/** Один ledger: родитель, затем подагенты с child: true и той же проверкой неоднозначности, что сейчас в indexSessionFile. */
export function replayClaudeUsage(ledger: UsageLedger, parent: UsageTimeline, subagents: readonly UsageTimeline[]): void;
```

`indexSessionFile` после чтения файлов строит те же структуры (наблюдения родителя и подагентов, sidechain) и зовёт `replayClaudeUsage`; `indexCodexSession` собирает наблюдения и проигрывает их в свой ledger. Поведение не меняется — тесты индекса остаются зелёными, а эквивалентность среза полному перечиту обеспечивается общим кодом, не копией.

### 1.2 Шкала файла

```ts
// core/src/work/usage-timeline.ts
export interface UsageTimeline {
  file: string;
  family: 'claude' | 'codex';
  /** Байт лога, разобранных целиком. */
  offset: number;
  /** Размер и ino файла при последнем чтении: усечение (size < offset) или подмена (другой ino) → шкала строится заново. */
  size: number; ino: number;
  lineNo: number;
  observations: readonly UsageObservation[];
  /** Только у родителя Claude: состояние sidechain для проверки неоднозначности подагентов. */
  sidechain?: ClaudeSidechain;
}
export interface TimelineReader { stat(file): Promise<{ size: number; ino: number }>; open(file, start): NodeJS.ReadableStream }   // по умолчанию node:fs; в тестах подменяется
export async function extendUsageTimeline(previous: UsageTimeline | null, file: string, family: 'claude' | 'codex', reader?: TimelineReader): Promise<UsageTimeline>;
export function claudeUsageFromTimelines(parent: UsageTimeline, subagents: readonly UsageTimeline[], windows: readonly UsageWindow[]): UsageSummary;
export function codexUsageFromTimeline(timeline: UsageTimeline, windows: readonly UsageWindow[]): UsageSummary;
```

`extendUsageTimeline` возвращает **новый** объект (прежний не мутируется: массив наблюдений копируется с дописанным хвостом) — одновременные вызовы по одному файлу безопасны, побеждает последняя запись в кэш. `stat(file)`; если шкалы нет, `ino` другой или `size < offset` — читать с нуля; иначе читать `createReadStream(file, { start: offset })` кусками ≤ 1 МиБ, резать по `\n`, каждую строку `JSON.parse` → наблюдение через функции 1.1 (у Claude заодно `noteClaudeSidechain`), `offset` сдвигать на конец строки. **Хвост без перевода строки**: пробовать `JSON.parse`; целый объект — принять и сдвинуть `offset` до конца файла (так ведёт себя readline сегодня, и фикстуры без завершающего `\n` считаются одинаково); оборванный — не разбирать, он войдёт в следующий вызов. Битая строка с `\n` пропускается, как в `forEachJsonlRecord`. Файла нет — пустая шкала с `size: 0, ino: 0`.

Срез: `claudeUsageFromTimelines` — новый `createUsageLedger({ windows })` и `replayClaudeUsage` (один ledger, подагенты с `child: true`, неоднозначность по sidechain), итог `ledger.summary()`; `codexUsageFromTimeline` — ledger с окнами и наблюдения файла; потомки Codex складываются в `usageIn`, как сейчас, через `withDescendants` с `descendantOf`. Пустая шкала даёт обычную `summary()` (неизвестно или нули по окнам), не `undefined`: `undefined` из `usageIn` остаётся только когда сессии нет в индексе. Эквивалентность полному перечиту — тест на фикстурах обоих провайдеров с окнами, подагентами Claude (в том числе sidechain без `messageId`), порождённым тредом Codex и спадом счётчика Codex (`partial`).

### 1.3 `LogIndex.usageIn`

Кэш шкал `Map<file, UsageTimeline>` (LRU 256) и карта идущих дочитываний `Map<file, Promise<UsageTimeline>>` (два `usageIn` одного участника из двух комнат делят одно чтение). На запрос: главный файл и файлы потомков (у Claude — `discoverSession`, результат кэшируется по главному файлу на `SUBAGENT_DISCOVERY_TTL_MS`; у Codex — `descendantIndexes` из памяти) → для каждого `extendUsageTimeline` → `claudeUsageFromTimelines` или `codexUsageFromTimeline` + `withDescendants`. Кэш срезов `slices` остаётся как есть (попадания при неизменных файлах по-прежнему бесплатны), но промах теперь стоит чтения хвоста, а не файла. `createLogIndex(roots, options?)` получает `reader`, `timelineCacheSize`, `subagentTtlMs`, `now` для тестов.

`reindex`, `start`, наблюдатель `watchSessions` и `handleLogChange` не меняются.

### 1.4 Чип и запрос

`RoomUsageChip`: интервал `ROOM_USAGE_MIN_INTERVAL_MS = 60_000`; из зависимостей эффекта уходит `signal` (токены участников) — поводы спросить: активация, смена `composition`, таймер раз в 60 с пока `active`. В поповере — кнопка **Refresh** (`S.usage.refresh`, раздел строк чипа называется `usage`), которая спрашивает сразу (не чаще раза в 5 с). «Updated HH:MM» остаётся; E2E `room-usage.spec.ts` на 800×500 проверяет, что кнопка помещается. Старая спека расхода, раздел 6.3, считается заменённой этим пунктом.

## 2. `roles.list` (host + окно)

### 2.1 Хост

`createRolesList(deps)` получает `works: Pick<WorksService, 'entry'>` и берёт сессию из `works.entry(projectPath, workId)?.map` (снимок в памяти хоста), а не из `readMap` с диска; работы нет в снимке — прежний `not_found`. Рабочий каталог — `session.worktree?.path ?? projectPath`, как сейчас.

Кэш каталога: `Map<cwd, { at: number; value: Promise<RoleList>; partial: boolean }>`. Полный каталог живёт `ROLE_CATALOG_TTL_MS = 60_000`; каталог с `partial: true` (`sessionRoleCatalog` не бросает при сбое codex — нет бинаря, таймаут 8 с, нет контекста — а возвращает диагностику `context-unverified`) живёт `ROLE_CATALOG_PARTIAL_TTL_MS = 10_000`: следующая попытка скоро, но одновременные вызовы не плодят спавны; отклонённый промис из кэша убирается сразу. Одновременные вызовы одного `cwd` делят один промис. Спавн codex идёт не чаще раза в минуту на каталог при живом codex и не чаще раза в 10 с при его сбое. Протокол `roles.list` не меняется.

### 2.2 Окно

Новый стор `renderer/store/roles.ts` по образцу `chat/capabilities-store.ts`: `byCwd: Record<cwd, { status: 'loading' | 'reloading' | 'ready' | 'error'; roles: RoleSummary[]; partial: boolean; at }>`, `load(bridge, { projectPath, ref?, cwd, force? })` с TTL 60 с (10 с для `partial`) и дедупом в полёте. Ключ стора всегда равен каталогу, который посчитает хост: окно передаёт `ref` только когда знает `session.worktree?.path` и кладёт ответ под этот путь; не знает сессии — зовёт без `ref` и кладёт под `projectPath`. `useRoleSummary(bridge, sessionRef, role, revision, cwd?)` читает роль из стора по `cwd`; смена `revision` **после монтирования** (не на первом рендере) делает `load` с `force: true`, и пока идёт принудительная перезагрузка (`status: 'reloading'`) хук отдаёт `null` — старый замок не висит; обычное обновление по TTL старые роли не прячет. `revision` везде — строка `pid:startedAtProcess:lifecycle:worktree.path` сессии (как в `SessionRow`); `PlanPanel` переходит на неё с `plan.rev`. Вызовы `RoleChip` в `SessionRow`, `ChatToolbar`, `ParticipantStrip` (через `feed-model`), `PlanPanel` передают `cwd` из сессии; `ProjectPanel` ищет сессию автора в снимке работ окна и передаёт её `cwd`, а если сессии нет — зовёт без `ref` под `projectPath`; диалог новой сессии без изменений.

## 3. Тесты

- core: `usage-observations` — те же наблюдения и sidechain, что индексаторы (на фикстурах `session-index.test.ts`, `codex/index-session-slice.test.ts`, `codex.test.ts`); `usage-timeline` — дочитывание хвоста (второй вызов читает только новые байты: `TimelineReader` фиксирует `start`), последняя строка без `\n` целым объектом считается, оборванная ждёт, усечение и подмена файла (`ino`), неизменяемость результата, эквивалентность полному перечиту по окнам с подагентами Claude (включая sidechain без `messageId`), тредом Codex и спадом счётчика.
- host `log-index.test.ts`: существующий «повторный срез без новых записей берётся из кэша, дописанный лог — пересчитывается» дополняется проверкой, что дописанный лог читается с прежнего `offset`; `room-usage.test.ts` без изменений.
- host `methods/roles.test.ts`: карта берётся из `works.entry`, не с диска; 12 одновременных вызовов одного `cwd` — один вызов каталога; по истечении TTL — новый; `partial: true` живёт 10 с, а не 60; отклонённый промис не кэшируется.
- окно: `RoomUsageChip.test.tsx` — интервал 60 с, рост токенов сам по себе запрос не рождает, Refresh спрашивает сразу; `role-summary.test.tsx` — 12 чипов одного `cwd` → один `roles.list`, смена revision → `force` и `null` на время перезагрузки, обновление по TTL старые роли не прячет; `roles.test.ts` (стор) — TTL, короткий TTL для `partial`, дедуп, ключ по каталогу хоста.
- Приёмка на машине автора: архив Diagnostics при открытой Room 1 с семью живыми агентами: `host: состояние` cpuPct < 20, `rooms.usage` в кольце окна < 500 мс, `roles.list` ≤ 1 на каталог в минуту.

## 4. Порядок

Ветка `feat/host-usage-roles-load` от origin/master. Сначала часть 1 (ядро → хост → чип), затем часть 2 (хост → окно); между частями — архив «после» на машине автора. B1 (`feat/host-scrollback-1000`, `feat/pty-batch-cap`) сливаются независимо.

## Мои выборы, не обсуждавшиеся явно

- Шкала только в памяти, LRU 256 файлов; первый запрос после рестарта хоста читает лог целиком.
- Подмена и усечение файла определяются по `ino` и `size < offset`, без контрольных сумм; последняя строка без `\n` принимается, если это целый JSON.
- Каталог ролей с `partial: true` кэшируется на 10 с, полный — на 60 с; та же пара TTL в сторе окна.
- Хук ролей прячет данные только на время принудительной перезагрузки по смене revision.
- Чип: таймер 60 с вместо реакции на токены; Refresh в поповере с порогом 5 с.
- Кэш каталога ролей — по `cwd` на 60 с, без наблюдения за файлами ролей; тот же TTL в окне.
- `roles.list` берёт сессию из снимка работ хоста; протокол не меняется.
