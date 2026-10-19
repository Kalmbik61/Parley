# Этап B: канал Telegram — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хост Parley ведёт одного Telegram-бота для одного владельца: присылает карточки запросов агентов, решений ведущего и помощника с кнопками, уведомления needs you / finished / письма, принимает вопросы помощнику текстом и голосом, ответы на письма — всё с переключателями в Settings → Notifications и привязкой кодом, рождённым на Mac.

**Architecture:** Новый каталог `packages/host/src/telegram/` — чистые модули (состояние, формат, тексты, карточки, поводы, привязка, разбор входящих) и три «живых» (API+очередь+опрос, мост к помощнику, голос), собранные в `service.ts`; методы `telegram.*` и событие `telegram.changed` в протоколе; окно получает раздел Telegram в Notifications; main зеркалит настройки помощника в хост методом `assistant.configure` и передаёт хосту каталог Whisper. Чистые функции внимания переезжают из окна в `@parley/core/attention`, чтобы хост считал поводы теми же правилами.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`), zod (protocol), Node `fetch` (long polling, без grammY и воркеров), `ogg-opus-decoder` 1.7.5 (MIT, WASM) в хосте, `qrcode` 1.5.4 (MIT, SVG) в окне, vitest, Playwright `_electron` с фейковым Bot API на локальном HTTP.

**Spec:** `docs/specs/2026-10-19-assistant-control-telegram-design.md` — разделы 8–12, решения 6–23, приложение A (спайки 2026-10-20). Этап A (карточки помощника и напоминания) уже в ветке `feat/assistant-control` (6124dce9); этот план строится поверх него.

## Global Constraints

- Тексты, которые видит человек в Telegram и в окне, — только английские: окно — в `packages/desktop/src/shared/strings.ts`, бот — в `packages/host/src/telegram/texts.ts` (одна константа на фразу). Комментарии, тесты, документы — по-русски. В промпте помощника (`core/src/assistant/launch.ts`) кириллицы нет.
- Токен бота хранится только через `writeSecret('telegram', …)` в `~/.parley/secrets.json`; в `config.json`, `ui.json`, логах, событиях и Diagnostics токена нет — только отпечаток (16 hex sha256) и подсказка `••••abcd`. URL `api.telegram.org/bot…` в лог не пишется (только метод, HTTP-код, `description`).
- Хост пишет только в `~/.parley` (`secrets.json`, `telegram/state.json`, `telegram/audit.jsonl`, `telegram/tmp/`). Каталог `telegram/` — 0700, файлы — 0600, запись атомарная (`<file>.<uuid>.tmp` → `rename`).
- Никаких действий за человека: бот передаёт нажатие в `feed.decide` / `assistant.decide` / `rooms.resolveProposal`; фразы «да»/«yes» карточку не подтверждают (решение 17); чужим бот не отвечает ничем (9.2).
- Переключатель `telegramEnabled` гасит канал целиком (решение 21): опрос стоит, ничего не уходит и не копится, хост не удерживается; токен и привязка остаются.
- Первый `getUpdates` после включения, привязки, `takeOver` или старта хоста — `offset = -1, timeout = 0` (решение 22). На 409 опрос останавливается до `telegram.takeOver` (решение 16), без backoff.
- Статусы сессий — только `sessionDotState` / `sessionAttention` из `@parley/core` (правило «статусы из одного места»).
- Сеть: прокси берётся из окружения входа через `NODE_USE_ENV_PROXY=1` в env хоста (приложение A.2); зависимости `undici` нет. Звук — только локальный `whisper-cli` (A.1).
- Новые методы `telegram.*` и `assistant.configure` доступны окну и main, острову — нет (`ISLAND_METHODS` не расширяется). Старый хост без `telegram.status` → окно прячет раздел; старое окно без `assistant.configure` → помощник для Telegram считается выключенным.
- Процесс: исполнители пишут код и тесты, но не запускают vitest/tsc/eslint/сборки, не коммитят, не порождают субагентов; проверки, чтение дифов и коммиты — у ведущего. Пакеты core/protocol пересобирать (`pnpm --dir packages/core build`, `…/protocol build`) перед проверками host/desktop. `pnpm install` для новых зависимостей делает ведущий.

## Review Focus

1. **Повтор нажатия и гонки с островом.** Allow нажали в Telegram и на острове почти одновременно: `feed.decide` второго даёт `applied: false` — в Telegram должна прийти честная квитанция («Answered at your Mac»), а не «✅ Allowed». Тест в Task 10 (`decide` возвращает `applied:false, state:'allowed'` → правка сообщения без кнопок с этим текстом).
2. **Потеря/дублирование обновлений при перезапуске хоста.** Offset пишется после обработки; хост упал между `feed.decide` и записью — то же нажатие придёт ещё раз, обработчики должны быть идемпотентны (`applied:false` → квитанция, не ошибка). Тест в Task 5 (offset сохраняется только после `onUpdate`) и Task 10 (повторный `callback_query` на уже закрытую карточку).
3. **Чужой отправитель во всех формах.** Группа, канал, `edited_message`, личка не владельца, `callback_query` не владельца, `/start` с чужим кодом — ни ответа, ни `getFile`, ни помощника. Тесты в Task 6 (все формы → `ignored`/`foreign-callback`, у `foreign-callback` только пустой `answerCallbackQuery`).
4. **Лимиты Telegram.** Текст > 4096 знаков (длинный ответ помощника или план) режется по абзацам, кнопки только на последнем куске; 429 с `retry_after` останавливает всю очередь на срок и повторяет тот же запрос, а не теряет его; «message is not modified» при правке — успех. Тесты в Task 4 (нарезка) и Task 5 (429, повтор).
5. **Токен в ошибках.** `fetch failed` с `cause`, `BotApiError`, строки в `host.log` и `host.err` не содержат токена и URL с ним. Тесты в Task 2 (маска), Task 5 (сообщение `BotApiError` без токена даже при ошибке сети с URL в `cause`).

---

## Волны и файлы

| Волна | Задачи | Непересекающиеся файлы |
|---|---|---|
| 1 | T1 протокол · T2 core (секреты, конфиг, маска, `via`) · T3 core attention + окно derive | protocol/ · core/src/{secrets,config,work/types,telegram}.ts · core/src/work/attention.ts + desktop/renderer/attention |
| 2 | T4 state/format/texts · T5 api/outbox/poller · T11 main · T12 окно (настройки) · T13 окно (via/origin) | host/telegram/{state,format,texts}.ts · host/telegram/{api,outbox,poller}.ts · desktop/main · desktop/renderer/components/settings + strings · desktop/renderer/{rooms feed-model, island store} |
| 3 | T6 link/ingress · T7 cards/notify · T8 сервис помощника + мост · T9 голос | host/telegram/{link,ingress}.ts · host/telegram/{cards,notify}.ts · host/assistant/assistant-service.ts + host/telegram/assistant-bridge.ts · host/telegram/voice.ts |
| 4 | T10 service + методы + host.ts + context.hold + settings hook | host/telegram/service.ts · host/methods/{telegram,index,settings}.ts · host/src/{host,context}.ts |
| 5 | T14 E2E с фейковым Bot API | desktop/e2e |

Общие типы модуля — `packages/host/src/telegram/types.ts` (создаёт T4, остальные только импортируют).

---

### Task 1: Протокол — методы `telegram.*`, событие `telegram.changed`, `assistant.configure`, origin `telegram`

**Files:**
- Create: `packages/protocol/src/telegram.ts`
- Modify: `packages/protocol/src/methods.ts` (импорт у `:22-25`, спред в `METHODS` `:89`, `extends` в `Results` `:318`), `packages/protocol/src/events.ts:54`, `packages/protocol/src/assistant.ts:101, 128-154`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/telegram.test.ts`, `packages/protocol/src/methods.test.ts` (сторож схем), `packages/protocol/src/assistant.test.ts`

**Interfaces:**
- Produces (`protocol/src/telegram.ts`):
  ```ts
  export const telegramMethodSchemas = {
    'telegram.setToken': z.object({ token: z.string().min(1).max(512) }),
    'telegram.clearToken': z.object({}), 'telegram.link': z.object({}), 'telegram.unlink': z.object({}),
    'telegram.takeOver': z.object({}), 'telegram.status': z.object({}),
  } as const;
  export type TelegramPolling = 'off' | 'ok' | 'conflict' | 'error';
  export interface TelegramStatus {
    enabled: boolean; token: 'none' | 'set'; botUsername: string | null; hint: string | null;
    owner: { username: string | null; linkedAt: string } | null;
    pendingLink: { expiresAt: string } | null;
    polling: TelegramPolling; error: string | null; lastUpdateAt: string | null;
  }
  export interface TelegramMethodResults {
    'telegram.setToken': { botUsername: string; hint: string };
    'telegram.clearToken': { ok: true }; 'telegram.link': { code: string; expiresAt: string; deepLink: string };
    'telegram.unlink': { ok: true }; 'telegram.takeOver': { ok: true }; 'telegram.status': TelegramStatus;
  }
  ```
- Produces (`protocol/src/assistant.ts`): `AssistantOrigin = 'island' | 'reminder' | 'telegram'`; схема `'assistant.configure': z.object({ enabled: z.boolean(), provider: z.string().min(1).nullable(), model: z.string().min(1).nullable(), language: z.string().regex(/^[a-z]{2,3}$/), voiceModel: z.string().min(1).nullable() })` → результат `{ ok: true }`; экспортируемый тип `AssistantSettings = Params<'assistant.configure'>` (`voiceModel` — абсолютный путь к файлу модели Whisper или `null`).
- Produces (`events.ts`): `'telegram.changed': TelegramStatus`.

- [ ] **Шаг 1: тесты.** `telegram.test.ts`: `telegram.setToken` принимает `{ token: '123456:AAAA' }` и отвергает `{}`; `telegram.status` принимает `{}`; `METHODS` содержит все шесть ключей; `assistant.configure` принимает `{ enabled: true, provider: 'claude', model: null, language: 'en', voiceModel: '/m/ggml-base.bin' }` и отвергает `language: 'english'`. Проверить тип: `expectTypeOf<AssistantOrigin>().toEqualTypeOf<'island' | 'reminder' | 'telegram'>()`. `methods.test.ts` — добавить новые методы туда, где сторож перечисляет имена (если список явный).
- [ ] **Шаг 2: реализация** по Interfaces; экспорт из `index.ts` типов `TelegramStatus`, `TelegramPolling`, `AssistantSettings` и схем `telegramMethodSchemas`.
- [ ] **Шаг 3: проверки (ведущий).** `pnpm --dir packages/protocol build && cd packages/protocol && pnpm exec vitest run`.
- [ ] **Шаг 4: коммит.** `feat(protocol): telegram methods and status event, assistant.configure, origin telegram`.

---

### Task 2: Core — `SecretId 'telegram'`, ключи конфига, маска токена, `MessageVia 'telegram'`

**Files:**
- Modify: `packages/core/src/secrets.ts:8`, `packages/core/src/config.ts` (`ParleyConfig :29-77`, `DEFAULT_CONFIG :79-93`, `ENV_NAMES :99-120`, `fromFile :183-212`, `flag` union `:227` и вызовы `:246-257`, `BOOLEAN_KEYS :333-339`), `packages/core/src/work/types.ts:294`, `packages/core/src/index.ts`
- Create: `packages/core/src/telegram.ts`
- Test: `packages/core/src/telegram.test.ts`, `packages/core/src/config.test.ts` (существующий — дописать)

**Interfaces:**
- Produces: `SecretId = 'zai' | 'telegram' | \`custom:${string}\``; `ParleyConfig` получает `telegramEnabled, telegramNeedsYou, telegramFinished, telegramMail, telegramCards: boolean` с умолчаниями `true, true, false, true, true` и env-именами `TELEGRAM_ENABLED, TELEGRAM_NEEDS_YOU, TELEGRAM_FINISHED, TELEGRAM_MAIL, TELEGRAM_CARDS`; `MessageVia = 'assistant' | 'telegram'`.
- Produces (`core/src/telegram.ts`, чистый, экспорт из корня `index.ts`):
  ```ts
  export const TELEGRAM_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
  export function telegramBotId(token: string): string;              // цифры до двоеточия
  export function telegramTokenFingerprint(token: string): string;   // первые 16 hex sha256
  export function maskTelegramTokens(text: string): string;          // `bot\d{6,}:[A-Za-z0-9_-]{20,}` → `bot<redacted>`, голый `\d{6,}:[A-Za-z0-9_-]{30,}` → `<redacted>`
  ```

- [ ] **Шаг 1: тесты.** `telegram.test.ts`: `TELEGRAM_TOKEN_RE` принимает `123456:` + 35 знаков `[A-Za-z0-9_-]` и отвергает `12345:abc`; `telegramBotId('123456:xyz…') === '123456'`; отпечаток — 16 hex и стабилен; `maskTelegramTokens('GET https://api.telegram.org/bot123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/getMe')` не содержит `123456:AAAA` и содержит `bot<redacted>`; голый токен в произвольном тексте → `<redacted>`; текст без токена не меняется. `config.test.ts`: умолчания пяти ключей; `PARLEY_TELEGRAM_FINISHED=1` даёт `true` и `locked`; `parseSetting('telegramEnabled', 'false')` → `{ value: false }`, `'maybe'` → ошибка `expected 0 or 1`.
- [ ] **Шаг 2: реализация** по Interfaces (во всех пяти местах `config.ts`; `ENV_NAMES` — `Record` по всем ключам, компилятор подскажет).
- [ ] **Шаг 3: проверки (ведущий).** `pnpm --dir packages/core build && cd packages/core && pnpm exec vitest run src/telegram.test.ts src/config.test.ts src/secrets.test.ts`.
- [ ] **Шаг 4: коммит.** `feat(core): telegram secret id, config toggles, token mask, letters via telegram`.

---

### Task 3: Core attention — чистые функции внимания переезжают из окна

**Files:**
- Create: `packages/core/src/work/attention.ts`, `packages/core/src/work/attention.test.ts`
- Modify: `packages/core/package.json` (`exports["./attention"] = "./dist/work/attention.js"`), `packages/core/src/index.ts`, `packages/desktop/src/renderer/attention/derive.ts:22-125` (реэкспорт из core, обёртка для упоминаний)
- Test: окно — `derive.test.ts`, `derive.compact.test.ts` остаются зелёными без правок утверждений

**Interfaces:**
- Produces (`@parley/core/attention`, без Node-импортов и без импортов из renderer):
  ```ts
  export type Attention = 'needs-you' | 'unseen' | 'working' | 'idle' | 'off';
  export const ATTENTION_RANK: Record<Attention, 4 | 3 | 2 | 1 | 0>;
  export function sessionAttention(session: WorkSession, live: SessionActivity | null): Attention;
  export function roomAwaitsDecision(room: Room): boolean;                      // !isArchived(room) && room.proposal != null
  export function isHumanUnread(message: Message): boolean;
  export function isHumanMention(message: Message, hasMention: (text: string) => boolean): boolean;
  export function humanUnreadLetters(map: WorkMap): Message[];
  export function humanUnreadMentions(map: WorkMap, hasMention: (text: string) => boolean): Message[];
  export function plainHumanMention(text: string): boolean;                    // /(^|[^\w@])@human\b/i — для хоста без Markdown
  ```
- Consumes: `isArchived` из `core/src/work/rooms.ts` (уже есть), типы `Message, Room, WorkMap, WorkSession, SessionActivity` из core.
- Окно: `derive.ts` экспортирует те же имена с прежними сигнатурами (`isHumanMention(message)` и `humanUnreadMentions(map)` без второго аргумента — обёртки, передающие `hasHumanMention` из `room-remark`); `roomDecisionReturned`, `forYouTarget`, `roomUnreadForHuman`, `workAttention`, `attentionOf`, `sameWorkAttention` остаются в окне.

- [ ] **Шаг 1: тесты core.** Перенести в `attention.test.ts` утверждения из `derive.test.ts` для пяти функций (сессия `closed` → `off`, не `active` → `idle`, `blocked` → `needs-you`; архивная комната с `proposal` → `false`; письмо от `human` не unread; `plainHumanMention('ping @human please')` true, `'mail@humanity.org'` false, `'@human'` в начале true).
- [ ] **Шаг 2: реализация** и реэкспорт в окне. Поведение окна не меняется: его `hasHumanMention` по-прежнему разбирает Markdown.
- [ ] **Шаг 3: проверки (ведущий).** `pnpm --dir packages/core build`; `cd packages/core && pnpm exec vitest run src/work/attention.test.ts`; `cd packages/desktop && pnpm exec vitest run src/renderer/attention`; `pnpm typecheck` desktop.
- [ ] **Шаг 4: коммит.** `refactor(core): attention predicates shared by the window and the host`.

---

### Task 4: Хост — типы модуля, состояние, формат, тексты

**Files:**
- Create: `packages/host/src/telegram/types.ts`, `state.ts`, `format.ts`, `texts.ts`
- Test: `packages/host/src/telegram/state.test.ts`, `format.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface TgFrom { id: number; username?: string; first_name?: string }
  export interface TgMessage { message_id: number; date: number; chat: { id: number; type: string }; from?: TgFrom; text?: string;
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }; reply_to_message?: { message_id: number } }
  export interface TgCallbackQuery { id: string; from: TgFrom; message?: { message_id: number; chat: { id: number; type: string } }; data?: string }
  export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: unknown; callback_query?: TgCallbackQuery; [key: string]: unknown }
  export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;
  export interface TelegramOwner { userId: number; chatId: number; username: string | null; linkedAt: string }
  export interface PendingLink { codeHash: string; expiresAt: string; attempts: number }
  export type CardRecord =
    | { kind: 'feed'; ref: SessionRef; cardId: string; cardKind: 'permission' | 'question' | 'plan'; sessionName: string; chatId: number; messageId: number; at: string; question: number; wait?: { kind: 'other'; until: string } }
    | { kind: 'room'; projectPath: string; workId: string; roomId: string; roomTitle: string; from: string; proposalId: string; rev: number; planId?: string; planRev?: number; chatId: number; messageId: number; at: string; wait?: { kind: 'note'; until: string } }
    | { kind: 'assistant'; proposalId: string; chatId: number; messageId: number; at: string };
  export interface LetterRecord { projectPath: string; workId: string; roomId: string | null; from: string; at: string }
  export interface TelegramStateFile { version: 1; botId: string | null; tokenFingerprint: string | null; botUsername: string | null; owner: TelegramOwner | null;
    pendingLink: PendingLink | null; offset: number | null; seen: number[]; cards: Record<string, CardRecord>; letters: Record<string, LetterRecord> }
  export interface AuditEntry { at: string; kind: 'decision' | 'assistant' | 'reply' | 'link' | 'unlink' | 'voice'; shortId?: string; cardId?: string; text?: string; result: string }
  ```
- Produces (`state.ts`):
  ```ts
  export const SEEN_RING = 100; export const CARD_TTL_MS = 7 * 24 * 3_600_000;
  export function emptyState(): TelegramStateFile;
  export function createTelegramState(deps: { home: string; now?(): number; log(line: string): void }): TelegramStateStore;
  export interface TelegramStateStore {
    get(): TelegramStateFile;                                   // загружает при первом обращении; битый файл → пустое + строка в лог
    update(patch: Partial<TelegramStateFile>): void;            // слияние + атомарная запись
    remove(): void;                                             // state.json удалён, память — emptyState()
    applyToken(botId: string, fingerprint: string): 'same' | 'new-bot' | 'new-token';  // 9.5: new-bot → owner/offset/cards/letters/pendingLink сброшены; new-token → только offset
    seen(updateId: number): boolean;                            // true — уже был; иначе кладёт в кольцо
    newShortId(): string;                                       // 8 знаков base62 из crypto, нет среди cards
    putCard(shortId: string, card: CardRecord): void; dropCard(shortId: string): void; cardsFor(predicate: (card: CardRecord) => boolean): Array<[string, CardRecord]>;
    pruneCards(): void;                                         // старше CARD_TTL_MS
    putLetter(messageId: number, letter: LetterRecord): void; letter(messageId: number): LetterRecord | null;
    audit(entry: Omit<AuditEntry, 'at'>): void;                 // append в audit.jsonl, text обрезан до 200 знаков
  }
  ```
  Файлы: `<home>/telegram/state.json`, `<home>/telegram/audit.jsonl`; каталог `mkdir 0o700`, запись через `<file>.<uuid>.tmp` с `0o600` и `rename`.
- Produces (`format.ts`): `escapeHtml(text: string): string` (`& < >` и `"`), `clipText(text: string, max = 1500): string` (с хвостом `… (truncated, open in Parley)`), `splitText(text: string, max = 4096): string[]` (по `\n\n`, затем по `\n`, затем жёстко; пустой текст → `[]`), `lastLines(text: string, n = 2): string`.
- Produces (`texts.ts`): объект `T` с английскими строками и функциями: `linked(macName)`, `help`, `assistantOff`, `voiceOff`, `voiceTooLong`, `voiceFailed`, `tooLong`, `noLongerCurrent`, `answeredAtMac`, `expired`, `returnNotePrompt(from)`, `otherPrompt`, `unlinked`, `restarted`, `reminderOff(id, what)`, `sentTo(name)`, `heard(text)`, `needsYou(name, where)`, `finished(name, where)`, `letter(from, where)`, `waitingAtMac(name)`, `revised`, `cardTitle(name, where)`, `expiresWithTurn`, receipts `receipt(kind: 'allowed'|'denied'|'answered'|'elsewhere'|'stale'|'accepted'|'returned'|'revised'|'sent'|'done'|'cancelled'|'unlinked'|'restarted', time: string)`; кнопки `B`: `allow, allowAlways, deny, other, accept, approveEach, returnNote ('Return…'), send, create, cancel, acceptDecision ('Accept')`.

- [ ] **Шаг 1: тесты.** `state.test.ts` (tmp home): `get()` без файла → `emptyState()`; `update` пишет файл 0600 в каталоге 0700 и переживает перечитывание новым стором; `applyToken` три исхода с правильными сбросами; `seen` — второй вызов с тем же id → true, после 101 id первый забыт; `newShortId` — 8 знаков `[0-9A-Za-z]`, не повторяет существующий; `pruneCards` удаляет запись 8-дневной давности и оставляет свежую; `audit` дописывает JSON-строку с `at` и обрезанным `text`; битый JSON → пустое состояние и строка в логе. `format.test.ts`: экранирование, `clipText` ровно по лимиту, `splitText` 10 000 знаков по абзацам (ни один кусок > 4096, порядок сохранён), `lastLines`.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** `cd packages/host && pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run src/telegram`.
- [ ] **Шаг 4: коммит.** `feat(host): telegram state store, formatting and bot texts`.

---

### Task 5: Хост — Bot API, очередь отправки, опрос

**Files:**
- Create: `packages/host/src/telegram/api.ts`, `outbox.ts`, `poller.ts`
- Test: `api.test.ts`, `outbox.test.ts`, `poller.test.ts` (все с фейковым `fetch`, без сети, с фейковыми таймерами)

**Interfaces:**
- Produces (`api.ts`):
  ```ts
  export class BotApiError extends Error { constructor(readonly method: string, readonly status: number /* 0 — сеть */, readonly description: string, readonly retryAfter: number | null) }
  export interface BotApi {
    call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
    download(filePath: string, dest: string, maxBytes: number): Promise<number>;   // байт записано; больше maxBytes → BotApiError(status 0, 'file too large')
  }
  export function createBotApi(deps: { token: string; fetch?: typeof fetch; baseUrl?: string /* 'https://api.telegram.org' */ }): BotApi;
  ```
  `call`: POST JSON на `${baseUrl}/bot${token}/${method}`, таймаут по умолчанию 20 с через `AbortSignal.timeout`; ответ `{ ok: true, result }` → `result`; `{ ok: false, description, error_code, parameters?.retry_after }` → `BotApiError`; сетевая ошибка → `BotApiError(method, 0, <message без токена>, null)`. Сообщение ошибки и `stack` пропускаются через `maskTelegramTokens`.
- Produces (`outbox.ts`):
  ```ts
  export type Priority = 'card' | 'notice' | 'typing';
  export interface OutboxJob { priority: Priority; key?: string; run(): Promise<void> }
  export interface Outbox { enqueue(job: OutboxJob): void; clear(): void; size(): number; idle(): Promise<void> }
  export function createOutbox(deps: { log(line: string): void; now?(): number; setTimeout?: typeof setTimeout }): Outbox;
  ```
  Один исполнитель; порядок — `card` раньше `notice` раньше `typing`, внутри приоритета FIFO; `key` заменяет уже стоящую задачу с тем же ключом (typing, правки одного сообщения); `BotApiError` 429 → пауза `retryAfter` с (не меньше 1) и повтор того же задания первым; статус 0 → до 3 повторов через 2 с; остальные ошибки → задание снимается, одна строка в лог; `clear()` выбрасывает очередь (выключение, 409).
- Produces (`poller.ts`):
  ```ts
  export interface Poller { start(options: { skipBacklog: boolean }): void; stop(): void; running(): boolean }
  export function createPoller(deps: { api: BotApi; offset(): number | null; setOffset(next: number): void; seen(updateId: number): boolean;
    onUpdate(update: TgUpdate): Promise<void>; onStatus(polling: TelegramPolling, error: string | null): void; log(line: string); sleep?(ms: number): Promise<void> }): Poller;
  ```
  Цикл: при `skipBacklog` первый вызов `getUpdates { offset: -1, timeout: 0 }` → `setOffset(max update_id + 1)` без обработки; далее `{ offset, timeout: 25, allowed_updates: ['message','callback_query'] }` с `timeoutMs: 45_000`; каждый апдейт: `seen` → пропуск; `await onUpdate` в try (ошибка → лог), затем `setOffset(update_id + 1)`; успех → `onStatus('ok', null)`; 409 → `stop()` + `onStatus('conflict', description)`; 401 → `stop()` + `onStatus('error', 'Telegram rejected the token')`; прочие ошибки → `onStatus('error', description)` и пауза 2 с, удваивая до 30 с; `stop()` прерывает текущий `fetch` через `AbortSignal` и даёт `onStatus('off', null)`.

- [ ] **Шаг 1: тесты.** `api.test.ts`: URL запроса содержит `/bot<token>/getMe`; `ok:false` → `BotApiError` со `status`, `description`, `retryAfter`; сетевой `TypeError('fetch failed', { cause: Error('… https://api.telegram.org/bot123456:AAAA…') })` → `BotApiError.status === 0`, `message` не содержит токена; `download` пишет файл и режет по `maxBytes`. `outbox.test.ts`: порядок приоритетов; `key` заменяет; 429 → пауза и повтор первым, остальные ждут; статус 0 → три повтора, потом снятие; `clear`. `poller.test.ts`: `skipBacklog` → первый запрос `offset -1, timeout 0`, второй с `offset = last + 1`; `setOffset` зовётся после `onUpdate`, не до; повтор `update_id` не доходит до `onUpdate`; 409 → останов и `conflict`; 401 → останов и текст; сетевая ошибка → `error` и следующий запрос после паузы; `stop()` → `off`.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** как в Task 4.
- [ ] **Шаг 4: коммит.** `feat(host): telegram bot api client, outbox with rate limits, long poller`.

---

### Task 6: Хост — привязка и разбор входящих

**Files:**
- Create: `packages/host/src/telegram/link.ts`, `ingress.ts`
- Test: `link.test.ts`, `ingress.test.ts`

**Interfaces:**
- Produces (`link.ts`):
  ```ts
  export const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; export const LINK_TTL_MS = 10 * 60_000; export const LINK_ATTEMPTS = 5;
  export function createLinkCode(now: number, random?: (max: number) => number): { code: string /* 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ' */; pending: PendingLink };
  export function normalizeLinkCode(text: string): string;     // верхний регистр, без дефисов и пробелов
  export function hashLinkCode(code: string): string;          // sha256 hex нормализованного
  export function matchLinkCode(pending: PendingLink, text: string, now: number): 'match' | 'mismatch' | 'expired';   // timingSafeEqual
  export function deepLink(botUsername: string, code: string): string;   // https://t.me/<bot>?start=<code>
  ```
- Produces (`ingress.ts`, чистые функции):
  ```ts
  export type Inbound =
    | { kind: 'start'; code: string | null; from: TgFrom; chatId: number }
    | { kind: 'command'; name: 'status' | 'new' | 'help' | 'skip'; messageId: number }
    | { kind: 'text'; text: string; messageId: number; replyTo: number | null }
    | { kind: 'voice'; fileId: string; duration: number; messageId: number }
    | { kind: 'callback'; id: string; data: string; messageId: number | null }
    | { kind: 'foreign-callback'; id: string }
    | { kind: 'ignored'; reason: 'foreign' | 'group' | 'edited' | 'unsupported' | 'no-owner' };
  export function classify(update: TgUpdate, owner: TelegramOwner | null, pendingLink: PendingLink | null): Inbound;
  export type Callback = { family: 'pc1'; shortId: string; code: string } | { family: 'pa1'; proposalId: string; code: 'send' | 'cancel' };
  export function parseCallback(data: string): Callback | null;
  export const CALLBACK_CODES = { allow: 'a', allowAlways: 'A', deny: 'd', other: 'o', planAuto: 'p', planManual: 'm', accept: 'y', returnNote: 'r', option: (index: number) => `q${index}` } as const;
  export function optionIndex(code: string): number | null;   // 'q3' → 3
  ```
  Правила `classify` (9.2–9.3): `edited_message` и всё, что не `message`/`callback_query`, → `ignored: 'edited'|'unsupported'`; чат не `private` → `'group'`; `/start` (с кодом или без, `/start@bot …` тоже) из лички при живом `pendingLink` → `start` от любого отправителя; без `pendingLink` и без владельца → `'no-owner'`; владелец есть, но `chat.id !== owner.chatId || from.id !== owner.userId` → `'foreign'` для сообщений и `foreign-callback` для нажатий; команды `/status`, `/new`, `/help`, `/skip` (с `@bot` суффиксом тоже) → `command`; `voice` → `voice`; `text` → `text` с `replyTo`; `callback_query` владельца → `callback`.

- [ ] **Шаг 1: тесты.** `link.test.ts`: формат кода (6 групп по 4 из алфавита), `matchLinkCode` для совпадения с другим регистром и без дефисов, истёкший срок, несовпадение; `deepLink`. `ingress.test.ts`: таблица из 12 случаев (владелец/чужой × message/callback/edited/group, `/start CODE` при живом и мёртвом `pendingLink`, `/status@parley_bot`, voice, reply); `parseCallback('pc1:aB3dE9fG:q2')`, `('pa1:p7:send')`, мусор → `null`.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** как в Task 4.
- [ ] **Шаг 4: коммит.** `feat(host): telegram link codes and inbound classification`.

---

### Task 7: Хост — карточки и поводы

**Files:**
- Create: `packages/host/src/telegram/cards.ts`, `notify.ts`
- Test: `cards.test.ts`, `notify.test.ts`

**Interfaces:**
- Consumes: `cardGist`, `cardDetail`, `pendingCards` (`@parley/core/card-gist`), `sessionDotState` (`@parley/core/session-state`), `roomAwaitsDecision`, `humanUnreadLetters`, `humanUnreadMentions`, `plainHumanMention` (`@parley/core/attention`, Task 3), `participantLabel`, `isArchived` (core), `T`/`B` (Task 4), `CALLBACK_CODES` (Task 6), `escapeHtml`, `clipText`, `lastLines` (Task 4).
- Produces (`cards.ts`, чистые):
  ```ts
  export interface CardMeta { sessionName: string; where: string /* 'Parley · my_harnas' */; projectPath: string; shortId: string; buttons: boolean /* false у Codex без хуков */ }
  export function feedCardMessage(card: FeedCard, meta: CardMeta, question = 0): { text: string; keyboard: InlineKeyboard | null };
  export function roomCardMessage(input: { roomTitle: string; where: string; proposal: Proposal; shortId: string }): { text: string; keyboard: InlineKeyboard };
  export function assistantCardMessage(proposal: AssistantProposal): { text: string; keyboard: InlineKeyboard };   // pa1:<id>:send|cancel, подпись кнопки по action (Send/Create/Allow/Deny/Answer/Accept plan/Approve each edit/Accept/Return)
  export function receiptText(originalHtml: string, line: string): string;                // текст без кнопок + пустая строка + line
  export function feedDecisionFor(card: FeedCard, code: string, answer?: string): FeedDecision | 'other' | null;  // a/A/d, p/m, q<n> → answers { [question.question]: label }, 'o' → 'other'
  export function questionKeyboard(card: FeedQuestionCard, shortId: string, question: number): InlineKeyboard;   // кнопка на вариант (подпись ≤ 64 знаков), последняя Other…
  ```
  Текст карточки ленты (10.1): `<b>S03 Ruslan</b> · Parley · my_harnas` / `Permission: Bash` (или `Question`, `Plan`) / `<pre>…</pre>` с `cardDetail` до 1500 / `Expires with the session's turn`; у вопроса с несколькими вопросами — только вопрос с индексом `question`, заголовок `Question 2 of 3`. Кнопки: permission — Allow, Deny, Allow always (только при `suggestions.length > 0`); plan — Accept, Approve each edit; question — по варианту + Other…; `buttons: false` → без клавиатуры и строка `T.waitingAtMac(name)`.
- Produces (`notify.ts`, чистые, состояние снаружи):
  ```ts
  export interface NotifyMemory { levels: Map<string, Activity | 'closed'>; letters: Set<string> | null; decisions: Map<string, { id: string; rev: number }> }
  export function emptyMemory(): NotifyMemory;
  export function activityTransition(memory: NotifyMemory, ref: SessionRef, session: WorkSession, live: SessionActivity | null): 'needs-you' | 'unseen' | null;  // первое значение — база; только переходы в blocked/unseen по sessionDotState
  export interface WorksTriggers {
    letters: Array<{ entry: WorkEntry; message: Message }>;                     // новые письма человеку (roomId === null) и упоминания в комнатах
    decisions: Array<{ entry: WorkEntry; room: Room; change: 'new' | 'revised' }>;
    closed: Array<{ entry: WorkEntry; roomId: string; previous: { id: string; rev: number }; now: 'accepted' | 'returned' | 'revised' | 'gone' }>;
  }
  export function worksTriggers(memory: NotifyMemory, snapshot: WorksSnapshot, hasMention?: (text: string) => boolean): WorksTriggers;   // первый снимок — база без поводов
  export function sessionWhere(entry: WorkEntry): string;   // 'Parley · my_harnas' = work.title · basename(projectPath)
  ```
  `now` для закрытого решения: слота нет и последнее письмо человека — `ACCEPTED_LETTER` → `accepted`, `RETURNED_LETTER…` → `returned`, иначе `gone`; тот же id с большим `rev` → `revised` (и одновременно `decisions: 'revised'`).

- [ ] **Шаг 1: тесты.** `cards.test.ts`: permission с suggestions → 3 кнопки и `callback_data` `pc1:<shortId>:a|A|d`; без suggestions — 2; `buttons:false` → нет клавиатуры, есть строка «at your Mac»; question с 3 вариантами → 4 кнопки, подпись > 64 знаков обрезана, `feedDecisionFor(card,'q1')` → `{ kind:'question', answers: { [q]: label } }`, `'o'` → `'other'`; plan → `p`/`m` → `choice`; HTML экранирован (`rm -rf <dist>`); `assistantCardMessage` для четырёх action — подписи кнопок. `notify.test.ts`: первый вызов без поводов; переход `idle → blocked` → `needs-you`, повтор `blocked` → null, `working → unseen` → `unseen`; новое письмо человеку и `@human` в комнате появляются один раз; новый слот решения → `new`, тот же id с `rev+1` → `revised` + `closed.now === 'revised'`; слот исчез после письма `Decision accepted.` → `accepted`.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** как в Task 4.
- [ ] **Шаг 4: коммит.** `feat(host): telegram cards with inline keyboards and notification triggers`.

---

### Task 8: Хост — сервис помощника для Telegram и мост

**Files:**
- Modify: `packages/host/src/assistant/assistant-service.ts` (`AssistantService :87-98`, `AssistantServiceDeps :52-85`, `publish :222`, `ask`, `onReminder`), `packages/host/src/methods/assistant.ts` (`assistant.configure`)
- Create: `packages/host/src/telegram/assistant-bridge.ts`
- Test: `assistant-service.test.ts` (дописать), `telegram/assistant-bridge.test.ts`

**Interfaces:**
- Produces (сервис помощника):
  ```ts
  // AssistantService — добавить:
  onState(listener: (state: AssistantState) => void): () => void;      // зовётся из publish после broadcast
  configure(settings: AssistantSettings): void;                         // зеркало ui.json (8.4), в памяти
  settings(): AssistantSettings | null;                                 // null — зеркала нет (старое окно)
  ask(params: Params<'assistant.ask'>, origin?: AssistantOrigin): Promise<void>;   // по умолчанию 'island'
  // AssistantServiceDeps — добавить:
  onReminderWhileOff?(reminder: Reminder): void;                        // решение 18: канал шлёт «Reminder r3: the assistant is off — …»
  ```
  `onReminder`: если `settings()` есть и `enabled === false` → `deps.onReminderWhileOff?.(reminder)` один раз на `reminder.id` (повторяющееся — последующие тики молча) и результат `'skipped'`; если зеркало есть и `enabled` → параметры хода (`provider`, `model`, `language`) из зеркала, иначе как сейчас из `lastAsk`. `assistant.configure` метод → `service.configure(params)` → `{ ok: true }`.
- Produces (`assistant-bridge.ts`):
  ```ts
  export interface BridgeDeps {
    assistant: Pick<AssistantService, 'ask' | 'cancel' | 'reset' | 'decide' | 'onState' | 'settings' | 'state'>;
    sendText(text: string): Promise<void>;                               // через outbox 'notice', нарезка splitText
    sendCard(proposal: AssistantProposal): Promise<void>;               // 'card'; service запоминает messageId в state.cards kind 'assistant'
    closeCard(proposalId: string, receipt: 'sent' | 'done' | 'cancelled' | 'current'): Promise<void>;
    typing(): void;                                                      // sendChatAction typing, priority 'typing', key 'typing'
    cardsToggle(): boolean;                                              // telegramCards
    log(line: string): void; now?(): number; setInterval?: typeof setInterval;
  }
  export interface AssistantBridge {
    onText(text: string): Promise<void>;          // > 4000 → T.tooLong; помощник выключен → T.assistantOff; иначе ask({ text, provider, model, language, askId }, 'telegram')
    onCommand(name: 'status' | 'new'): Promise<void>;   // status → onText('What is going on?'); new → reset + подтверждение
    onCallback(proposalId: string, code: 'send' | 'cancel'): Promise<string>;   // decide → toast: '' | T.noLongerCurrent
    stop(): void;
  }
  export function createAssistantBridge(deps: BridgeDeps): AssistantBridge;
  ```
  Поведение (10.3): пока `phase ∈ {thinking, tool, answering}` и ход с `origin: 'telegram'` — `typing()` раз в 4 с; конец хода (`phase` стала `idle | awaiting-confirm | error | offline`) с `origin ∈ {telegram, reminder}` → `sendText(answer || error)`; ответ с `origin: 'island'` не уходит; новый `proposal.id` при `origin ∈ {telegram, reminder}` или `cardsToggle()` → `sendCard`; `proposal` исчез с `outcome` → `closeCard(id, outcome)`. Новый текст во время хода → `cancel()` затем `ask`.

- [ ] **Шаг 1: тесты.** Сервис: `onState` получает каждое `publish`; `configure`+`settings`; `ask(params, 'telegram')` публикует `origin: 'telegram'`; напоминание при `enabled:false` → `onReminderWhileOff` один раз для повторяющегося, `'skipped'`; напоминание с зеркалом `enabled:true` берёт `provider` из зеркала. Мост (фейковый сервис с ручным `emit(state)`): текст → `ask` с `origin 'telegram'` и typing через 4 с; конец хода telegram → `sendText` один раз; конец хода island → ничего; карточка при telegram → `sendCard`, при island и `cardsToggle:false` → нет, при `true` → да; `outcome: 'sent'` → `closeCard(id,'sent')`; `onCallback` с `applied:false` → `T.noLongerCurrent`; помощник выключен → `T.assistantOff` без `ask`; 4001 знак → `T.tooLong`.
- [ ] **Шаг 2: реализация** (минимальные правки сервиса; `onState` — `Set` слушателей).
- [ ] **Шаг 3: проверки (ведущий).** `cd packages/host && pnpm exec tsc --noEmit && pnpm exec vitest run src/assistant src/telegram`.
- [ ] **Шаг 4: коммит.** `feat(host): assistant settings mirror, state listeners and the telegram bridge`.

---

### Task 9: Хост — голосовые

**Files:**
- Modify: `packages/host/package.json` (`"ogg-opus-decoder": "1.7.5"` в `dependencies` — ставит ведущий `pnpm --filter @parley/host add ogg-opus-decoder@1.7.5`)
- Create: `packages/host/src/telegram/voice.ts`, `packages/host/src/telegram/wav.ts`
- Test: `voice.test.ts` (декодер и `spawn` подменены), `wav.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const VOICE_MAX_SECONDS = 120; export const VOICE_MAX_BYTES = 20 * 1024 * 1024; export const VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin';
  export function pcm16ToWav(pcm: Int16Array, sampleRate = 16_000): Buffer;                           // wav.ts, 44-байтный заголовок
  export function downsampleTo16k(channel: Float32Array, sampleRate: number): Int16Array;            // среднее по ratio, clamp
  export function whisperArgs(engine: { bin: string; vadModel: string }, input: { model: string; wav: string; language: string }): string[];   // как у окна: -m -f -l -nt -np -sns --vad -vm
  export interface VoiceDeps { api: Pick<BotApi, 'call' | 'download'>; tmpDir: string; whisperDir: string | null; language(): string; model(): string | null;
    decode?(bytes: Uint8Array): Promise<{ channelData: Float32Array[]; sampleRate: number }>; spawn?: typeof import('node:child_process').spawn; log(line: string) }
  export type VoiceResult = { text: string } | { error: 'off' | 'too-long' | 'failed' | 'no-speech' };
  export function createVoiceTranscriber(deps: VoiceDeps): { transcribe(fileId: string, durationSec: number): Promise<VoiceResult> };
  ```
  Порядок: `whisperDir === null || model() === null` → `'off'` без `getFile`; `durationSec > 120` → `'too-long'`; `getFile` → `download` в `<tmpDir>/<uuid>.oga` (0600, ≤ 20 МБ) → `decode` (`ogg-opus-decoder`: `new OggOpusDecoder(); await ready; await decodeFile(bytes); free()`) → моно → `downsampleTo16k` → WAV в `<tmpDir>/<uuid>.wav` → `spawn(<whisperDir>/bin/whisper-cli, whisperArgs(...))`, таймаут `60_000 + durationSec*1000`; stdout trim; пусто → `'no-speech'`; код ≠ 0 / таймаут / исключение → `'failed'` + строка в лог; оба файла удаляются в `finally`; расшифровки идут по одной (внутренняя очередь).

- [ ] **Шаг 1: тесты.** `wav.test.ts`: заголовок (RIFF/WAVE, 16 кГц, моно, 16 бит), длина данных; `downsampleTo16k` 48 кГц → втрое короче, clamp. `voice.test.ts`: `off` без вызовов API; `too-long`; успешный путь с фейковыми `decode`/`spawn` (аргументы whisper-cli содержат `-l ru`, `--vad`, путь VAD) и удалёнными файлами; `spawn` с кодом 1 → `failed`, файлы удалены.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** как в Task 4; после `pnpm install` убедиться, что `pnpm --dir packages/desktop build` кладёт `out/host/node_modules/ogg-opus-decoder` (если сборка `out/host` этого не делает — записать в журнал и поправить скрипт сборки хоста отдельной правкой).
- [ ] **Шаг 4: коммит.** `feat(host): telegram voice messages through the local whisper engine`.

---

### Task 10: Хост — сервис канала, методы, проводка

**Files:**
- Create: `packages/host/src/telegram/service.ts`, `packages/host/src/methods/telegram.ts`
- Modify: `packages/host/src/context.ts` (`hold`), `packages/host/src/host.ts` (создание после `:459`, старт после `markWorksReady`, shutdown), `packages/host/src/methods/index.ts` (`MethodDeps.telegram?`, регистрация, хук после `settings.set` по образцу `:258-263`), `packages/host/src/log.ts` (маска), `packages/host/src/methods/providers.ts` — не трогать
- Test: `telegram/service.test.ts` (фейковые fetch/works/activity/feed/assistant, tmp home), `methods/telegram.test.ts`, `context.test.ts` (hold)

**Interfaces:**
- Produces (`context.ts`): `HostContext.hold(key: string, on: boolean): void` — второй набор `holdKeys`: участвует в `onIdleChange` (`clients.size === 0 && busyKeys.size === 0 && holdKeys.size === 0`), **не** входит в `liveSessions()`.
- Produces (`log.ts`): перед записью `msg` и строковые значения `data` проходят `maskTelegramTokens`.
- Produces (`service.ts`):
  ```ts
  export interface TelegramServiceDeps {
    home: string; host: Pick<HostContext, 'broadcast' | 'hold' | 'log'>;
    works: Pick<WorksService, 'snapshot' | 'onChange'>; activity: Pick<ActivityService, 'get' | 'onChange'>;
    feed?: Pick<FeedService, 'snapshot' | 'decide' | 'subscribe' | 'unsubscribe'>;
    assistant: Pick<AssistantService, 'ask' | 'cancel' | 'reset' | 'decide' | 'onState' | 'settings' | 'state'>;
    sendLetter(input: Params<'rooms.send'>): Promise<string>;            // host.ts: sendHumanLetter(input, { via: 'telegram' })
    resolveRoomProposal(input: Params<'rooms.resolveProposal'>): Promise<string>;
    config(): Promise<ParleyConfig>;                                       // loadConfig().config
    secret: { read(): Promise<string | null>; write(token: string): Promise<string>; clear(): Promise<void> };
    fetch?: typeof fetch; apiBase?: string; whisperDir: string | null; macName: string; now?(): number; log(line: string): void;
  }
  export interface TelegramService {
    start(): Promise<void>; stop(): Promise<void>; status(): TelegramStatus;
    setToken(token: string): Promise<{ botUsername: string; hint: string }>;   // TELEGRAM_TOKEN_RE иначе HostError bad_request 'Token looks wrong'; getMe 15 с ×3 при сети; 401/404 → bad_request 'Telegram rejected the token'; успех → secret.write, applyToken, старт опроса
    clearToken(): Promise<void>; link(): Promise<{ code: string; expiresAt: string; deepLink: string }>;   // link без токена → conflict 'Set the bot token first'
    unlink(): Promise<void>; takeOver(): Promise<void>; configChanged(config: ParleyConfig): void;
  }
  export function createTelegramService(deps: TelegramServiceDeps): TelegramService;
  ```
  Поведение:
  - `start()`: читает секрет и `config`; `enabled && token` → `createBotApi`, опрос `start({ skipBacklog: true })`; `enabled && token && owner` → `host.hold('telegram', true)`; записи `cards` прошлого запуска закрываются квитанцией `T.restarted` и удаляются; подписки `works.onChange`, `activity.onChange`, `assistant.onState` (мост).
  - Любое изменение статуса → `host.broadcast('telegram.changed', status())`.
  - `configChanged`: `enabled` false → `poller.stop()`, `outbox.clear()`, `hold(false)`, `polling 'off'`; true → как `start`.
  - Входящие (`classify`): `start` с кодом при живом `pendingLink` → `matchLinkCode`: `match` → `owner`, `setMyCommands` (`status`, `new`, `help`), ответ `T.linked(macName)`, `audit link`; `mismatch` → `attempts += 1`, после 5 — `pendingLink = null`; `expired` → `pendingLink = null`; всё без ответа. `foreign-callback` → `answerCallbackQuery` пустой. `command`: `help` → `T.help`; `status`/`new` → мост; `skip` → снимает ожидание заметки (`wait: note`) и выполняет `return` без заметки. `text`: если у какой-то карточки `wait` не истёк — это ответ (`other` → `feed.decide` с `answers`, `note` → `resolveRoomProposal({ action: 'return', note })`); иначе если `replyTo` есть в `letters` → `sendLetter({ projectPath, workId, roomId, to: [from], text, kind: 'note' })` + реакция 👍 (`setMessageReaction`; ошибка метода → `T.sentTo`); иначе → мост `onText`. `voice` → транскрайбер → `T.heard(text)` → как `text`. `callback` → `answerCallbackQuery` сразу, затем по `parseCallback`: `pc1` feed → `feedDecisionFor` (`other` → ответ `T.otherPrompt`, `wait` 10 мин) → `feed.decide` → квитанция по `applied`/`state`; следующий вопрос той же карточки — новое сообщение; `pc1` room → `y` → `resolveRoomProposal accept` → квитанция `accepted`; `r` → `T.returnNotePrompt`, `wait: note`; `HostError conflict` → квитанция `revised`; `pa1` → мост `onCallback`; неизвестный `shortId` → правка сообщения в `T.noLongerCurrent` без кнопок. Каждое действие — `audit`.
  - Поводы (10.2): `activity.onChange` → `activityTransition`; `needs-you` → при `feed` и `telegramNeedsYou`: `feed.snapshot(ref, undefined, 'attention')` (повтор через 500 мс, если карточек нет) → новые `pendingCards` (нет записи с тем же `cardId`) → карточка (`buttons = decisions !== 'terminal'`), `feed.subscribe(ref, pseudoClient)`; карточек нет → `T.needsYou(name, where)` + `lastLines` последнего ответа. `unseen` → при `telegramFinished`: `T.finished` с `disable_notification: true`. `works.onChange` → `worksTriggers(memory, snapshot, plainHumanMention)`: письма/упоминания при `telegramMail` (сообщение запоминается в `letters`); решения при `telegramNeedsYou` → `roomCardMessage`; `closed` → квитанции по `now`. Уведомления (не карточки) в пределах 3 с склеиваются в одно сообщение. Псевдо-клиент ленты (`Client` с `send(message)`) получает `feed.changed` → для каждой `upsert` карточки с открытой записью и `state !== 'pending'` → квитанция по состоянию (`allowed | denied | answered | elsewhere → 'Answered at your Mac' | stale → 'Expired'`), запись удаляется, при отсутствии открытых записей у `ref` — `unsubscribe`.
  - Без владельца, при `enabled === false`, при `polling === 'conflict'` ничего не отправляется и не копится.
  - Правка в квитанцию: `editMessageText` с `reply_markup: { inline_keyboard: [] }`; `description` содержит `message is not modified` → успех; иная ошибка → `editMessageReplyMarkup` с пустой клавиатурой.
  - Отправка HTML: `parse_mode: 'HTML'`; ошибка 400 с `can't parse entities` → повтор тем же текстом без `parse_mode` и без тегов (`escapeHtml` наоборот не нужен — хранить и plain-версию).
- Produces (`methods/telegram.ts`): `createTelegramHandlers(service: TelegramService): Record<string, AnyHandler>` для шести методов; ошибки сервиса — `HostError` как есть, прочее → `HostError('internal', …)` без токена в тексте.
- `methods/index.ts`: `MethodDeps.telegram?: TelegramService`, регистрация через spread; после успешного `settings.set` → `deps.telegram?.configChanged(result.config)`; `assistant.configure` регистрируется в `createAssistantHandlers` (Task 8).
- `host.ts`: `createTelegramService({...})` после сервиса помощника (`fetch` глобальный, `apiBase: process.env.PARLEY_TELEGRAM_API`, `whisperDir: process.env.PARLEY_WHISPER_DIR ?? null`, `macName: os.hostname()`, `secret` через `readSecret/writeSecret/clearSecret('telegram')`, `config: async () => (await loadConfig()).config`, `onReminderWhileOff` помощника → сервис); `await telegram.start()` сразу после `reminders.start(...)`; `onShutdown(async () => telegram.stop())` перед остановкой помощника.

- [ ] **Шаг 1: тесты.** `service.test.ts` (фейковый `fetch` с журналом запросов и очередью ответов `getUpdates`):
  - выключен `telegramEnabled` → ни одного запроса, `hold` не вызван; включение через `configChanged` → `getUpdates` с `offset -1`;
  - `setToken('bad')` → `bad_request`; `getMe` 401 → `bad_request` «Telegram rejected the token», секрет не записан; успех → `secret.write`, статус `token:'set'`, `botUsername`;
  - `link()` → код и `deepLink`; апдейт `/start <code>` от чужого `from` → `owner` записан, `setMyCommands`, ответ `Linked to Parley on <mac>`; `/start WRONG` ×5 → `pendingLink` снят, ответов нет;
  - чужое сообщение после привязки → ни `sendMessage`, ни `feed.decide`; чужой `callback_query` → только `answerCallbackQuery`;
  - `activity` → `blocked`, `feed.snapshot` с permission → `sendMessage` с 3 кнопками; `callback_query` `pc1:<shortId>:a` → `feed.decide(ref, cardId, {kind:'permission',behavior:'allow'})`, `editMessageText` с `✅ Allowed` и пустой клавиатурой; повтор того же нажатия → `Answered at your Mac`; `decide` даёт `applied:false, state:'allowed'` → та же честная квитанция (Review Focus 1–2);
  - псевдо-клиент: `feed.changed` с `state:'denied'` закрывает карточку квитанцией; `stale` → `Expired`;
  - решение ведущего в снимке → карточка с Accept/Return…; `r` → prompt, следующий текст → `resolveRoomProposal` с `note`; `/skip` → без `note`; `conflict` → квитанция `Revised`;
  - письмо человеку → уведомление, запись в `letters`; reply на него → `sendLetter` с `to:[from]` и `setMessageReaction`; обычный текст → `assistant.ask` с `origin 'telegram'`;
  - `telegramFinished:false` → `unseen` молчит; `telegramMail:false` → письмо молчит;
  - 409 → `polling 'conflict'`, `broadcast('telegram.changed')`, дальнейшие поводы не отправляются; `takeOver()` → опрос снова с `offset -1`;
  - `unlink()` → открытые карточки правятся в `Unlinked`, `hold(false)`; `clearToken()` → `state.json` удалён;
  - старт с записями `cards` из прошлого запуска → квитанции `Parley restarted — answer in Parley`;
  - ни одна строка `log` не содержит токена.
  `context.test.ts`: `hold('telegram', true)` держит от простоя и не меняет `liveSessions()`. `methods/telegram.test.ts`: шесть методов зовут сервис; `telegram.status` отвечает статусом.
- [ ] **Шаг 2: реализация.** `service.ts` — композиция модулей Task 4–9; старайтесь держать его как маршрутизатор: разбор, тексты и карточки — в чистых модулях.
- [ ] **Шаг 3: проверки (ведущий).** `pnpm --dir packages/host build`; `cd packages/host && pnpm exec vitest run src/telegram src/methods src/context.test.ts`; полный `pnpm --filter @parley/host test` при load < 12.
- [ ] **Шаг 4: коммит.** `feat(host): telegram channel — service, methods, wiring and host hold`.

---

### Task 11: Main — зеркало настроек помощника и окружение хоста

**Files:**
- Modify: `packages/desktop/src/main/index.ts` (`spawnHost` env у `:217-222`, `onUiSaved :697-708`, `onConnected`), `packages/desktop/src/main/host-launcher.ts` (при необходимости — только передача env)
- Create: `packages/desktop/src/main/assistant-mirror.ts`
- Test: `packages/desktop/src/main/assistant-mirror.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function assistantSettingsOf(ui: UiFile, voice: { downloaded(model: VoiceModelId): boolean; path(model: VoiceModelId): string }, language: (ui: UiFile) => AssistantLanguage): AssistantSettings;
  // enabled = ui.assistant.enabled; provider/model из ui.assistant; language(ui); voiceModel = ui.voice.enabled && model && downloaded(model) ? path(model) : null
  export function createAssistantMirror(deps: { call(method: 'assistant.configure', params: AssistantSettings): Promise<unknown>; methods(): readonly string[] | null; log(line: string): void }): { push(settings: AssistantSettings): Promise<void> };
  // push: метода нет в списке — тихо ничего; ошибка вызова — одна строка в лог, без throw
  export function hostExtraEnv(input: { whisperDir: string | null }): Record<string, string>;   // { NODE_USE_ENV_PROXY: '1', ...(whisperDir ? { PARLEY_WHISPER_DIR: whisperDir } : {}) }
  ```
- `index.ts`: `whisperDir` — каталог, где `resolveEngine` нашёл движок (`<resourcesPath>/whisper` в сборке, `devDir` в dev, иначе `null`); env хоста = `{ ...shellEnv.env, ...hostExtraEnv({ whisperDir }) }`; `mirror.push(assistantSettingsOf(...))` при каждом `connected` и в `onUiSaved`.

- [ ] **Шаг 1: тесты.** `assistantSettingsOf`: голос выключен → `voiceModel null`; включён, модель скачана → путь; помощник выключен → `enabled false`. `createAssistantMirror`: метода нет → `call` не вызван; есть → вызван с настройками; отказ → лог, без исключения. `hostExtraEnv` с и без `whisperDir`.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** `cd packages/desktop && pnpm exec vitest run src/main/assistant-mirror.test.ts && pnpm typecheck`.
- [ ] **Шаг 4: коммит.** `feat(main): mirror assistant settings to the host and pass the whisper engine dir`.

---

### Task 12: Окно — раздел Telegram в Settings → Notifications

**Files:**
- Modify: `packages/desktop/package.json` (ведущий: `pnpm --filter @parley/desktop add -D qrcode@1.5.4 @types/qrcode@1.5.6`), `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx:413-463` (вставка раздела, пробрасывает `bridge`, `config`, `locked`, `save`), `packages/desktop/src/shared/strings.ts` (`S.settings.telegram.*`)
- Create: `packages/desktop/src/renderer/components/settings/TelegramSettings.tsx`, `packages/desktop/src/renderer/components/settings/qr.ts`
- Test: `TelegramSettings.test.tsx` (fake-bridge), `qr.test.ts`

**Interfaces:**
- Consumes: `TelegramStatus`, методы `telegram.*`, событие `telegram.changed` (Task 1), ключи конфига (Task 2).
- Produces: `qrSvg(text: string): Promise<string>` (через `QRCode.toString(text, { type: 'svg', margin: 1 })`); компонент `TelegramSettings({ bridge, config, locked, save, hostMethods })` — рендерит `null`, если `hostMethods` не содержит `telegram.status`; при монтировании `telegram.status`, затем подписка `telegram.changed`.
- Элементы (11.1), `data-testid`: `telegram-section`, `telegram-enabled` (переключатель Send to Telegram → `save('telegramEnabled', …)`), `telegram-status` (строка состояния: Off / Not set up / `@bot · ••••abcd · not linked` / `Linked: @user · since <дата>` / `Error: …` / `Another Parley is using this bot` + кнопка `telegram-take-over`), `telegram-token` (password), `telegram-check`, `telegram-remove`, `telegram-link`, `telegram-code`, `telegram-deeplink`, `telegram-qr`, `telegram-unlink`, переключатели `telegram-needs-you`, `telegram-finished`, `telegram-mail`, `telegram-cards` (видны только при `owner !== null && enabled`), подсказка `S.settings.telegram.hint`. Ошибки методов — под полем через `errorText(decodeIpcError(err).code, …)`; `bad_request` от `setToken` показывает текст хоста.

- [ ] **Шаг 1: тесты.** Раздела нет без метода; статусы строки по шести `TelegramStatus`; Check зовёт `telegram.setToken` с введённым токеном и очищает поле; Link показывает код, ссылку и SVG; событие `telegram.changed` с `owner` переключает на Linked и показывает четыре переключателя; переключатель Finished зовёт `settings.set { key:'telegramFinished', value:'true' }`; Send to Telegram выкл → строка Off и переключатели скрыты; `qr.test.ts`: строка начинается с `<svg`.
- [ ] **Шаг 2: реализация** по образцу `AssistantSettings.tsx`/`ProviderCard.tsx`; тексты только в `strings.ts`.
- [ ] **Шаг 3: проверки (ведущий).** `cd packages/desktop && pnpm exec vitest run src/renderer/components/settings && pnpm typecheck`; `pnpm exec eslint` по файлам.
- [ ] **Шаг 4: коммит.** `feat(desktop): telegram section in notification settings — token, link code with QR, toggles`.

---

### Task 13: Окно — письма «via Telegram» и ход помощника из Telegram

**Files:**
- Modify: `packages/desktop/src/renderer/components/rooms/feed-model.ts:386-387`, `packages/desktop/src/renderer/components/rooms/RoomMessage.tsx:145` (аватар), `packages/desktop/src/renderer/island/assistant/store.ts` (`reminderOpen` → также `origin: 'telegram'`), `packages/desktop/src/shared/strings.ts` (`S.participants.viaTelegram(name)`)
- Test: `feed-model.test.ts`, `island/assistant/store.test.ts`

- [ ] **Шаг 1: тесты.** Письмо с `via: 'telegram'` подписано `You (via Telegram)`; `applyHost` с `origin: 'telegram'` и новым `turn` при закрытом острове открывает его, как напоминание.
- [ ] **Шаг 2: реализация.**
- [ ] **Шаг 3: проверки (ведущий).** целевые тесты + typecheck.
- [ ] **Шаг 4: коммит.** `feat(desktop): letters sent via Telegram and telegram-origin assistant turns`.

---

### Task 14: E2E — раздел Telegram, привязка и вопрос помощнику через фейковый Bot API

**Files:**
- Create: `packages/desktop/e2e/fake-telegram.mjs`, `packages/desktop/e2e/telegram.spec.ts`
- Modify: `packages/desktop/e2e/stub-assistant-agent.mjs` — только если нужен новый ответ

**Interfaces:**
- `fake-telegram.mjs`: `node:http` сервер на `127.0.0.1:0`; маршруты `/bot<token>/<method>`: `getMe` → `{ id: 123456, is_bot: true, username: 'parley_fake_bot' }`; `getUpdates` — long poll до 25 с над очередью; `sendMessage`, `editMessageText`, `editMessageReplyMarkup`, `answerCallbackQuery`, `setMyCommands`, `sendChatAction`, `setMessageReaction`, `getFile` → `ok` с растущим `message_id`, всё пишется в журнал; служебные `POST /__push` (апдейт в очередь) и `GET /__sent` (журнал). Экспорт `startFakeTelegram(): Promise<{ url, push(update), sent(), close() }>` — спек запускает его в процессе Playwright.
- Спек (окно 800×500, `PARLEY_TELEGRAM_API=<url>`, `PARLEY_CLAUDE_BIN=stub-assistant-agent.mjs`, `PARLEY_ISLAND=''`):
  1. `saveUi({ assistant: { enabled: true, provider: 'claude' } })`; Settings (⌘,) → Notifications → `telegram-section` виден.
  2. Токен `123456:` + 35 знаков → Check → `telegram-status` содержит `@parley_fake_bot`.
  3. Link → `telegram-code` показывает код; `push` апдейта `message` из private chat `{ id: 777 }`, `from { id: 777, username: 'owner' }`, `text: '/start <код без дефисов>'` → `telegram-status` содержит `Linked: @owner`; в `sent()` есть сообщение с `Linked to Parley`.
  4. `push` текста `what is going on?` → в `sent()` появляется `sendMessage` с текстом стаба (`Nothing is open right now`) в чат 777 (≤ 30 с).
  5. Переключатель Send to Telegram выкл → `telegram-status` = `Off`; `getUpdates` больше не приходят (журнал запросов не растёт 3 с).

- [ ] **Шаг 1: написать фейковый сервер и спек.**
- [ ] **Шаг 2: проверки (ведущий).** `pnpm --dir packages/host build && pnpm --dir packages/desktop build && cd packages/desktop && LC_ALL=C pnpm exec playwright test e2e/telegram.spec.ts`.
- [ ] **Шаг 3: коммит.** `test(e2e): telegram settings, link flow and an assistant question through a fake bot api`.

---

## Самопроверка плана

1. **Покрытие спеки.** 8.1 (место, удержание хоста) — T10/T11; 8.2 (модули) — T4–T10; 8.3 — T3; 8.4 — T8/T11; 8.5 — T1/T10; 9.1–9.5 — T6/T10 (`setMyCommands`, сброс по botId, 409/takeOver); 10.1 — T7/T10; 10.2 — T7/T10; 10.3 — T8; 10.4 — T10 (+ T13 подпись); 10.5 — T9; 11.1 — T12; 11.2 — T2; 12 — приложение A; 13 — тесты по задачам + T14; 14 — Global Constraints. Не делается в этом плане: QR-библиотека выбрана (`qrcode`); уведомления macOS без окна (16.2) — вне спеки; `getWebhookInfo` (обзор) — не требуется спекой, ошибка webhook видна как `error` с `description`.
2. **Типы сквозь задачи.** `CardRecord`, `TelegramStateFile`, `TgUpdate` — из T4 `types.ts`; `Callback`/`CALLBACK_CODES` — T6; `TelegramStatus` — T1; `AssistantSettings` — T1 (используют T8, T11); `BotApi`/`Outbox`/`Poller` — T5; `VoiceResult` — T9; `hold` — T10.
3. **Пропорция.** Код в плане — только сигнатуры и значения спеки.
4. **Review Focus** привязан к тестам T2, T4, T5, T6, T10.
5. **Живая приёмка автора** (спека 13) остаётся после слияния: реальный бот, QR, Allow на настоящем разрешении, голосовое, 409 со второго Mac.
