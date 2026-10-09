# Картинки из результатов инструментов в ленте Chat — план

> **Для исполнителей-агентов:** навык superpowers:subagent-driven-development; задачи по одной; шаги — флажками (`- [ ]`).

**Цель:** скриншоты и другие картинки, которые агент получил от инструмента (claude-in-chrome, MCP Chrome DevTools, Playwright MCP, будущий `browser_screenshot` Parley, Read картинки у Claude, `view_image` у Codex), человек видит в ленте Chat миниатюрами под строкой вызова; клик — крупно.

**Спеки отдельной нет:** решение принято в разговоре 2026-10-09. Оно ниже, в разделе «Устройство», и обязательно для исполнителей.

**Где работать:** ветка `feat/chat-tool-images`, worktree `.claude/worktrees/chat-images` от `origin/master` (`bacd0d2`, v0.10.0). Команды — из корня worktree: `pnpm install && pnpm build` один раз, затем:
- тесты пакета — `pnpm --filter @parley/<core|protocol|host|desktop> test`;
- одиночный тест — `pnpm --filter @parley/<pkg> exec vitest run <путь>`;
- типы и линт — `pnpm typecheck`, `pnpm lint`;
- E2E — `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test <файл>`.

## Что сейчас (проверено 2026-10-09 по коду и живым журналам)

- **Тип ленты.** `FeedToolResponse` (`packages/core/src/feed/types.ts`) — только `{ text, size, truncated }`. `ToolItem.tsx` показывает `text` в `<pre>`, картинок в ленте нет.
- **Claude.** MCP-результат — массив блоков. Картинка в нём выглядит так: `{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"…"}}`; рядом бывают текстовые блоки, в том числе `[Image: source: …]`.
  - Где лежит массив: в журнале — в `toolUseResult` и `tool_result.content`. Хук `PostToolUse` отдаёт его в `tool_response`; для Bash `tool_response` совпадает с `toolUseResult`.
  - `toolResponseOf` (`core/feed/reduce.ts`) делает из массива `JSON.stringify`, и в Result виден base64.
  - Read картинки отдаёт `toolUseResult` = `{"type":"image","file":{"base64":"…","type":"image/png",…}}`.
  - `from-transcript.ts#…tool_result` берёт `blocksText(content)`, если `toolUseResult` не объект, и картинка теряется.
- **Codex.** `item_completed` → `McpToolCall`: `result.content` = `[{type:'text',…},{type:'image',data:'…',mimeType:'image/png'}]`. `apply-codex.ts` берёт `blocksText`, и картинка теряется.
  - `ImageView` (`view_image`) несёт `path` файла и показывается как `ViewImage` без картинки.
- **Миниатюры в окне уже есть.**
  - `app.imageThumbnail(path)` (`main/image-thumbnail.ts`) принимает любой абсолютный путь картинки по расширению (`png|jpe?g|gif|webp`) не больше `MAX_DROP_IMAGE_BYTES` и отдаёт data-URL на 320 px.
  - `useThumbnail` (`renderer/chat/use-thumbnail.ts`) кэширует ответы.
  - `AttachmentChip size="feed"` рисует миниатюру 160×120.
  - Мост в ленте даёт `useContext(ChatEnvContext)?.bridge` (так делает `PromptItem`).

## Устройство (решения)

1. **Хост вынимает картинки до редуктора.** Чистая функция core `stashFeedImages(value, save)` обходит JSON записи или тела хука. Картинку она распознаёт в любом из четырёх видов:
   - `{type:'image', source:{type:'base64', media_type, data}}` (Anthropic);
   - `{type:'image', data, mimeType}` (MCP, Codex);
   - `{type:'input_image', image_url:'data:<mime>;base64,<data>'}` (OpenAI);
   - `{type:'image', file:{base64, type}}` (Read у Claude).

   Каждую картинку она отдаёт в `save(base64, mime)` и заменяет блок новым: прежний `type`, без base64, плюс `parleyImage: FeedImageRef`. Если `save` вернул `null` (слишком большая, неизвестный тип, битая), в блоке вместо ссылки ставится `parleyImageOmitted: true`. Тип блока сохраняется, поэтому счёт картинок промпта (`block.type === 'image'`) не ломается.
2. **Файлы пишет хост.** Хранилище `createFeedImageStore({ dir })`:
   - каталог `<PARLEY_HOME>/feed-images/`;
   - запись синхронная (`writeFileSync`), чтобы порядок событий хука не менялся;
   - имя — первые 24 hex `sha256` байтов плюс расширение по mime, без повторов;
   - права: каталог 0700, файлы 0600;
   - только `image/png|jpeg|webp|gif`, не больше `FEED_IMAGE_MAX_BYTES` = 20 МиБ после декодирования;
   - `sweep()` удаляет файлы старше 7 суток (`FEED_IMAGE_TTL_MS`) при старте сервиса ленты и раз в 6 ч (таймер `unref`).
3. **Лента несёт ссылки, не байты.**
   - `FeedImageRef = { path: string; mime: string; bytes?: number }`.
   - `FeedToolResponse.images?: FeedImageRef[]`, не больше `FEED_IMAGES_PER_CALL` = 6.
   - Вложенные вызовы субагента (`nested`) картинок не несут.
   - В тексте сводки на месте картинки стоит пометка `[image png, 123 KB]`; у выброшенной — `[image omitted]`.
   - Массив блоков сводится к тексту текстовых блоков (`text`, `input_text`) с этими пометками по порядку, без JSON.
4. **Codex.**
   - `McpToolCall` с картинкой отдаёт в `finishTool` массив `result.content`, без JSON.
   - `ImageView` даёт `response.images = [{ path, mime: по расширению }]` — сам файл агента, без копии, если путь абсолютный и расширение картинки.
5. **Протокол.** Схема `toolResponse` (`packages/protocol/src/feed.ts`) получает `images` (`exactOptional`, массив до 6): `path` до 4096 символов, `mime` до 100, `bytes` — целое ≥ 0, необязательное. Старое окно лишнее поле пропускает.
6. **Окно.**
   - **Ряд миниатюр.** Под строкой вызова (видна и у свёрнутого) — до 6 миниатюр 160×120 через `useThumbnail`. Клик — диалог просмотра (`renderer/ui/dialog.tsx`), в нём картинка до 1600 px по длинной стороне через `app.imageThumbnail(path, 1600)`. Esc и клик вне — закрыть.
   - **Нечитаемая картинка.** Миниатюра не пришла — значок `ImageIcon` с подписью `Image`.
   - **Строки** английские, в `S.chat`: `toolImage(n, total)` — «Image 2 of 3», `toolImageOpen` — «Open image», `toolImageUnavailable` — «Image unavailable».
   - **Размер в main.** `app.imageThumbnail(path, maxPx?)` (IPC `app:image-thumbnail`) — необязательная сторона 64–2048, по умолчанию 320. Предел файла прежний.
7. **Вне этой работы:** картинки промпта человека, телефон и удалённый доступ (путь там бессмыслен), вложенные вызовы субагента, `custom_tool_call_output` Codex (код-режим).

## Глобальные ограничения

- Агенту ничего не уходит: меняется только то, что видит человек. Журналы CLI не трогаем: только чтение. В `~/.claude`, `~/.codex` не пишем.
- Строки окна — английские, через `S`; страж `packages/desktop/src/english-ui.test.ts`. Комментарии, тесты, коммиты — по-русски.
- Числа — константы: `FEED_IMAGES_PER_CALL`, `FEED_IMAGE_MAX_BYTES`, `FEED_IMAGE_TTL_MS` (core `feed/types.ts`). Других чисел мимо констант нет.
- Коммит: `git commit -m "<тип>(<область>): …" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`. В коммит — только свои пути, не `.omc/` и не `.superpowers/`. Не пушить.
- Окно 800×500 и длинные имена инструментов: ряд миниатюр переносится, без горизонтальной прокрутки.

## Фокус ревью

1. Огромный результат: 10 картинок по 5 МБ и одна битая. В ленте 6 ссылок, у остальных пометки, процесс жив, base64 нигде в ленте нет (`JSON.stringify(feed)` не содержит `iVBOR` / `/9j/`).
2. Повтор той же картинки — один файл (`sha256`); `sweep` не трогает свежие.
3. Порядок событий хука не меняется: запись синхронная, `onHook` остаётся синхронным.
4. Счёт картинок промпта из журнала Claude прежний (`images: 1` в `from-transcript.test.ts`).
5. Нечитаемый путь в окне: значок без падения, лента живёт.

---

## Задача 1. Core: ссылки на картинки в ленте, обход блоков, сводка результата

**Файлы:**
- `packages/core/src/feed/types.ts`;
- новый `packages/core/src/feed/images.ts`;
- `packages/core/src/feed/reduce.ts` (`toolResponseOf`, `finishTool`);
- `packages/core/src/feed/from-transcript.ts`;
- `packages/core/src/feed/index.ts` (экспорт);
- `packages/protocol/src/feed.ts` (схема `toolResponse`).

Тесты — новый `packages/core/src/feed/images.test.ts`, дополнить `reduce.test.ts` (или файл, где тестируется `toolResponseOf`), `from-transcript.test.ts`, тест схемы протокола.

**Интерфейсы:**
- `export interface FeedImageRef { path: string; mime: string; bytes?: number }` и `images?: FeedImageRef[]` в `FeedToolResponse`.
- `export const FEED_IMAGES_PER_CALL = 6; export const FEED_IMAGE_MAX_BYTES = 20 * 1024 * 1024; export const FEED_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;`
- `export function stashFeedImages(value: unknown, save: (base64: string, mime: string) => FeedImageRef | null): unknown`:
  - возвращает новую структуру; исходник не меняет;
  - глубина обхода ограничена, циклов в JSON нет;
  - mime из data-URL и полей `media_type` / `mimeType` / `file.type`.
- `toolResponseOf(value, limit)`:
  - массив блоков (у каждого элемента есть строковое `type`) → текст текстовых блоков и пометки картинок, `images` из `parleyImage`;
  - объект `{type:'image', parleyImage | parleyImageOmitted}` → пометка и `images`;
  - прочее — как сейчас;
  - `images` только если не пусто, не больше `FEED_IMAGES_PER_CALL`, лишние — пометкой `[image omitted]`.
- `finishTool(…, nested)`: у вложенного вызова `images` не ставится.
- `from-transcript.ts`: если в `toolUseResult` или `content` есть блок с `parleyImage` или `parleyImageOmitted`, в `finishTool` идёт этот массив или объект, а не `blocksText`.

- [ ] **Шаг 1.** Падающие тесты:
  - `stashFeedImages` — четыре вида блоков; `save → null` → `parleyImageOmitted`; исходник не изменён; data-URL с mime;
  - `toolResponseOf` — массив «текст + картинка + текст» → текст с пометкой и одна ссылка; 8 картинок → 6 ссылок и 2 `[image omitted]`; Read-объект; вложенный — без `images`;
  - `from-transcript` на записи с `parleyImage` → `images` у вызова, и прежний тест `images: 1` у промпта проходит;
  - схема протокола: `images` принимается и проверяется (7 штук — ошибка).
- [ ] **Шаг 2.** Реализация.
- [ ] **Шаг 3.** Проверка: `pnpm --filter @parley/core test`, `pnpm --filter @parley/protocol test`, `pnpm typecheck`.
- [ ] **Шаг 4.** Коммит `feat(core): ссылки на картинки результата инструмента в ленте Chat — обход блоков и сводка без base64`.

## Задача 2. Codex: картинки `McpToolCall` и `ImageView`

**Файлы:** `packages/core/src/feed/codex/apply-codex.ts`; тесты — его тест-файл (`apply-codex.test.ts` или где тестируется `applyCodexRecords`).

**Интерфейсы:**
- `McpToolCall`: если в `result.content` есть блок с `parleyImage` / `parleyImageOmitted`, в `finishTool` идёт сам массив `result.content` (сводку делает `toolResponseOf` из задачи 1). Иначе — как сейчас (`blocksText ?? JSON.stringify(result)`).
- `ImageView`: путь абсолютный, расширение `png|jpe?g|gif|webp` → `finishTool(…, { type: 'image', parleyImage: { path, mime } })`, mime по расширению. Иначе — как сейчас.

- [ ] **Шаг 1.** Падающие тесты:
  - запись `item_completed` с `McpToolCall` `chrome-devtools take_screenshot` (текст + картинка-маркер, как после `stashFeedImages`) → вызов `mcp__chrome-devtools__take_screenshot` с одной ссылкой и текстом «Took a screenshot…»;
  - `ImageView` с `/tmp/x.png` → ссылка на файл;
  - `ImageView` с `x.txt` — без ссылки.
- [ ] **Шаг 2.** Реализация. **Шаг 3.** `pnpm --filter @parley/core test`. **Шаг 4.** Коммит `feat(core): Codex — скриншоты MCP и view_image в ленте ссылками`.

## Задача 3. Хост: хранилище картинок ленты и обход входящих данных

**Файлы:**
- новый `packages/host/src/feed/image-store.ts`;
- `packages/host/src/feed/feed-service.ts`.

Тесты — новый `image-store.test.ts`, дополнить `feed-service.test.ts`.

**Интерфейсы:**
- `export function createFeedImageStore(options: { dir: string; now?: () => number; maxBytes?: number }): { save(base64: string, mime: string): FeedImageRef | null; sweep(): void }`.
  - Синхронная запись, правила — «Устройство», п. 2.
  - Неизвестный mime, пустые или битые данные, превышение предела → `null`. Исключений наружу нет.
  - Ошибка ФС → `null` и одна строка `console.warn('[parley] feed image', …)` без данных.
- `FeedServiceOptions.imagesDir?: string`, по умолчанию `path.join(parleyHome(), 'feed-images')`.
- В `createFeedService` создать хранилище. Через `stashFeedImages(…, store.save)` пропускать:
  - тело хука Claude (`onHook`) и тело хука Codex (`onCodexHook`) — до `applyHookEvent` / `applyCodexHookEvent`;
  - каждую запись, прочитанную из журналов: обёртка над `readRecords` и разбором строк в `readTail`.

  `onHook` остаётся синхронным.
- `sweep()` — при создании сервиса и по таймеру раз в 6 ч (`unref`), таймер снимается в `dispose`/`close` сервиса, если он есть.

- [ ] **Шаг 1.** Падающие тесты:
  - `image-store`: PNG пишется, путь внутри `dir`, права 0600; та же картинка — тот же путь, файл один; 21 МиБ → `null`; `image/svg+xml` → `null`; `sweep` удаляет файл старше 7 суток (`now`) и оставляет свежий;
  - `feed-service`: хук `PostToolUse` с `tool_response` = массив «текст + картинка base64» → в снимке ленты у вызова `response.images[0].path` в `imagesDir`, файл существует, а в `JSON.stringify(снимок)` нет base64;
  - журнал Codex с `McpToolCall` и картинкой → ссылка у вызова.
- [ ] **Шаг 2.** Реализация. **Шаг 3.** `pnpm --filter @parley/host test`, `pnpm typecheck`. **Шаг 4.** Коммит `feat(host): картинки результатов инструментов — файлы в feed-images, в ленте ссылки`.

## Задача 4. Окно, main: размер миниатюры по запросу

**Файлы:**
- `packages/desktop/src/main/image-thumbnail.ts`;
- `packages/desktop/src/main/ipc.ts` (`app:image-thumbnail`);
- `packages/desktop/src/preload/index.ts`;
- `packages/desktop/src/shared/bridge.ts`;
- `packages/desktop/src/renderer/test-utils/fake-bridge.ts`.

Тесты — `image-thumbnail.test.ts`, `ipc.test.ts`, тест preload.

**Интерфейсы:**
- `imageThumbnail(input, deps, maxPx?)`: `maxPx` — целое 64–2048, иначе 320. И системная миниатюра, и уменьшение берут его.
- `bridge.app.imageThumbnail(path: string, maxPx?: number): Promise<string | null>`. IPC передаёт второй аргумент, main проверяет его тип.
- `useThumbnail` не меняется: он без `maxPx`.

- [ ] Тесты (1600 → `createThumbnailFromPath` с 1600; 99999 → 320) → реализация → `pnpm --filter @parley/desktop test` → коммит `feat(desktop): миниатюра картинки нужного размера для просмотра`.

## Задача 5. Окно: миниатюры под вызовом и просмотр

**Файлы:**
- новый `packages/desktop/src/renderer/chat/items/ToolImages.tsx`;
- `packages/desktop/src/renderer/chat/items/ToolItem.tsx`;
- `packages/desktop/src/shared/strings.ts` (`S.chat.toolImage`, `toolImageOpen`, `toolImageUnavailable`).

Тесты — новый `ToolImages.test.tsx`, дополнить `items.test.tsx`.

**Интерфейсы:**
- `ToolImages({ images }: { images: FeedImageRef[] })`.
  - Мост — `useContext(ChatEnvContext)?.bridge ?? null`.
  - Ряд `flex flex-wrap gap-2`, кнопка-миниатюра 160×120 с `aria-label={S.chat.toolImage(i + 1, n)}`; `data-testid="chat-tool-image"`.
  - Без миниатюры — значок и `S.chat.toolImageUnavailable`.
  - Клик — `Dialog` с `<img>` из `bridge.app.imageThumbnail(path, 1600)` (`max-h-[85vh] max-w-[90vw] object-contain`), `data-testid="chat-tool-image-view"`.
- `ToolItem`: ряд под кнопкой строки, когда `item.response?.images?.length > 0`. Виден у свёрнутого и у развёрнутого, в `chat-tool-details` не дублируется.

- [ ] **Шаг 1.** Падающие тесты:
  - две ссылки → две кнопки с подписями «Image 1 of 2», «Image 2 of 2», миниатюры из `FakeBridge.imageThumbnail`;
  - клик → диалог и вызов с 1600, Esc закрывает;
  - `imageThumbnail → null` → значок с «Image unavailable»;
  - свёрнутый `ToolItem` с картинками показывает ряд; без картинок ряда нет.
- [ ] **Шаг 2.** Реализация.
- [ ] **Шаг 3.** Проверка: `pnpm --filter @parley/desktop test` (с `english-ui`), `pnpm typecheck`, `pnpm lint`.
- [ ] **Шаг 4.** Коммит `feat(desktop): скриншоты из результатов инструментов — миниатюры под вызовом и просмотр`.

## Задача 6. E2E и документы

**Файлы:**
- E2E — в `packages/desktop/e2e/chat-hooks.spec.ts` или новый `e2e/chat-tool-images.spec.ts`, по приёмам `chat-hooks.spec.ts` (стаб Claude на HTTP-хуках);
- `CHANGELOG.md` (`## Unreleased` → `### Added`);
- `README.md` — одно предложение в разделе о виде Chat.

**Сценарий E2E:**
- стаб шлёт `PreToolUse` и `PostToolUse` вызова `mcp__chrome-devtools__take_screenshot` с `tool_response` = `[{type:'text',text:'Took a screenshot'},{type:'image',source:{type:'base64',media_type:'image/png',data:<PNG 40×30>}}]`;
- в ленте под вызовом одна миниатюра, клик открывает просмотр;
- снимки окна 800×500 при DPR 1 и 2 — в `test-results/chat-tool-images/`;
- без горизонтальной прокрутки ленты.

Как стаб шлёт свой вызов, смотреть в `e2e/` (переменные стаба). Если нужного хода нет — добавить в стаб минимально.

**Тексты:**
- CHANGELOG — английский: «**Screenshots in Chat.** When an agent's tool returns an image — a browser screenshot from Chrome DevTools MCP, Claude in Chrome or Playwright, an image it read — Chat shows it as a thumbnail under the call; click to view it larger. Parley keeps these images in `~/.parley/feed-images` for 7 days.»
- README — короткое предложение того же смысла.

- [ ] E2E → прогон → документы → `release-docs` и `english-ui` тесты → коммит `test(desktop): E2E скриншотов в ленте Chat; README, CHANGELOG`.

## Задача 7. Завершение

- Полный прогон: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @parley/desktop e2e`. Флейки — по одному, против базового прогона.
- Финальное ревью ветки. Push и PR — только с разрешения человека.
- Живая проверка с настоящим Claude (одним вызовом MCP-скриншота) — только с разрешения человека: подтвердить, что хук `PostToolUse` отдаёт картинку в `tool_response`. Если нет — картинка придёт при перечитывании журнала. Решение — отдельно.
