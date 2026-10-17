# Дешёвые `rooms.usage` и `roles.list` — дизайн

Дата: 2026-10-17, правка того же дня по письму соседней сессии. Статус: черновик на утверждение. Продолжение `2026-10-16-host-diagnostics-and-load-design.md` (раздел «Baseline 2026-10-17»): по профилю хоста 0.15.0 два метода съедают главный поток, терминалы ни при чём.

> **Что уже сделано рядом.** Ветка `perf/host-refresh` (worktree `host-perf`, после PR #73, рецензия Opus APPROVE; PR откроется после #73) закрывает хостовую часть `roles.list` и смежное: сессия для `roles.list` берётся из снимка работ (`works.entry`, запасной путь — карта с диска), кэшируется только чтение конфигурации Codex (`codex app-server`, 30 с для проверенного ответа, непроверенный и отказ не кэшируются), одинаковые запросы каталога склеиваются на 1,5 с (`methods/role-catalog-cache.ts`), файлы ролей читаются каждый раз; в окне `role-summary.ts` склеивает запросы по (проект, работа, сессия, revision) на 3 с. Там же: одно чтение работ на изменение, кэш разобранной карты по (mtime, size, ino, ctime), `watchSessions` не чаще 2 с и `handleLogChange` пересчитывает только свою сессию. Замер: проходов чтения карт на запись 6,2 → 0,25, CPU наблюдателя 6,5 с → 0,4 с. **`rooms.usage` там не тронут** — это и есть главный недостающий кусок, часть 1 ниже. Часть 2 сужена до окна: один запрос на рабочий каталог вместо одного на сессию.

## Зачем

При открытой комнате с семью живыми агентами хост держит 60–97 % CPU и лаг цикла событий до 1,3 с; без комнаты — 4–10 % при тех же 17 PTY. Причины две, обе — повторная тяжёлая работа на каждый запрос окна:

1. **`rooms.usage`.** Чип расхода токенов в шапке комнаты переспрашивает хост при любом изменении токенов участника, не чаще раза в 10 с. Хост считает срез участника по окнам участия из его лога, кэшируя результат по (окна, размер и mtime файлов). У работающего агента лог растёт постоянно, кэш не попадает, и `usageIn` перечитывает лог целиком через readline (`indexSessionFile` / `indexCodexSession`), плюс логи подагентов и порождённых тредов. Логи участников Room 1 — 21–120 МБ, ≈370 МБ суммарно; по профилю половина занятого времени хоста — это чтение JSONL. Старая спека расхода (6.2) этот путь предвидела: «если дорого — дочитывание хвоста с сохранённым состоянием учёта».
2. **`roles.list`.** На каждый вызов хост читал карту работы с диска (`readMap`, 1,1–1,5 МБ JSON), сканировал роли Claude по каталогам и запускал процесс `codex app-server --stdio` ради его контекста (`readCodexRoleContext`, таймаут 8 с). Окно зовёт метод из каждого чипа роли: строка сайдбара, полоска участников, тулбар Chat, панель плана, панель проекта — 306 вызовов за 42 минуты, по 12 одинаковых в одну секунду при перерисовке сайдбара. Хостовая часть закрыта в `perf/host-refresh` (см. врезку); у окна остаётся лишний RPC на каждую сессию одного и того же каталога.

## Цели

1. При открытой Room 1 с семью живыми участниками `host: состояние` показывает cpuPct < 20, а `rooms.usage` после прогрева отвечает < 500 мс.
2. На перерисовку сайдбара с 12 сессиями одного рабочего каталога окно шлёт не больше одного `roles.list` на каталог (сегодня, с `perf/host-refresh`, — один на сессию). Хостовая часть (снимок работ вместо карты с диска, codex не чаще раза в 30 с) считается выполненной веткой `perf/host-refresh` и здесь не повторяется.
3. Цифры расхода не меняются: срез по окнам даёт тот же `UsageSummary`, что и полный перечит (тест эквивалентности на фикстурах).
4. Старое окно с новым хостом и новое окно со старым хостом работают как раньше: протокол не меняется.

## Не-цели

- Переписывать подсчёт токенов (`createUsageLedger`, окна, потомки) — только способ доставки наблюдений в него.
- Хранить шкалу расхода на диске между запусками хоста: только в памяти, после рестарта первый запрос читает лог целиком один раз.
- Кэшировать каталог ролей целиком на хосте или в окне дольше нескольких секунд: рецензент `perf/host-refresh` отметил кэш каталога на 30–60 с как дефект (новая роль не видна до минуты). Файлы ролей читаются каждый раз, дорогое — только чтение конфигурации Codex, и оно уже закэшировано там.
- `handleLogChange` и наблюдатели работ — сделаны в `perf/host-refresh`; вес карты работы (1,5 МБ, 741 письмо) — отдельная правка.

## Анти-цели

- Чип показывает устаревшие цифры без пометки: у поповера остаётся «Updated HH:MM», появляется кнопка обновления.
- Срез из шкалы расходится с полным перечитом хоть в одном поле (`input`, `output`, `cacheRead`, `cacheWrite`, `completeness`, `stale`, `observedAt`).
- Усечённый или подменённый лог (другой файл под тем же именем) даёт сумму старой шкалы и нового хвоста.

## Ограничения

- Хост — один поток, как и раньше; дочитывание хвоста идёт потоком кусками, без чтения файла целиком в память.
- Память шкал ограничена: не больше 256 файлов в кэше (LRU), у 120-МБ лога шкала — тысячи наблюдений, сотни килобайт.
- База — master после слияния PR #73 (уже влит) и PR ветки `perf/host-refresh`: обе части этого документа трогают `packages/host/src/activity/log-index.ts` (там — `onChange(change?: LogChange)`, `applyChange`, `LIVE_REINDEX_MIN_INTERVAL_MS`; здесь — `usageIn`) и `CHANGELOG.md`. Начинать от master без `perf/host-refresh` нельзя — конфликты.
- Текущие константы: `ROOM_USAGE_MIN_INTERVAL_MS` 10 000 → 60 000; новые `SUBAGENT_DISCOVERY_TTL_MS = 30_000`, `USAGE_TIMELINE_CACHE_SIZE = 256`, `ROLES_STORE_TTL_MS = 3_000` (как склейка в `perf/host-refresh`, не дольше: новая роль должна появляться сразу).
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

## 2. `roles.list` — только окно

### 2.1 Хост — сделано в `perf/host-refresh`, не повторять

`createRolesList(catalog, works)` берёт сессию из `works.entry(...).map` с запасным `readMap`; `createCachedCatalog` (`methods/role-catalog-cache.ts`) делит один каталог между `roles.list` и `recipes.list`, склеивает одинаковые запросы на `ROLE_CATALOG_COALESCE_MS = 1_500` и кэширует только чтение конфигурации Codex через `options.context` у `sessionRoleCatalog` на `CODEX_CONTEXT_TTL_MS = 30_000` (непроверенный ответ и отказ — не кэшируются). Мой прежний вариант (кэш всего каталога по `cwd` на 60 с) снят: он скрывал бы новую роль на минуту.

### 2.2 Окно: стор ролей по рабочему каталогу

Сейчас (`perf/host-refresh`) `role-summary.ts` склеивает запросы по ключу (проект, работа, сессия, revision) на 3 с — пачка чипов одной сессии даёт один вызов, но 12 сессий одного каталога дают 12 вызовов, и хост 12 раз сканирует файлы ролей. Новый стор `renderer/store/roles.ts` по образцу `chat/capabilities-store.ts` заменяет эту склейку: `byCwd: Record<cwd, { status: 'loading' | 'reloading' | 'ready' | 'error'; roles: RoleSummary[]; at }>`, `load(bridge, { projectPath, ref?, cwd, force? })` с `ROLES_STORE_TTL_MS = 3_000` и дедупом в полёте. Ключ стора всегда равен каталогу, который посчитает хост: окно передаёт `ref` только когда знает `session.worktree?.path` и кладёт ответ под этот путь; не знает сессии — зовёт без `ref` и кладёт под `projectPath`. `useRoleSummary(bridge, sessionRef, role, revision, cwd?)` читает роль из стора по `cwd`; смена `revision` **после монтирования** делает `load` с `force: true`, и пока идёт принудительная перезагрузка (`status: 'reloading'`) хук отдаёт `null` — старый замок не висит; обновление по TTL старые роли не прячет. `revision` везде — строка `pid:startedAtProcess:lifecycle:worktree.path` сессии (как в `SessionRow`); `PlanPanel` переходит на неё с `plan.rev`. Вызовы `RoleChip` в `SessionRow`, `ChatToolbar`, `ParticipantStrip` (через `feed-model`), `PlanPanel` передают `cwd` из сессии; `ProjectPanel` ищет сессию автора в снимке работ окна и передаёт её `cwd`, а если сессии нет — зовёт без `ref` под `projectPath`; диалог новой сессии без изменений. Кэш `rolesCache`/`loadRoles` из `perf/host-refresh` при этом удаляется — его работу берёт стор.

## 3. Тесты

- core: `usage-observations` — те же наблюдения и sidechain, что индексаторы (на фикстурах `session-index.test.ts`, `codex/index-session-slice.test.ts`, `codex.test.ts`); `usage-timeline` — дочитывание хвоста (второй вызов читает только новые байты: `TimelineReader` фиксирует `start`), последняя строка без `\n` целым объектом считается, оборванная ждёт, усечение и подмена файла (`ino`), неизменяемость результата, эквивалентность полному перечиту по окнам с подагентами Claude (включая sidechain без `messageId`), тредом Codex и спадом счётчика.
- host `log-index.test.ts`: существующий «повторный срез без новых записей берётся из кэша, дописанный лог — пересчитывается» дополняется проверкой, что дописанный лог читается с прежнего `offset`; `room-usage.test.ts` без изменений.
- host `methods/roles.test.ts` и `role-catalog-cache.test.ts` — уже в `perf/host-refresh`, здесь не трогаются.
- окно: `RoomUsageChip.test.tsx` — интервал 60 с, рост токенов сам по себе запрос не рождает, Refresh спрашивает сразу; `role-summary.test.tsx` — 12 чипов одного `cwd` → один `roles.list`, смена revision → `force` и `null` на время перезагрузки, обновление по TTL старые роли не прячет (существующие тесты склейки из `perf/host-refresh` переписываются под стор); `roles.test.ts` (стор) — TTL 3 с, дедуп, ключ по каталогу хоста.
- Приёмка на машине автора — на сборке master с PR #73, `perf/host-refresh` и этой ветки: архив Diagnostics при открытой Room 1 с семью живыми агентами: `host: состояние` cpuPct < 20, `rooms.usage` в кольце окна < 500 мс, `roles.list` ≤ 1 на каталог за перерисовку сайдбара.

## 4. Порядок

Ветка `feat/host-usage-roles-load` от master **после слияния PR ветки `perf/host-refresh`**. Сначала часть 1 (ядро → хост → чип), затем часть 2 (только окно); между частями — архив «после» на машине автора. B1 (`feat/host-scrollback-1000`, `feat/pty-batch-cap`) сливаются независимо.

## Мои выборы, не обсуждавшиеся явно

- Шкала только в памяти, LRU 256 файлов; первый запрос после рестарта хоста читает лог целиком.
- Подмена и усечение файла определяются по `ino` и `size < offset`, без контрольных сумм; последняя строка без `\n` принимается, если это целый JSON.
- Стор ролей в окне живёт 3 с (как склейка `perf/host-refresh`), ключ — каталог хоста; хук прячет данные только на время принудительной перезагрузки по смене revision.
- Хостовый кэш каталога ролей не делаем: принято решение `perf/host-refresh` (кэш только контекста Codex).
- Чип: таймер 60 с вместо реакции на токены; Refresh в поповере с порогом 5 с.
- Протокол не меняется.
