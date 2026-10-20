# Браузер Parley, этап D «Агент управляет браузером» — план (переписан 2026-10-20)

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЕН навык superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Одна задача — один исполнитель; шаги — чекбоксы (`- [ ]`). Исполнитель читает: раздел «Решения владельца», «Глобальные ограничения», «Общие имена», «Фокус ревью», «Ветки спайка» и свою задачу. Старый план D читается только по ссылкам «как в старом плане, задача N».

> **2026-10-20:** заменяет `2026-10-07-browser-devtools-agent-plan-d-agent-control.md` (написан 2026-10-07, до этапов B2 и C и до модели хозяев 3.10). Его структура и проверенные куски кода используются там, где этот план на них ссылается. Решения владельца 2026-10-20 перекрывают и старый план, и спеку; спеку и документы переписывает задача 23.

**Цель:** агент сессии полностью управляет страницами браузера своего чата и своих комнат на любом http(s)-сайте: открывает и ждёт загрузку, ходит по адресам, читает дерево доступности со ссылками `eN`, кликает, вводит текст, выбирает, тянет, ждёт изменений, меняет размер, снимает элемент, исполняет JS в мире страницы, читает и меняет куки и хранилище текущей страницы, загружает файлы в поля и получает скачанные файлы. Человек видит значок агента со Stop, подсветку рамки и точку клика; пауза панели, Stop и общий выключатель обрывают любую операцию. Скилл `parley-browser` объясняет, как с этим работать.

**Архитектура:** цепочка та же, что у этапов B2 и C: MCP-сервер core (`browser_*`) → `POST /agent/browser` хоста → `browser.agentOp` окну → main (`agent-ops.ts` и модули рядом) → CDP гостя через `Inspector` с закрытым списком → `browser.agentResult`. Новое в main: дерево доступности (`ax-snapshot.ts`), ссылки и ожидание (`agent-dom.ts`), ввод (`agent-input.ts`), действия (`agent-actions.ts`), окно операции агента (`agent-window.ts`: скачивания и выбор файла во время операции и 2 с после), скрипты агента (`agent-evaluate.ts`, единственный вход к `Runtime.evaluate`), куки и хранилище (`agent-storage.ts`), скачивания (`agent-downloads.ts`). Окно (рендерер) сообщает «человек занят», ставит размер от агента, показывает значок со Stop, рамку и точку клика и, если так решит спайк, «одалживает» фокус `<webview>` на время ввода агента.

**Стек:** Electron 44.4.5 (`<webview>`, CDP 1.3 через `webContents.debugger`), React 18, zustand 5, Radix, `lucide-react`, `sonner`, Tailwind 4; `@modelcontextprotocol/sdk` 1.30, zod 4; vitest + Testing Library + jsdom; Playwright `_electron`.

**Спека:** `docs/specs/2026-10-07-browser-devtools-agent-design.md` (2 п. 8–11, 14; 3.3, 3.7, 3.10; 4.8; 5.1–5.5; 6; 8; 9; 12 «Этап D»; 13). **Индекс:** `docs/specs/2026-10-07-browser-devtools-agent-plan.md` («Общие имена», «Глобальные ограничения» — кроме пунктов, которые перекрыты ниже). **Этап 0:** `docs/research/2026-10-08-browser-stage0.md` (0.2, 0.4, 0.7). **План исправлений C:** `docs/specs/2026-10-16-browser-agent-read-fixes-plan.md` (как устроены поверхность снимка, очередь, реестр).

## Решения владельца 2026-10-20

Обязательны, перекрывают спеку и индекс.

1. **Объём** — всё из старого плана D: `open` с ожиданием загрузки; `navigate` (`url`, `back`, `forward`, `reload`); `snapshot` (дерево доступности со ссылками `eN`); `action` (`click`, `double_click`, `hover`, `type`, `press`, `scroll`, `select`, плюс `check`, `uncheck`, `drag`); `wait_for`; `resize`; `screenshot` с `ref`; значок агента со Stop; подсветка рамки и точка клика; `human_busy` при Select и Annotate; скилл `parley-browser` и указатели. **Плюс то, что спека запрещала:**
   - **JS** — `browser_evaluate`: выражение или функция в главном мире страницы; ответ — JSON-значение с пределом размера; исключение страницы — в ответ; ответ в ограде `pageData`; предел времени. Запрет «JS страницы не исполняется никогда» снимается.
   - **Любые сайты** — действия и чтение (`console`, `network`, `screenshot`, `snapshot`) на любых http(s)-страницах панелей агента. Проверка «только loopback» для операций агента снимается. `file:`, `javascript:`, `data:`, `chrome:` и прочие схемы — по-прежнему отказ. Модель хозяина (спека 3.10) остаётся: только панели своего чата и своих комнат; вкладки человека закрыты; пауза панели и «Let agents use the browser» действуют. Маска секретов в URL, консоли, сети и полях — остаётся.
   - **Файлы** — загрузка в `<input type=file>` по `ref` (абсолютные пути к существующим файлам; `DOM.setFileInputFiles`); скачивания разрешены (куда — решение ниже; путь агент узнаёт из ответа операции и из `browser_downloads`).
   - **Куки и хранилище** — чтение, запись, удаление кук и `localStorage`/`sessionStorage`. Граница — куки текущего адреса страницы (`session.cookies.get({ url })`), не весь раздел; хранилище — origin текущей страницы. Риск общего раздела `persist:harnas-browser` описан в спеке (задача 23).
2. **Разрешения.** Все `browser_*` разрешены заранее (`permissions.allow` в собственном `--settings` сессии), **кроме `browser_evaluate`**: на него Claude Code спрашивает человека при первом вызове. Аннотации MCP согласованы так, чтобы Codex вёл себя так же: спрашивает только про `browser_evaluate`.
3. Прочая защита старого плана D сохраняется, если не противоречит п. 1–2: Stop обрывает операцию; `human_busy`; `stale_ref`; очередь страницы; пределы; маска значений секретных полей в дереве доступности. Буфер обмена — минимально (решение ниже).
4. **Загрузка файлов — всё, кроме секретных мест (решение владельца 2026-10-20 по отчёту плана).** После `realpath` путь не лежит внутри `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.docker`, `~/.kube`, `~/Library/Keychains`, `~/.parley`, `~/.claude`, `~/.codex`, а имя файла — не `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.env` или `.env.*`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` (где угодно; `.pub` — можно, если не в секретной папке). Иначе — `bad_request` «Parley does not upload files from secret locations (~/.ssh, keychains, .env …).», `DOM.setFileInputFiles` не вызывается. Списки — `UPLOAD_SECRET_DIRS`, `UPLOAD_SECRET_NAMES` и чистая `secretUploadPath(real, home)` в `agent-actions.ts` (задача 17). Сравнение — по сегментам пути (`~/.sshx/a` — не секретное место), регистр букв не учитывается (APFS по умолчанию к нему безразлична).
5. **Куки — общий с человеком раздел `persist:harnas-browser` подтверждён (там же).** Отдельного раздела для страниц агента не делаем; риск описывается в спеке и README (задача 23).

## Решения плана по открытым вопросам (утверждает владелец)

Каждое — одна строка в отчёте плана; другое решение владельца меняет названную задачу.

| Вопрос | Решение плана | Задачи |
|---|---|---|
| Папка скачиваний | `~/.parley/desktop/agent-downloads/<хеш работы, 12 hex>/<id сессии>/`, права каталога 0700, файла 0600; хранится 7 суток (`AGENT_LIMITS.downloadDays`), чистит почасовая уборка main; файл до 200 МБ (`downloadBytes`, больше — отмена с заметкой); в списке сессии — 20 последних. Скачивание, начатое во время операции агента на его странице или 2 с после неё, идёт туда без диалога; остальные — диалог человека, как сейчас | 10, 15, 19 |
| Граница кук | `browser_cookies` берёт адрес только из `contents.getURL()` страницы агента (аргумента `url` нет): `get({ url })` — куки, которые браузер послал бы на этот адрес, включая httpOnly; `set` — только host-only кука этого адреса (аргумента `domain` нет); `delete` — `remove(url, name)`. Значения в `list` скрыты, `values: true` их показывает | 2, 4, 12 |
| Маска «явных» чтений | Пассивные чтения (`tabs`, `console`, `network`, `snapshot`, `downloads`, `storage list`, имена кук) — через маску, как сейчас. Явно названные значения (`cookies` с `values: true`, `storage get`, `evaluate`) — как есть: иначе инструмент бесполезен; описания велят не повторять секреты | 4, 11, 12 |
| Буфер обмена | Нет доступа: разрешения раздела и так отклонены; из команд редактирования CDP в `press` идёт только `selectAll` (⌘A/Ctrl+A); `evaluate` — с `userGesture: false` (ни `execCommand('copy')`, ни `navigator.clipboard` без жеста не работают). Вставка текста — только `type` | 9, 11, 17 |
| Фреймы чужого origin | Клики и ввод по координатам попадают в любой фрейм (это дело страницы). `snapshot` — дерево главного фрейма, фреймы — строкой `iframe "…"` без содержимого; `evaluate`, куки и хранилище — главный фрейм. Запрета `Input.*` во фреймах нет | 7, 11, 12 |
| `evaluate`: мир и пределы | Главный мир (`Runtime.evaluate` / `Runtime.callFunctionOn` гостя), `returnByValue`, `awaitPromise`, `userGesture: false`; предел 10 с (`evalMs`: свой таймер и `Runtime.terminateExecution`), ответ до 20 КБ (`evalBytes`); с `ref` функция получает элемент первым аргументом. `Runtime.evaluate` идёт только через `Inspector.sendAgentScript`, его зовёт только `agent-evaluate.ts` (рамочный тест) | 6, 11, 19, 21 |
| Аннотации MCP | READ `{ readOnlyHint: true, openWorldHint: false }` — `tabs`, `console`, `network`, `screenshot`, `snapshot`, `wait_for`, `downloads`; CONTROL `{ readOnlyHint: false, destructiveHint: false, openWorldHint: false }` — `open`, `navigate`, `action`, `resize`, `cookies`, `storage`; SCRIPT `{ readOnlyHint: false, destructiveHint: true, openWorldHint: true }` — `evaluate`. CONTROL с `openWorldHint: false` — это политика одобрений Parley (решение владельца), а не описание мира: вливаемая ветка ставила `browser_open` `true`, задача 4 возвращает `false` с комментарием | 4 |
| Коды `not_loopback`, `navigation_blocked` | `not_loopback` остаётся в списке кодов (окно до D его присылает), окно D его не отдаёт. `navigation_blocked` не вводится: http(s) больше ничего не блокирует, прочие схемы отклоняет `bad_request` (аргументы) или молча страж (как у человека) | 2, 3, 15 |
| `upload` | Действие `browser_action` (`action: 'upload'`, `ref`, `files`), а не отдельный инструмент: та же очередь, `human_busy` и `stale_ref`. Выбор файла, открытый действием агента, перехватывается (`Page.setInterceptFileChooserDialog`) — нативного диалога у человека нет, агенту заметка. Файлы из секретных мест — отказ (решение владельца 4) | 2, 15, 17 |
| `wait_for` | Опрос дерева доступности (`Accessibility.getFullAXTree`) раз в 250 мс: видимый текст, как в `snapshot`; `DOM.performSearch` не берём — он находит и скрытый текст | 7, 16 |
| Снимок элемента | Снимок вьюпорта (путь этапа C) и вырезка рамки элемента на main с множителем «ширина PNG / CSS-ширина вьюпорта» (как Select этапа B); CDP `clip` не берём — в `<webview>` он ненадёжен (этап 0, 0.7; план C) | 18 |
| Точка клика и рамка | Рисует окно поверх `<webview>` (по `stage`), не скрипт в госте: страница их не видит, и они не зависят от событий мыши гостя (у гостя нет `mouseout`, когда курсор уходит на окно — проба 2026-10-20) | 13, 20 |
| Фокус страницы | `Emulation.setFocusEmulationEnabled({ enabled: true })` ставится гостю один раз при первом вводе агента и не снимается (если спайк В4 покажет blur после возврата фокуса); иначе не ставится | 9 |

## Пачки для Workflow

Одна задача — один исполнитель (Sonnet). Рецензия — на пачку, финальная рецензия ветки — Opus (задача 25). Задачи одной пачки, отмеченные «‖», идут параллельно: у них нет общих файлов. «→» — строго по порядку: общие файлы (`packages/protocol/src/browser-agent.ts`, `packages/core/src/mcp/browser-tools.ts`, `packages/desktop/src/main/browser/agent-ops.ts`, `main/index.ts`).

| Пачка | Задачи | Файлы (главные) | Зависит от | Порядок внутри |
|---|---|---|---|---|
| 0. База | 0 слияние `feat/browser-external-open`; 1 спайк | merge; `docs/research/2026-10-20-browser-agent-control-spike.md`, этот план | — | 0 → 1 |
| 1. Контракт | 2 протокол; 3 core: действия; 4 core: скрипт, куки, хранилище, скачивания, разрешения; 5 мост окна и IPC | `protocol/src/browser-agent.ts`; `core/src/mcp/browser-tools.ts`, `core/src/work/settings-file.ts`; `desktop/src/shared/browser-types.ts`, `preload/index.ts`, `main/ipc.ts`, `renderer/test-utils/fake-bridge.ts` | 0 | (2 → 3 → 4) ‖ 5 |
| 2. Кирпичи | 6 инспектор; 7 `ax-snapshot.ts`; 8 `agent-window.ts`; 9 `agent-input.ts` и `Emulation.fitOf`; 10 `agent-downloads.ts`; 11 `agent-evaluate.ts`; 12 `agent-storage.ts`; 13 значок агента; 14 скилл, указатели, правило приоритета | у каждой — свои новые файлы; 6 — `inspector.ts`, `page-fns.ts`; 9 — `emulation.ts`; 13 — `AgentBadge.tsx`, `BrowserChrome.tsx`, `strings.ts`; 14 — `core/src/work/*` | 1 | все ‖ |
| 3. Операции main | 15 основа `agent-ops`; 16 `snapshot`, `wait_for`; 17 `action`; 18 `navigate`, `resize`, `open`, `screenshot ref`; 19 `evaluate`, `cookies`, `storage`, `downloads` | `agent-ops.ts`, `agent-pages.ts`, `agent-capture.ts`, `agent-dom.ts`, `agent-actions.ts`, `main/index.ts`, тесты | 2 | 15 → 16 → 17 → 18 → 19 |
| 4. Окно и проверки | 20 окно: занятость, размер, Stop, значок, рамка, точка, фокус; 21 рамочные тесты; 22 E2E | `BrowserSurface.tsx`, `panel/agent-registry.ts`; `main/browser/*.test.ts` (рамочные); `e2e/browser-agent-control.spec.ts` | 3 | (20 ‖ 21) → 22 |
| 5. Документы и выпуск | 23 документы; 24 живые проверки (только по согласию); 25 завершение и финальная рецензия | спека, индекс, спека окна, README, CHANGELOG | 4 | 23 → 24 → 25 |

**Рецензия пачки** смотрит: файлы задач не пересекаются там, где задачи шли параллельно; имена — из «Общих имён»; тесты задач зелёные; `pnpm --filter <пакет> build` (protocol, core, host) или `pnpm --filter @parley/desktop typecheck` для затронутых пакетов; `pnpm exec eslint <изменённые файлы>`. Пачки 1 и 2 могут оставить красными два контрактных теста до конца пачки — это сказано в задачах.

## Как работать

- Worktree `/Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/browser-agent-control`, ветка `feat/browser-agent-control` (от `origin/master` 47823923, v0.18.0). Локальный `master` в корне отстал — не смотреть на него.
- Пакеты видят друг друга через `dist`: после правки `packages/protocol` — `pnpm --filter @parley/protocol build`; после правки `packages/core` — `pnpm --filter @parley/core build`. Тесты desktop и host читают собранные пакеты.
- Тесты — только затронутых файлов: `pnpm --filter @parley/<пакет> test -- <файл>` (владелец просит беречь ноутбук; полный прогон не нужен). E2E — только своих спеков: `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop e2e -- e2e/<спек>.ts`.
- **Нельзя** `prettier --write` (и `pnpm format`) на файлах репозитория: код шире `printWidth` 100, форматтер перепишет чужие строки.
- Известные флейки E2E и как гонять рантайм-пробы — память `parley-browser-agent-read-audit` (`chat-hooks:502`, `chat-view:106`, `island:261`, `limits:288` красные и на базе; `attention:190`, `room-decision:354/378` — фокус при параллельном прогоне).
- Коммит на задачу, сообщение по-английски (`AGENTS.md`), последняя строка — `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push — только по просьбе человека.

## Глобальные ограничения

Действуют ограничения индекса, кроме перекрытых здесь.

- **Где агент работает.** Только страницы панели своего чата и панелей своих комнат (`owners` события, реестр `registerTab`), при включённом `UiFile.browser.agentsAllowed` и без паузы панели. Вкладки человека не регистрируются и агенту недоступны никогда. Чужая страница неотличима от несуществующей (`no_tab`).
- **Какие страницы.** Любой http(s); `about:blank` — тоже (страница ещё не загружена). `open` и `navigate` принимают только http(s) (`openableHref`), прочее — `bad_request`. Страж гостя (`guard.ts`) не меняется: `file:`, `javascript:`, `chrome:` и прочее отклоняются для всех.
- **CDP** — только из main и только через `Inspector` с закрытым списком `CDP_ALLOWED` (задача 6). `Runtime.evaluate` и `Runtime.callFunctionOn` с чужой функцией — только `Inspector.sendAgentScript`, его зовёт только `agent-evaluate.ts`. `Runtime.callFunctionOn` через `send` — только с функциями Parley (`REACT_INFO_FN`, `SELECT_OPTION_FN`). Переходы — методами `webContents` (`loadURL`, `navigationHistory.goBack/goForward`, `reload`, `reloadIgnoringCache`), `Page.navigate` в списке нет.
- **Скрипты main в госте** — как сейчас: только мир `PICK_WORLD_ID` и только константы Parley (без строк агента). `executeJavaScript(` мира страницы в main нет.
- **Перед каждым шагом ввода** main заново проверяет: доступ не выключен, панель не на паузе, операцию не оборвали, у страницы нет Select или Annotate (`human_busy`).
- **`human_busy`** — до и во время `action`, `navigate`, `resize`, `evaluate`. Чтения, `wait_for`, `cookies`, `storage`, `downloads` у занятой страницы разрешены.
- **Окно операции агента** открывают `open`, `navigate`, `action`, `evaluate`; оно живёт до конца операции и ещё `AGENT_LIMITS.guardTailMs` (2 с). В окне: скачивания страницы — в папку сессии, выбор файла перехвачен. Вне окна — как у человека.
- **Агент не меняет активную вкладку, работу окна и фокус клавиатуры человека.** Если ввод требует фокуса `<webview>` (спайк), окно возвращает фокус туда, где он был, по концу операции.
- **Данные страницы** в ответах — в ограде core (`pageData`); URL — с маской (`urlForAgent`); значения секретных полей в дереве доступности — `<redacted>`. Явные значения (`evaluate`, `storage get`, `cookies values: true`) — без маски.
- **Пределы** — только константами `AGENT_LIMITS`, `AGENT_INPUT`, `DEVTOOLS_LIMITS`; числа мимо них — только именованные тайм-ауты рядом с кодом.
- **Тексты для агента** (описания, ответы, скилл) — английские. Строки окна — `S.browser.panel.*` в `shared/strings.ts` (страж `english-ui`).
- **Не трогать** `main/browser/guest-annotate.js` и `main/browser/annotate.ts`: их меняет отдельная ветка `fix/annotate-hover` (`__parleyAnnotate.unhover()`, слушатели `input-event`). E2E этого плана только читает `__parleyAnnotate.count()` и `waiting()`.
- **Живые запуски `claude`, `codex`, GLM** тратят лимит подписки человека: только задача 24 и только после явного «да» человека.

## Общие имена — контракт этапа D

Имена ниже обязательны: задачи пачки 2 пишутся параллельно и опираются только на этот раздел. Тип, которого здесь нет, задача держит внутри своего файла.

### Протокол (`packages/protocol/src/browser-agent.ts`, задача 2)

```ts
export const BROWSER_AGENT_OPS = ['tabs', 'console', 'network', 'screenshot', 'open',
  'navigate', 'snapshot', 'action', 'wait_for', 'resize', 'evaluate', 'cookies', 'storage', 'downloads'] as const;
// Девять прежних кодов + два: окно D не отдаёт not_loopback (оставлен для окон до D).
export const BROWSER_AGENT_ERROR_CODES = ['not_loopback', 'access_denied', 'window_not_connected', 'timeout', 'unsupported',
  'bad_request', 'no_tab', 'tab_hidden', 'tab_not_loaded', 'human_busy', 'stale_ref'] as const;

export const AGENT_LIMITS = {
  /* прежние ключи без изменений */ opMs: 30_000, openMs: 10_000, requestBytes: 65_536, listBytes: 20_480, listEntries: 100,
  detailBody: 8192, headerValue: 256, headers: 40, listQuery: 80, listStackFrames: 5, listEntryText: 1024,
  screenshotLongSide: 1568, fullPageViewports: 3, panelPages: 5, captureReadyMs: 2000, captureRetries: 2,
  screenshotBytes: 3_500_000, metricsMs: 1500,
  /* этап D */
  loadMs: 15_000,          // ожидание загрузки open/navigate/действия с переходом
  waitMs: 10_000,          // wait_for
  text: 10_000,            // type, expression, function, значение storage set
  snapshotBytes: 51_200,   // ответ snapshot
  guardTailMs: 2_000,      // окно операции агента после конца операции; столько же держится значок
  settleMs: 300,           // сколько ждать начала перехода после действия
  pollMs: 250,             // шаг опроса wait_for, регистрации страницы open, размера resize
  resizeMs: 2_000,         // сколько ждать, пока окно поставит размер от агента
  clickDotMs: 600,         // точка клика (спека 4.8)
  badgeOps: 5,             // подсказка значка — последние операции
  typingIdleMs: 1_000,     // ввод агента ждёт, пока человек не печатает в окне (правило 2026-10-08)
  evalMs: 10_000,          // предел скрипта агента
  evalBytes: 20_480,       // ответ evaluate
  storageValue: 8192,      // значение storage get
  uploadFiles: 10,         // файлов в одной загрузке
  uploadBytes: 104_857_600, // файл загрузки
  downloadBytes: 209_715_200, // файл скачивания
  downloads: 20,           // скачиваний сессии в списке
  downloadDays: 7,         // срок хранения скачанного
} as const;

export const AGENT_INPUT = { url: 4096, room: 64, pattern: 200, requestId: 200,
  key: 32, scroll: 10_000, option: 1024, path: 4096, cookieName: 256, cookieValue: 4096, storageKey: 1024 } as const;
export const AGENT_DEFAULTS = { limit: 50, level: 'error', failedOnly: true, fullPage: false, interactiveOnly: false, values: false } as const;

export const AGENT_VIEWPORT_PRESETS = ['mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'desktop'] as const;
export const AGENT_ACTIONS = ['click', 'double_click', 'hover', 'type', 'press', 'scroll', 'select', 'check', 'uncheck', 'drag', 'upload'] as const;
export type BrowserAgentAction = (typeof AGENT_ACTIONS)[number];
export const AGENT_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;
export type BrowserAgentModifier = (typeof AGENT_MODIFIERS)[number];
export const AGENT_COOKIE_ACTIONS = ['list', 'set', 'delete'] as const;
export const AGENT_STORAGE_ACTIONS = ['list', 'get', 'set', 'delete', 'clear'] as const;

// Формы ответов окна (все экспортируются из index.ts):
export interface BrowserAgentOpenResult { tab: string; owner: BrowserAgentOwner; url: string; reused: boolean;
  loaded: boolean; title: string; notes: string[] }                       // loaded и title — этап D
export interface BrowserAgentNavigateResult { tab: string; url: string; title: string; loaded: boolean; notes: string[] }
export interface BrowserAgentSnapshotResult { tab: string; url: string; text: string; refs: number; truncated: boolean }
export interface BrowserAgentActionResult { tab: string; url: string; done: string; navigated: boolean; notes: string[] }
export interface BrowserAgentWaitResult { tab: string; url: string; outcome: 'found' | 'gone' | 'waited' | 'timeout'; ms: number }
export interface BrowserAgentResizeResult { tab: string; url: string; viewport: { width: number; height: number; emulated: boolean } | null }
export interface BrowserAgentEvaluateResult { tab: string; url: string; outcome: 'value' | 'exception';
  text: string; type: string; truncated: boolean }                       // text — JSON значения или текст исключения
export interface BrowserAgentCookie { name: string; value?: string; domain: string; path: string; secure: boolean;
  httpOnly: boolean; sameSite: string; session: boolean; expires: string | null; size: number }
export type BrowserAgentCookiesResult = { tab: string; url: string; cookies: BrowserAgentCookie[]; notes: string[] } | { tab: string; url: string; done: string };
export type BrowserAgentStorageResult =
  | { tab: string; origin: string; area: 'local' | 'session'; entries: Array<{ key: string; value: string; size: number }>; total: number; notes: string[] }
  | { tab: string; origin: string; area: 'local' | 'session'; key: string; value: string | null; truncated: boolean }
  | { tab: string; origin: string; area: 'local' | 'session'; done: string };
export interface BrowserAgentDownload { id: string; tab: string | null; name: string; path: string; url: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; receivedBytes: number; totalBytes: number | null; startedAt: string; note?: string }
export interface BrowserAgentDownloadsResult { dir: string; downloads: BrowserAgentDownload[]; notes: string[] }
```

Схемы `browserAgentArgs` — по одной `z.strictObject(…)` с `.refine(…)` на операцию (не `union`: контрактный тест сравнивает `properties`). Поля и правила — задача 2, шаг 1.

### Core (`packages/core/src/mcp/browser-tools.ts`, задачи 3–4)

- `BROWSER_TOOL_OPS` — те же 14 в том же порядке (сверяет `host/src/agent/browser-contract.test.ts`).
- `BROWSER_TOOL_LIMITS` — прежние ключи и `loadMs`, `waitMs`, `text`, `snapshotBytes`, `evalMs`, `evalBytes`, `uploadFiles`, `downloads` (числа — как `AGENT_LIMITS`).
- `BROWSER_TOOLS_ASK = ['evaluate'] as const` — инструменты, которые не разрешаются заранее; `core/src/work/settings-file.ts#BROWSER_PERMISSIONS` = `BROWSER_TOOL_OPS` без них.
- `BROWSER_TOOL_HINTS` — ещё `human_busy`, `stale_ref`, `not_loopback`.
- `PARLEY_BROWSER_SKILL_NAME`, `PARLEY_BROWSER_SKILL_MD` — `core/src/work/parley-browser-skill.ts` (задача 14), экспорт из `core/src/index.ts`.

### Окно: типы и мост (`packages/desktop/src/shared/browser-types.ts`, задача 5)

```ts
export type AgentPageRegistration =
  | { kind: 'hello'; generation: string }
  | { kind: 'page'; generation: string; webContentsId: number | null; workKey: string; owner: BrowserOwner; pageId: string;
      visible: boolean; humanBusy?: boolean }                             // humanBusy — D; нет поля — false
  | { kind: 'gone'; … } | { kind: 'paused'; … };                          // без изменений

export interface AgentActivity {
  webContentsId: number; session: string; op: string;
  phase: 'start' | 'step' | 'end';                                         // step — D: точка клика или просьба о фокусе
  capture?: { width: number; height: number; id: string };                 // C, без изменений
  point?: { x: number; y: number };                                        // D: точка клика, CSS-пиксели вьюпорта страницы
  focus?: { id: string };                                                  // D (ветка спайка «одолжить фокус»): поставить фокус на <webview> и подтвердить agentFocusReady(id)
}
export interface AgentResize { webContentsId: number; viewport: ViewportSpec | null }   // событие browser:agent-resize

// BrowserApi, добавления D:
onAgentResize(listener: (e: AgentResize) => void): () => void;             // событие 'browser:agent-resize'
agentStop(webContentsId: number): Promise<void>;                           // канал 'browser:agent-stop'
agentFocusReady(id: string): Promise<void>;                                // канал 'browser:agent-focus-ready'
```

`AgentOps` (main) получает методы `stop(webContentsId: number): void` и `focusReady(id: string): void`; `RegisterIpcOptions.browser.agent` — `Pick<AgentOps, 'openTabResult' | 'registerTab' | 'captureReady' | 'stop' | 'focusReady'>`.

### Main: модули пачки 2

```ts
// main/browser/page-fns.ts (6) — функции Parley в мире страницы, которые пускает cdpCallAllowed
export const SELECT_OPTION_FN: string;  // function (wanted) { … } — this: <select>; выбирает option по value или по тексту; input+change; → { ok: true, label } | { ok: false, options: string[] }
export const PAGE_FNS: ReadonlySet<string>; // REACT_INFO_FN и SELECT_OPTION_FN

// main/browser/inspector.ts (6)
export const CDP_AGENT_SCRIPT: ReadonlySet<CdpMethod>;  // 'Runtime.evaluate', 'Runtime.callFunctionOn'
interface Inspector { /* … */ sendAgentScript<T = unknown>(id: number, method: 'Runtime.evaluate' | 'Runtime.callFunctionOn', params: Record<string, unknown>): Promise<T> }

// main/browser/ax-snapshot.ts (7)
export interface AxNode { nodeId: string; ignored: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>; childIds?: string[]; parentId?: string; backendDOMNodeId?: number }
export interface AxSnapshot { text: string; refs: Map<string, number>; truncated: boolean }
export function axSnapshot(nodes: readonly AxNode[], options: { interactiveOnly: boolean; limitBytes: number }): AxSnapshot;
export function axHasText(nodes: readonly AxNode[], text: string): boolean;   // видимый текст: имена не игнорируемых узлов и StaticText, без учёта регистра и пробелов
export function axState(nodes: readonly AxNode[], backendNodeId: number, state: 'checked'): boolean | 'mixed' | null;

// main/browser/agent-window.ts (8)
export interface AgentWindowOwner { pageKey: string; webContentsId: number; workKey: string; sessionId: string; agentId: string }
export interface AgentWindow {
  begin(owner: AgentWindowOwner): () => void;            // конец операции → хвост guardTailMs
  activeFor(webContentsId: number): AgentWindowOwner | null;
  note(webContentsId: number, note: string): void;       // события в окне: скачивание, выбор файла, новое окно
  take(pageKey: string): string[];                       // заметки с начала последнего begin; забирает
  onIdle(listener: (webContentsId: number) => void): () => void; // окно и хвост кончились
}
export function createAgentWindow(deps?: { tailMs?: number; setTimer?(fn: () => void, ms: number): () => void }): AgentWindow;

// main/browser/agent-input.ts (9)
export interface KeySpec { key: string; code: string; keyCode: number; text?: string }
export interface MouseStep { type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'; x: number; y: number;
  button?: 'left' | 'none'; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }
export interface InputGuard { signal: AbortSignal; check(): void }   // check бросает AgentOpError (Stop, пауза, human_busy)
export function inputPoint(point: { x: number; y: number }, fit: { scale: number; mobile: boolean } | null, zoom: number): { x: number; y: number };
export function keySpec(key: string): KeySpec | null;
export function modifierMask(modifiers: readonly BrowserAgentModifier[]): number;   // Alt 1, Control 2, Meta 4, Shift 8
export interface AgentInput {
  mouse(contents: WebContents, steps: readonly MouseStep[], modifiers: number, guard: InputGuard): Promise<void>;
  key(contents: WebContents, spec: KeySpec, modifiers: number, guard: InputGuard): Promise<void>;
  text(contents: WebContents, text: string, guard: InputGuard): Promise<void>;
}
export function createAgentInput(deps: { inspector: Pick<Inspector, 'send'>;
  borrowFocus?(contents: WebContents, signal: AbortSignal): Promise<void> }): AgentInput;
// main/browser/emulation.ts (9): Emulation.fitOf(id): { scale: number; mobile: boolean } | null — null у Fit

// main/browser/agent-downloads.ts (10)
export interface AgentDownloadOwner { workKey: string; sessionId: string; agentId: string | null }
export interface AgentDownloads {
  claim(item: DownloadItem, owner: AgentDownloadOwner): BrowserAgentDownload;   // синхронно, внутри will-download: setSavePath
  list(workKey: string, sessionId: string): BrowserAgentDownload[];
  dirOf(workKey: string, sessionId: string): string;
  sweep(maxAgeMs: number, now?: number): Promise<number>;
}
export function createAgentDownloads(deps: { root: string; now?(): number }): AgentDownloads;

// main/browser/agent-evaluate.ts (11)
export interface AgentScriptSender {
  send<T = unknown>(id: number, method: string, params?: Record<string, unknown>): Promise<T>;
  sendAgentScript<T = unknown>(id: number, method: 'Runtime.evaluate' | 'Runtime.callFunctionOn', params: Record<string, unknown>): Promise<T>;
}
export interface AgentScripts {
  evaluateOf(contents: WebContents, agentId: string, args: BrowserAgentArgs<'evaluate'>, element: number | null, signal: AbortSignal): Promise<BrowserAgentEvaluateResult>;
}
export function createAgentScripts(deps: { inspector: AgentScriptSender; evalMs?: number }): AgentScripts;

// main/browser/agent-storage.ts (12)
export interface AgentStorage {
  cookiesOf(contents: WebContents, agentId: string, args: BrowserAgentArgs<'cookies'>): Promise<BrowserAgentCookiesResult>;
  storageOf(contents: WebContents, agentId: string, args: BrowserAgentArgs<'storage'>): Promise<BrowserAgentStorageResult>;
}
export function createAgentStorage(deps: { cookies: Pick<Electron.Cookies, 'get' | 'set' | 'remove'>; inspector: Pick<Inspector, 'send'> }): AgentStorage;
```

### Main: модули пачки 3

```ts
// main/browser/agent-dom.ts (16)
export interface AgentDom {
  snapshotOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'snapshot'>): Promise<BrowserAgentSnapshotResult>;
  nodeOf(contents: WebContents, record: PageRecord, ref: string): number;   // backendNodeId; stale_ref — нет ссылки или эпоха другая
  centerOf(contents: WebContents, backendNodeId: number): Promise<{ x: number; y: number }>; // после scrollIntoViewIfNeeded; узла нет — stale_ref
  boxOf(contents: WebContents, backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number }>;
  waitFor(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'wait_for'>, signal: AbortSignal): Promise<BrowserAgentWaitResult>;
  checkedOf(contents: WebContents, backendNodeId: number): Promise<boolean | 'mixed' | null>;
}
export function createAgentDom(deps: { inspector: Pick<Inspector, 'send' | 'snapshot'>; now?(): number }): AgentDom;

// main/browser/agent-actions.ts (17)
export interface AgentActions {
  actionOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'action'>, guard: InputGuard): Promise<BrowserAgentActionResult>;
}
export function createAgentActions(deps: { inspector: Pick<Inspector, 'send'>; input: AgentInput; dom: AgentDom;
  emulation: Pick<Emulation, 'fitOf'>; window: Pick<AgentWindow, 'take'>; activity(e: AgentActivity): void;
  files?: { realpath(p: string): Promise<string>; stat(p: string): Promise<{ isFile(): boolean; size: number }> }; home?: string }): AgentActions;
export const UPLOAD_SECRET_DIRS: readonly string[];  // от домашней папки: '.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.kube', 'Library/Keychains', '.parley', '.claude', '.codex'
export const UPLOAD_SECRET_NAMES: readonly RegExp[]; // /^\.netrc$/, /^\.npmrc$/, /^\.pypirc$/, /^\.git-credentials$/, /^\.env(\..+)?$/, /^id_(rsa|ed25519|ecdsa|dsa)$/
export function secretUploadPath(real: string, home: string): boolean; // решение владельца 4; без учёта регистра, по сегментам
export function withNavigation<T>(contents: WebContents, run: () => Promise<T>, signal: AbortSignal): Promise<{ value: T; navigated: boolean; loaded: boolean }>;
```

## Фокус ревью

Случаи, которые спека подразумевает, а тесты задач легко пропускают. Под каждый — тест в задаче-владельце.

1. **Ввод агента не попадает в поле человека.** Человек печатает в поле Chat, агент делает `type` в поле страницы. Текст агента — только в странице, в поле Chat — только набранное человеком, фокус вернулся в поле Chat; ввод агента начался не раньше чем через 1 с тишины клавиатуры. Тесты: задача 9 (порядок «одолжить фокус → ввод», ни одной клавиши без подтверждения), задача 20 (окно ждёт `typingIdleMs`, возвращает фокус), задача 22 (E2E).
2. **`evaluate` не обходит паузу, Stop и выключатель.** На паузе и при выключенном доступе `sendAgentScript` не вызывается; Stop посреди долгого скрипта — `Runtime.terminateExecution`, агенту `access_denied` «paused by the human», результат не отдаётся; у занятой страницы — `human_busy`. Тесты: задачи 11, 19, 22. **Принятый риск:** таймеры и обработчики, которые скрипт агента оставил в странице, после Stop живут до перезагрузки страницы — это записано в спеке (задача 23).
3. **Куки и хранилище — только текущей страницы агента.** Куки другого адреса (например, сайта, открытого во вкладке человека) агент не получает: адрес берётся только из `contents.getURL()` его страницы, аргумента `url`/`domain` нет; страница чужого хозяина — `no_tab`, `cookies.get` не вызывается. Тесты: задачи 2 (схема без `url` и `domain`), 12, 19, 22.
4. **Загрузка файла не уходит мимо страницы агента.** `upload` в страницу чужого хозяина — `no_tab`, `DOM.setFileInputFiles` не вызывается; путь — абсолютный, существующий обычный файл (симлинк разворачивается `realpath`), не каталог, не из секретного места (решение владельца 4; проверка — по пути ПОСЛЕ `realpath`, симлинк из `/tmp` на `~/.ssh/id_ed25519` отклоняется), не больше `uploadBytes`, не больше `uploadFiles`; цель — `input[type=file]` (иначе `bad_request`); выбор файла, открытый действием, не показывает человеку диалог. Тесты: задачи 15, 17, 22.
5. **Секреты маскируются и на внешних сайтах.** На странице `http://example.test/…` (не loopback) `?token=` в URL, `Authorization` в сети, JWT в консоли и значение поля «API key» в дереве доступности приходят агенту как `<redacted>`. Тесты: задачи 7, 15, 22 (E2E через `--host-resolver-rules`).
6. **Скачивания не путаются.** Скачивание по клику агента — в папку сессии без диалога, путь — в заметке действия и в `browser_downloads`; скачивание по клику человека на той же странице вне окна агента — диалог человека, как раньше; файл больше 200 МБ отменён с заметкой. Тесты: задачи 10, 15, 22.
7. **Stop посреди операции и устаревшая ссылка.** Stop во время `wait_for` или между шагами `drag` — следующего шага ввода нет, очередь свободна, агенту `access_denied`; ссылка из снимка прежнего документа — `stale_ref`, клика по чужому элементу нет. Тесты: задачи 15, 16, 17, 22.

## Ветки спайка

Задача 1 заполняет столбец «Итог» и, если итог не «по умолчанию», правит названные задачи этого плана (тем же коммитом).

| № | Вопрос | По умолчанию (план написан так) | Иначе | Что меняется | Итог |
|---|---|---|---|---|---|
| В1 | CDP `Input.insertText` и `Input.dispatchKeyEvent` гостю, когда фокус — у `<textarea>` окна (окно в фокусе и не в фокусе) | символы уходят в `<textarea>` окна или никуда (замер Orca; этап 0: без фокуса гостя клавиатура не доходит) | доходят в поле гостя | 9: `borrowFocus` не нужен; 5, 20: `focus` в `AgentActivity` и обработка в окне не делаются | |
| В2 | `guest.sendInputEvent` (WebContents самого гостя, не окна) — `keyDown`/`char`/`keyUp` при фокусе в `<textarea>` окна | так же, как В1 | доходит в поле гостя без фокуса | 9: клавиши и текст — `contents.sendInputEvent` (`char` на символ), `borrowFocus` не нужен; 5, 20 — как в В1 | |
| В3 | CDP `mousePressed` в гостя: переводит ли фокус окна на `<webview>` (`document.activeElement` окна) | да | нет | 9: мышь не одалживает фокус | |
| В4 | После возврата фокуса окну видит ли страница `blur` (поле теряет фокус, выпадающий список закрывается); убирает ли это `Emulation.setFocusEmulationEnabled` | да / да | blur не виден | 9: `setFocusEmulationEnabled` не ставится | |
| В5 | `Input.insertText` в управляемое поле React 18 при фокусе гостя | значение и `onChange` верны (этап 0) | нет | 9: `text` — посимвольно `keyDown` с `text` | |
| В6 | Множитель точки: эмуляция `scale` 0,6; мобильная при масштабе страницы 2 | `k = эмуляция ? (мобильная ? scale / zoom : scale) : 1` (этап 0) | другой | 9: `inputPoint` и его тест | |
| В7 | `DOMStorage.getDOMStorageItems` / `setDOMStorageItem` / `removeDOMStorageItem` / `clear` на Electron 44: `storageId` | `{ securityOrigin: origin, isLocalStorage }` работает без `DOMStorage.enable` | нужен `storageKey: origin + '/'` или `enable` | 12: `storageIdOf` и тест | |
| В8 | `Page.setInterceptFileChooserDialog({ enabled: true })` и событие `Page.fileChooserOpened` у гостя `<webview>`; нативного диалога нет | работает | нет | 15: клик агента по `input[type=file]` — `bad_request` («use upload»); скилл — «не кликайте поле файла» | |
| В9 | `DOM.setFileInputFiles({ files, backendNodeId })`: файл в поле, `input`/`change` в странице | работает | нет | 17: `upload` — `unsupported` с причиной; спека — «загрузки файлов нет» | |
| В10 | `Runtime.evaluate` с `timeout` и `Runtime.terminateExecution` прерывают `while (true) {}`; после этого страница отвечает | да | нет | 11: только `terminateExecution` по своему таймеру (или наоборот) | |
| В11 | `will-download` раздела с `item.setSavePath(путь)` внутри события — без диалога, `done` с `completed` | да | диалог всё равно | 10: путь через `setSaveDialogOptions` + отмена — тогда скачивания агента `unsupported` | |
| В12 | Codex 0.16x: есть ли одобрение по инструменту MCP (`mcp_servers.<имя>.tools.<инструмент>.approval_mode` или похожее) — по документации, без запуска | не используем: Codex решает по аннотациям | есть | только запись в отчёт и в «Решения плана» для владельца; код не меняется | |
| В13 | `electron.launch({ args: [main, '--host-resolver-rules=MAP example.test 127.0.0.1'] })`: `http://example.test:<порт>/` открывает локальный сервер | да | нет | 22: внешний сайт в E2E — через `http://localhost.test` с той же подменой или пропуск теста с пометкой | |

---

## Задача 0. Влить `origin/feat/browser-external-open`

Ветка (2 коммита поверх 28253aec): `d95062e0` — `browser_open` открывает любой http(s) (`openableHref`), чтение остаётся только на loopback; `5b795c91` — правка комментариев. `git merge-tree` 2026-10-20 — без конфликтов.

**Файлы:**
- Изменяются слиянием: `packages/core/src/mcp/browser-tools.ts` (+ test), `packages/desktop/src/main/browser/agent-ops.ts` (+ test), `packages/desktop/src/shared/browser-types.ts`, `packages/desktop/e2e/browser-agent-open.spec.ts`

**Интерфейсы:**
- Отдаёт: `openableHref(raw: string): string | null` (экспорт `agent-ops.ts`; `loopbackHref` уходит); `CONTROL` с `openWorldHint: true` — его вернёт в `false` задача 4.

- [ ] **Шаг 1. Слить.**

```bash
cd /Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/browser-agent-control
git fetch origin
git merge --no-ff origin/feat/browser-external-open -m "Merge branch 'feat/browser-external-open' into feat/browser-agent-control" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Ожидается: слияние без конфликтов. Если конфликт всё же есть — оставить код `origin/master` и поверх него смысл ветки (открыть — любой http(s), учётные данные срезаны; читать — loopback), перечислить файлы в отчёте задачи.

- [ ] **Шаг 2. Собрать зависимости.** `pnpm install && pnpm --filter @parley/protocol build && pnpm --filter @parley/core build` → без ошибок.

- [ ] **Шаг 3. Тесты затронутых файлов.**
  - `pnpm --filter @parley/core test -- src/mcp/browser-tools.test.ts` → PASS
  - `pnpm --filter @parley/desktop test -- src/main/browser/agent-ops.test.ts` → PASS
  - `pnpm --filter @parley/protocol test -- src/browser-agent-contract.test.ts` → PASS

- [ ] **Шаг 4. E2E ветки.** `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop e2e -- e2e/browser-agent-open.spec.ts` → PASS. Красный тест сверить с известными флейками (раздел «Как работать»); новый красный — остановиться и сообщить.

Коммит — сам merge-коммит шага 1.

---

## Задача 1. Сверочный спайк: ввод в `<webview>`, хранилище, файлы, скрипты

Кода продукта нет. Итог — `docs/research/2026-10-20-browser-agent-control-spike.md` и заполненный столбец «Итог» раздела «Ветки спайка» с правками задач, если итог не по умолчанию.

**Файлы:**
- Создать: `docs/research/2026-10-20-browser-agent-control-spike.md`
- Изменить: этот план (столбец «Итог», тексты задач по веткам)
- Проба — вне репозитория: `/private/tmp/claude-501/<scratchpad>/stage-d-spike/` (`spike-d.cjs`, страницы, `package.json` `{"type":"commonjs"}`), Electron — `packages/desktop/node_modules/.bin/electron` из worktree, React 18 UMD — `packages/desktop/node_modules/react/umd/` и `react-dom/umd/`.

**Устройство пробы** (по образцу `spike-04*.cjs` этапа 0, `docs/research/2026-10-08-browser-stage0.md`, 0.4):
- окно `BrowserWindow` 1200×800 с `webPreferences: { webviewTag: true }`; страница окна — `<textarea id="chat">` сверху и `<webview id="w1" partition="persist:spike-d" src="about:blank">` под ней;
- локальный HTTP-сервер на 127.0.0.1 отдаёт страницу гостя: `<input id="plain">`; управляемое поле React 18 (`useState`, `onChange` пишет `window.__changes`); `<select>` из трёх; чекбокс; `<input type=file id="file" multiple>` с выводом имён; ссылка `download` на `/file.csv` (`Content-Disposition: attachment`); кнопка-счётчик; кнопка, запускающая `while (true) {}`; `localStorage`/`sessionStorage`;
- отладчик гостя — `webContents.fromId(id).debugger.attach('1.3')`, команды — `sendCommand`;
- каждый вопрос — 3 прогона; окно в фокусе (`win.focus()`) и не в фокусе (другое окно спереди) — где это сказано.

- [ ] **Шаг 1. В1–В6 (ввод).**
  - В1: `chat.focus()` в окне; `Input.insertText({ text: 'agent' })` и пара `Input.dispatchKeyEvent` `keyDown`/`keyUp` клавиши `a` гостю. Записать `chat.value` и значение поля гостя (поле гостя предварительно сфокусировано `DOM.focus`).
  - В2: то же через `guest.sendInputEvent({ type: 'keyDown', keyCode: 'a' })`, `{ type: 'char', keyCode: 'a' }`, `{ type: 'keyUp', keyCode: 'a' }`. Помнить: `sendInputEvent` окна-хозяина в гостя не маршрутизируется (проба 2026-10-20) — проверяется `sendInputEvent` самого гостя.
  - В3: `Input.dispatchMouseEvent` `mousePressed`/`mouseReleased` в центр кнопки гостя при фокусе в `chat`: `document.activeElement` окна до и после.
  - В4: рецепт «одолжить фокус»: окно запоминает `document.activeElement`, зовёт `w1.focus()`, main шлёт `insertText`, окно возвращает фокус `chat.focus()`. Записать: где текст, есть ли `blur` у поля гостя и у `window` гостя; повторить с `Emulation.setFocusEmulationEnabled({ enabled: true })`.
  - В5: `insertText` в управляемое поле React при фокусе гостя: `value` и `window.__changes`.
  - В6: эмуляция 1280×800 `scale` 0,6 и 375×812 мобильная при `setZoomLevel(2)`: попадание клика по множителю этапа 0.
- [ ] **Шаг 2. В7–В11 (возможности).** По одному вызову на пункт таблицы, 3 прогона; для В10 — после прерывания кнопка-счётчик кликается.
- [ ] **Шаг 3. В12** — по документации Codex (`developers.openai.com/codex`, `codex --help` без входа и без запросов к модели): ключ одобрения по инструменту MCP. Живой запуск Codex не делать.
- [ ] **Шаг 4. В13** — Playwright `_electron` в той же пробе или отдельный скрипт: `--host-resolver-rules` и загрузка `http://example.test:<порт>/`.
- [ ] **Шаг 5. Отчёт.** `docs/research/2026-10-20-browser-agent-control-spike.md`: машина, Electron, таблица «вопрос — доли прогонов — вывод», рецепт ввода, выбранная ветка по каждому В. Заполнить «Итог» в этом плане; для каждого итога «иначе» — внести правку из столбца «Что меняется» в тексты задач (интерфейсы и тесты).
- [ ] **Шаг 6. Коммит.**

```bash
git add docs/research/2026-10-20-browser-agent-control-spike.md docs/specs/2026-10-20-browser-agent-control-plan.md
git commit -m "docs(browser): stage D spike — agent input focus, storage, files, scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 2. Протокол: операции, коды, пределы, схемы и формы ответов

**Файлы:**
- Изменить: `packages/protocol/src/browser-agent.ts`, `packages/protocol/src/index.ts`
- Тест: `packages/protocol/src/browser-agent.test.ts` (поправить и дописать); создать `packages/desktop/src/shared/agent-limits.test.ts`

**Интерфейсы:**
- Берёт: файл как есть после задачи 0.
- Отдаёт: всё из «Общих имён → Протокол»; `browserAgentArgs` для 14 операций.

- [ ] **Шаг 1. Поправить тесты и написать падающие.** В `browser-agent.test.ts`:
  - тест операций: `expect(BROWSER_AGENT_OPS).toEqual(['tabs', 'console', 'network', 'screenshot', 'open', 'navigate', 'snapshot', 'action', 'wait_for', 'resize', 'evaluate', 'cookies', 'storage', 'downloads'])`;
  - тест кодов: одиннадцать, прежние девять и `human_busy`, `stale_ref`;
  - тест пределов: `AGENT_LIMITS` — объект из «Общих имён» целиком через `toEqual`; `AGENT_INPUT` — `{ url: 4096, room: 64, pattern: 200, requestId: 200, key: 32, scroll: 10_000, option: 1024, path: 4096, cookieName: 256, cookieValue: 4096, storageKey: 1024 }`; `AGENT_DEFAULTS` — с `interactiveOnly: false, values: false`;
  - в тесте `screenshot` строку `{ tab: 't1', ref: 'e1' }` убрать из «плохих» (теперь можно);
  - тест типов: `BrowserAgentOpenResult` с `loaded: boolean; title: string`.
  - в конец файла:

```ts
describe('операции управления (этап D)', () => {
  const ok = (op: keyof typeof browserAgentArgs, args: unknown): boolean => browserAgentArgs[op].safeParse(args).success;
  const bad = (op: keyof typeof browserAgentArgs, list: unknown[]): void => {
    for (const args of list) expect(ok(op, args), JSON.stringify(args).slice(0, 80)).toBe(false);
  };

  it('списки действий, модификаторов, пресетов, действий кук и хранилища', () => {
    expect(AGENT_ACTIONS).toEqual(['click', 'double_click', 'hover', 'type', 'press', 'scroll', 'select', 'check', 'uncheck', 'drag', 'upload']);
    expect(AGENT_MODIFIERS).toEqual(['Alt', 'Control', 'Meta', 'Shift']);
    expect(AGENT_VIEWPORT_PRESETS).toEqual(['mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'desktop']);
    expect(AGENT_COOKIE_ACTIONS).toEqual(['list', 'set', 'delete']);
    expect(AGENT_STORAGE_ACTIONS).toEqual(['list', 'get', 'set', 'delete', 'clear']);
  });

  it('navigate: ровно одно из url, back, forward, reload; hard — только с reload', () => {
    for (const args of [{ tab: 't1', url: '/settings' }, { tab: 't1', url: 'https://example.com/' }, { tab: 't1', back: true }, { tab: 't1', forward: true }, { tab: 't1', reload: true, hard: true }]) {
      expect(ok('navigate', args), JSON.stringify(args)).toBe(true);
    }
    bad('navigate', [{ tab: 't1' }, { tab: 't1', url: '/a', back: true }, { tab: 't1', back: false }, { tab: 't1', url: '/a', hard: true }, { url: '/a' }, { tab: 't1', url: `/${'x'.repeat(4096)}` }]);
  });

  it('snapshot: interactiveOnly — boolean', () => {
    expect(ok('snapshot', { tab: 't1' })).toBe(true);
    expect(ok('snapshot', { tab: 't1', interactiveOnly: true })).toBe(true);
    bad('snapshot', [{ tab: 't1', interactiveOnly: 'yes' }, { tab: 't1', ref: 'e1' }]);
  });

  it('action: цель, текст, клавиша, прокрутка, выбор, перетаскивание, файлы', () => {
    for (const args of [
      { tab: 't1', action: 'click', ref: 'e12' },
      { tab: 't1', action: 'double_click', x: 10.5, y: 20 },
      { tab: 't1', action: 'type', text: 'hello', submit: true },
      { tab: 't1', action: 'type', ref: 'e3', text: 'hello' },
      { tab: 't1', action: 'press', key: 'a', modifiers: ['Meta'] },
      { tab: 't1', action: 'scroll', direction: 'down', amount: 400 },
      { tab: 't1', action: 'select', ref: 'e4', value: 'Blue' },
      { tab: 't1', action: 'check', ref: 'e5' },
      { tab: 't1', action: 'uncheck', ref: 'e5' },
      { tab: 't1', action: 'drag', ref: 'e6', toRef: 'e7' },
      { tab: 't1', action: 'drag', x: 1, y: 2, toX: 300, toY: 2 },
      { tab: 't1', action: 'upload', ref: 'e8', files: ['/tmp/a.png'] },
    ]) {
      expect(ok('action', args), JSON.stringify(args)).toBe(true);
    }
    bad('action', [
      { tab: 't1', action: 'click' },
      { tab: 't1', action: 'click', x: 10 },
      { tab: 't1', action: 'click', ref: 'e1', x: 1, y: 2 },
      { tab: 't1', action: 'click', ref: 'button' },
      { tab: 't1', action: 'type' },
      { tab: 't1', action: 'press' },
      { tab: 't1', action: 'scroll' },
      { tab: 't1', action: 'select', ref: 'e4' },
      { tab: 't1', action: 'select', value: 'Blue' },
      { tab: 't1', action: 'check' },
      { tab: 't1', action: 'drag', ref: 'e6' },
      { tab: 't1', action: 'drag', ref: 'e6', toX: 1 },
      { tab: 't1', action: 'upload', ref: 'e8' },
      { tab: 't1', action: 'upload', files: ['/tmp/a.png'] },
      { tab: 't1', action: 'upload', ref: 'e8', files: [] },
      { tab: 't1', action: 'upload', ref: 'e8', files: Array.from({ length: 11 }, (_, i) => `/tmp/${i}`) },
      { tab: 't1', action: 'upload', ref: 'e8', files: ['relative/a.png'] },
      { tab: 't1', action: 'evaluate', ref: 'e1' },
      { tab: 't1', action: 'press', key: 'a', modifiers: ['Hyper'] },
      { tab: 't1', action: 'type', text: 'x'.repeat(10_001) },
      { tab: 't1', action: 'click', x: -1, y: 0 },
      { tab: 't1', action: 'scroll', direction: 'down', amount: 0 },
    ]);
  });

  it('wait_for: ровно одно из text, gone, ms; ms до 10 000', () => {
    for (const args of [{ tab: 't1', text: 'Saved' }, { tab: 't1', gone: 'Loading' }, { tab: 't1', ms: 10_000 }]) expect(ok('wait_for', args)).toBe(true);
    bad('wait_for', [{ tab: 't1' }, { tab: 't1', text: 'a', ms: 5 }, { tab: 't1', ms: 10_001 }, { tab: 't1', text: '' }]);
  });

  it('resize: пресет (rotated — только с ним), width и height вместе, или fit', () => {
    for (const args of [{ tab: 't1', preset: 'mobile-m' }, { tab: 't1', preset: 'tablet', rotated: true }, { tab: 't1', width: 500, height: 700 }, { tab: 't1', fit: true }]) {
      expect(ok('resize', args), JSON.stringify(args)).toBe(true);
    }
    bad('resize', [{ tab: 't1' }, { tab: 't1', preset: 'phone' }, { tab: 't1', width: 500 }, { tab: 't1', preset: 'laptop', fit: true }, { tab: 't1', width: 500, height: 700, rotated: true }, { tab: 't1', width: 199, height: 700 }]);
  });

  it('screenshot: ref — снимок элемента; ref вместе с fullPage — отказ', () => {
    expect(ok('screenshot', { tab: 't1', ref: 'e4' })).toBe(true);
    expect(ok('screenshot', { tab: 't1', ref: 'e4', width: 375, height: 812 })).toBe(true);
    bad('screenshot', [{ tab: 't1', ref: 'e4', fullPage: true }]);
  });

  it('evaluate: ровно одно из expression и function; ref — только с function', () => {
    for (const args of [{ tab: 't1', expression: 'document.title' }, { tab: 't1', function: '() => 1' }, { tab: 't1', function: '(el) => el.value', ref: 'e3' }]) {
      expect(ok('evaluate', args), JSON.stringify(args)).toBe(true);
    }
    bad('evaluate', [{ tab: 't1' }, { tab: 't1', expression: '1', function: '() => 1' }, { tab: 't1', expression: '1', ref: 'e3' }, { tab: 't1', expression: '' }, { tab: 't1', expression: 'x'.repeat(10_001) }]);
  });

  it('cookies: адрес и домен не принимаются — только страница агента (Фокус ревью 3)', () => {
    for (const args of [
      { tab: 't1', action: 'list' },
      { tab: 't1', action: 'list', values: true },
      { tab: 't1', action: 'set', name: 'theme', value: 'dark', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expires: 1_900_000_000 },
      { tab: 't1', action: 'delete', name: 'theme' },
    ]) {
      expect(ok('cookies', args), JSON.stringify(args)).toBe(true);
    }
    bad('cookies', [
      { tab: 't1', action: 'list', url: 'https://github.com/' },
      { tab: 't1', action: 'set', name: 'a', value: 'b', domain: '.github.com' },
      { tab: 't1', action: 'set', name: 'a' },
      { tab: 't1', action: 'delete' },
      { tab: 't1', action: 'delete', name: 'a', values: true },
      { tab: 't1', action: 'list', path: '/' },
      { tab: 't1', action: 'set', name: 'a', value: 'b', path: 'no-slash' },
      { tab: 't1', action: 'set', name: 'a', value: 'b', sameSite: 'none' },
    ]);
  });

  it('storage: area и действие; get и delete — с key, set — с key и value, list и clear — без них', () => {
    for (const args of [
      { tab: 't1', area: 'local', action: 'list' },
      { tab: 't1', area: 'session', action: 'get', key: 'token' },
      { tab: 't1', area: 'local', action: 'set', key: 'theme', value: '' },
      { tab: 't1', area: 'local', action: 'delete', key: 'theme' },
      { tab: 't1', area: 'local', action: 'clear' },
    ]) {
      expect(ok('storage', args), JSON.stringify(args)).toBe(true);
    }
    bad('storage', [{ tab: 't1', action: 'list' }, { tab: 't1', area: 'indexeddb', action: 'list' }, { tab: 't1', area: 'local', action: 'get' }, { tab: 't1', area: 'local', action: 'set', key: 'a' }, { tab: 't1', area: 'local', action: 'clear', key: 'a' }, { tab: 't1', area: 'local', action: 'list', origin: 'https://github.com' }]);
  });

  it('downloads — пустой объект', () => {
    expect(ok('downloads', {})).toBe(true);
    bad('downloads', [{ tab: 't1' }]);
  });

  it('запрос агента принимает все операции этапа D', () => {
    for (const op of ['navigate', 'snapshot', 'action', 'wait_for', 'resize', 'evaluate', 'cookies', 'storage', 'downloads']) {
      expect(browserAgentRequest.safeParse({ op, args: {} }).success, op).toBe(true);
    }
  });
});
```

  Создать `packages/desktop/src/shared/agent-limits.test.ts` — как в старом плане, задача 2, шаг 1 (три теста: `AGENT_VIEWPORT` = пределы Custom `DEVTOOLS_LIMITS`; `AGENT_VIEWPORT_PRESETS` = `Object.keys(VIEWPORT_PRESETS)`; `AGENT_INPUT.url` = `DEVTOOLS_LIMITS.url`), импорт из `@parley/protocol`.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/protocol test -- src/browser-agent.test.ts` → FAIL (`AGENT_ACTIONS` не экспортирован, операций пять).

- [ ] **Шаг 3. Реализовать в `browser-agent.ts`.** Константы и типы — из «Общих имён» дословно (комментарии к ключам `AGENT_LIMITS` — в стиле файла, одной строкой на ключ). Комментарий модуля: «Этапы C и D: чтение и управление; JS агента, куки и хранилище, файлы — решение владельца 2026-10-20». Схемы — `z.strictObject` и `.refine`:
  - общие: `const ref = z.string().regex(/^e\d{1,6}$/)`, `const absolutePath = z.string().min(1).max(AGENT_INPUT.path).regex(/^\//)`, `const exactlyOne = (values: readonly unknown[]): boolean => values.filter((v) => v !== undefined).length === 1`;
  - `navigate`, `snapshot`, `wait_for`, `resize`, `screenshot` (+ `ref`) — как в старом плане, задача 2, шаг 3, с `url: z.string().min(1).max(AGENT_INPUT.url)`;
  - `action`: поля `tab, action: z.enum(AGENT_ACTIONS), ref?, x?, y?` (`z.number().min(0).max(AGENT_VIEWPORT.maxWidth | maxHeight)`), `text?` (1..`AGENT_LIMITS.text`), `key?` (1..`AGENT_INPUT.key`), `modifiers?` (`z.array(z.enum(AGENT_MODIFIERS)).max(4)`), `submit?`, `direction?` (`up|down|left|right`), `amount?` (`int`, 1..`AGENT_INPUT.scroll`), `value?` (1..`AGENT_INPUT.option`), `toRef?`, `toX?`, `toY?`, `files?` (`z.array(absolutePath).min(1).max(AGENT_LIMITS.uploadFiles)`); правила: `x` и `y` вместе, `toX` и `toY` вместе; `ref` или точка, не оба; `click`/`double_click`/`hover`/`drag` — нужна цель; `drag` — нужна вторая цель (`toRef` или `toX,toY`); `type` — `text`; `press` — `key`; `scroll` — `direction`; `select` — `ref` и `value`; `check`/`uncheck`/`upload` — `ref`; `upload` — `files`, а `files` — только с `upload`;
  - `evaluate`: `tab, expression?, function?` (1..`AGENT_LIMITS.text`), `ref?`; ровно одно из `expression`/`function`; `ref` — только с `function`;
  - `cookies`: `tab, action: z.enum(AGENT_COOKIE_ACTIONS), name?` (1..`cookieName`), `value?` (0..`cookieValue`), `path?` (`/^\//`, до `AGENT_INPUT.url`), `secure?`, `httpOnly?`, `sameSite?: z.enum(['lax', 'strict', 'no_restriction'])`, `expires?: z.number().int().min(0)`, `values?: boolean`; `set` — `name` и `value`; `delete` — `name`; `values` — только с `list`; `path`/`secure`/`httpOnly`/`sameSite`/`expires` — только с `set`;
  - `storage`: `tab, area: z.enum(['local', 'session']), action: z.enum(AGENT_STORAGE_ACTIONS), key?` (1..`storageKey`), `value?` (0..`AGENT_LIMITS.text`); `get`/`delete` — `key`; `set` — `key` и `value`; `list`/`clear` — без `key` и `value`;
  - `downloads`: `z.strictObject({})`.
  В `index.ts` — новые значения и типы в блоки экспорта `./browser-agent.js` по алфавиту.

- [ ] **Шаг 4. Запустить — проходит.**
  - `pnpm --filter @parley/protocol test -- src/browser-agent.test.ts` → PASS; `pnpm --filter @parley/protocol build` → без ошибок.
  - `pnpm --filter @parley/desktop test -- src/shared/agent-limits.test.ts` → PASS (3).
  - `src/browser-agent-contract.test.ts` протокола и `host/src/agent/browser-contract.test.ts` красные до задачи 4 (у core пять инструментов) — ожидаемо.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/protocol/src/browser-agent.ts packages/protocol/src/browser-agent.test.ts packages/protocol/src/index.ts packages/desktop/src/shared/agent-limits.test.ts
git commit -m "feat(protocol): browser control operations — navigate, snapshot, action, wait_for, resize, evaluate, cookies, storage, downloads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 3. Core: инструменты действий и ответы на них

**Файлы:**
- Изменить: `packages/core/src/mcp/browser-tools.ts`
- Тест: `packages/core/src/mcp/browser-tools.test.ts`

**Интерфейсы:**
- Берёт: схемы задачи 2 (сверяет контрактный тест протокола).
- Отдаёт: инструменты `browser_navigate`, `browser_snapshot`, `browser_action`, `browser_wait_for`, `browser_resize`; `ref` у `browser_screenshot`; ответы `open` с `loaded` и `title`; `BROWSER_TOOL_OPS` — десять (после `open`: `navigate`, `snapshot`, `action`, `wait_for`, `resize`); `BROWSER_TOOL_LIMITS` + `loadMs`, `waitMs`, `text`, `snapshotBytes`; подсказки `human_busy`, `stale_ref`, `not_loopback`.

- [ ] **Шаг 1. Падающие тесты.** В `browser-tools.test.ts` (есть `startEndpoint`, `connect`, `call`, очередь `answers`):

```ts
describe('инструменты действий (этап D)', () => {
  it('объявлены по порядку операций; схемы строгие; описания по-английски и не длиннее 900 знаков', async () => {
    const client = await connect(await startEndpoint());
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith('browser_'));
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOL_OPS.map((op) => `browser_${op}`));
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toMatch(/[А-Яа-яЁё]/);
      expect(tool.description?.length ?? 0, tool.name).toBeLessThanOrEqual(900);
      expect(tool.inputSchema, tool.name).toMatchObject({ additionalProperties: false });
    }
  });

  it('описания называют то, что агенту нужно знать', () => {
    const d = (name: string): string => BROWSER_TOOLS.find((tool) => tool.name === name)?.description ?? '';
    for (const phrase of ['any http(s) URL', 'back', 'forward', 'reload', '15 s']) expect(d('browser_navigate'), phrase).toContain(phrase);
    for (const phrase of ['[ref=e12] button "Save"', 'until the page navigates', 'interactiveOnly', '50 KB', 'masked']) expect(d('browser_snapshot'), phrase).toContain(phrase);
    for (const phrase of ['click', 'double_click', 'hover', 'type', 'press', 'scroll', 'select', 'check', 'drag', 'upload', 'ref from browser_snapshot', 'human_busy']) expect(d('browser_action'), phrase).toContain(phrase);
    for (const phrase of ['10 s', 'gone']) expect(d('browser_wait_for'), phrase).toContain(phrase);
    for (const phrase of ['for you and the human', 'mobile-m 375×812', 'fit']) expect(d('browser_resize'), phrase).toContain(phrase);
    expect(d('browser_screenshot')).toContain('With ref: only that element');
    // Чтение больше не ограничено localhost: старые фразы ушли.
    for (const name of ['browser_tabs', 'browser_open']) expect(d(name), name).not.toMatch(/only pages on localhost/i);
  });

  it('snapshot — текст в ограде данных и число ссылок; обрезанный — совет', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost:5173/', text: '[ref=e1] button "Save"', refs: 1, truncated: true } } });
    const result = await call(client, 'browser_snapshot', { tab: 't1' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('1 refs');
    expect(result.text).toContain('interactiveOnly');
    expect(result.text).toContain(`${PAGE_DATA_NOTE}\n\n\`\`\`text\nPage: http://localhost:5173/\n[ref=e1] button "Save"\n\`\`\``);
  });

  it('action — что сделано, адрес в ограде, переход — совет снять снимок заново, заметки строками Note:', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost:5173/next', done: 'Clicked e2.', navigated: true, notes: ['The page started a download: report.csv.'] } } });
    const result = await call(client, 'browser_action', { tab: 't1', action: 'click', ref: 'e2' });
    expect(result.text.startsWith('Clicked e2.')).toBe(true);
    expect(result.text).toContain('old refs are stale');
    expect(result.text).toContain('\nNote: The page started a download: report.csv.');
    expect(result.text).toContain('Page: http://localhost:5173/next');
  });

  it('wait_for: timeout — не ошибка; navigate: не дождался загрузки — пояснение; resize и open с loaded', async () => {
    const client = await connect(await startEndpoint());
    answers.push(
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost/', outcome: 'timeout', ms: 10_000 } } },
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'https://example.com/', title: 'Example', loaded: false, notes: [] } } },
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost/', viewport: { width: 375, height: 812, emulated: true } } } },
      { status: 200, body: { ok: true, result: { tab: 't2', owner: { kind: 'session', sessionId: 's-02' }, url: 'https://example.com/', reused: false, loaded: true, title: 'Example', notes: [] } } },
    );
    const waited = await call(client, 'browser_wait_for', { tab: 't1', text: 'Saved' });
    expect(waited.isError).toBe(false);
    expect(waited.text).toContain('did not appear');
    expect((await call(client, 'browser_navigate', { tab: 't1', url: 'https://example.com/' })).text).toContain('still loading');
    expect((await call(client, 'browser_resize', { tab: 't1', preset: 'mobile-m' })).text).toContain('375×812');
    const opened = await call(client, 'browser_open', { url: 'https://example.com/' });
    expect(opened.text).toContain('loaded');
    expect(opened.text).not.toContain('does not wait for it');
  });

  it('подсказки к human_busy и stale_ref', async () => {
    const client = await connect(await startEndpoint());
    answers.push(
      { status: 200, body: { ok: false, error: { code: 'human_busy', message: 'The human is annotating page t1.' } } },
      { status: 200, body: { ok: false, error: { code: 'stale_ref', message: 'Ref e4 is from an older snapshot.' } } },
    );
    expect((await call(client, 'browser_action', { tab: 't1', action: 'click', ref: 'e4' })).text).toContain('wait');
    expect((await call(client, 'browser_action', { tab: 't1', action: 'click', ref: 'e4' })).text).toContain('browser_snapshot');
  });
});
```

  Поправить существующие тесты слитой ветки: фраза «Only pages on localhost … can be read» уходит из описаний `browser_open` и `browser_tabs`; `browser_tabs` говорит «Any http(s) page can be opened and read».

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/core test -- src/mcp/browser-tools.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - Описания — английские, с фразами из теста; общий смысл — таблица инструментов старого плана, задача 4 («Tools»), без «only localhost».
  - JSON-схемы — те же ограничения, что zod задачи 2 (`type`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `enum`), `required: ['tab']` (у `action` — `['tab', 'action']`), `additionalProperties: false`; у `interactiveOnly` — `default: false`.
  - Ответы: `formatNavigate` (`loaded` — «Loaded …», иначе «… is still loading (waited 15 s)»; адрес и заголовок — в `pageData`), `formatSnapshot` (`Accessibility snapshot of t1: N refs. Refs work until the page navigates.` + при `truncated` — совет `interactiveOnly`; текст — `pageData('Page: <url>\n<text>')`), `formatAction` (`done`, при `navigated` — «The page navigated: old refs are stale, take a new browser_snapshot.», `Note:`-строки, `pageData('Page: <url>')`), `formatWait` (`found`, `gone`, `waited`, `timeout` — «… did not appear …» / «… is still there …»), `formatResize`, `formatOpen` (`loaded: true` — «Opened t2 … and it loaded», иначе прежний текст про фон и загрузку; заголовок — в `pageData`). Формы ответов — копии типов протокола в объёме форматирования.
  - `BROWSER_TOOL_HINTS`: `human_busy: 'The human is selecting or annotating in that page: wait a little and retry, or ask the human.'`, `stale_ref: 'Take a new browser_snapshot and use its refs.'`, `not_loopback: "An older Parley window answered: ask the human to update Parley."`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS. `pnpm --filter @parley/core build`. Контрактные тесты протокола и хоста — красные до задачи 4.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/core/src/mcp/browser-tools.ts packages/core/src/mcp/browser-tools.test.ts
git commit -m "feat(core): browser control tools — navigate, snapshot, action, wait_for, resize, element screenshots" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 4. Core: `evaluate`, `cookies`, `storage`, `downloads`; аннотации и заранее разрешённые инструменты

**Файлы:**
- Изменить: `packages/core/src/mcp/browser-tools.ts`, `packages/core/src/work/settings-file.ts`, `packages/core/src/index.ts`
- Тесты: `packages/core/src/mcp/browser-tools.test.ts`, `packages/core/src/work/settings-file.test.ts`

**Интерфейсы:**
- Берёт: задачу 3.
- Отдаёт: `browser_evaluate`, `browser_cookies`, `browser_storage`, `browser_downloads`; `BROWSER_TOOL_OPS` — все 14; `BROWSER_TOOLS_ASK`; `BROWSER_TOOL_LIMITS` + `evalMs`, `evalBytes`, `uploadFiles`, `downloads`; аннотации READ / CONTROL / SCRIPT (раздел «Решения плана»); `BROWSER_PERMISSIONS` без `browser_evaluate`.

- [ ] **Шаг 1. Падающие тесты.**

```ts
// browser-tools.test.ts
describe('скрипт, куки, хранилище, скачивания; аннотации (решения владельца 2026-10-20)', () => {
  const tool = (name: string) => BROWSER_TOOLS.find((candidate) => candidate.name === name);

  it('аннотации: только browser_evaluate заставит Codex спросить человека', () => {
    const READ = { readOnlyHint: true, openWorldHint: false };
    const CONTROL = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const SCRIPT = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
    const expected: Record<string, object> = {
      browser_tabs: READ, browser_console: READ, browser_network: READ, browser_screenshot: READ, browser_snapshot: READ, browser_wait_for: READ, browser_downloads: READ,
      browser_open: CONTROL, browser_navigate: CONTROL, browser_action: CONTROL, browser_resize: CONTROL, browser_cookies: CONTROL, browser_storage: CONTROL,
      browser_evaluate: SCRIPT,
    };
    expect(Object.fromEntries(BROWSER_TOOLS.map((t) => [t.name, t.annotations]))).toEqual(expected);
    expect([...BROWSER_TOOLS_ASK]).toEqual(['evaluate']);
  });

  it('описания: главный мир и пределы evaluate; общий раздел кук; скрытые значения; папка скачиваний', () => {
    for (const phrase of ["page's main world", 'JSON', '20 KB', '10 s', 'first argument', 'approves']) expect(tool('browser_evaluate')?.description, phrase).toContain(phrase);
    for (const phrase of ["page's current URL", 'httpOnly', 'shared with the human', 'sign the human out', 'values: true']) expect(tool('browser_cookies')?.description, phrase).toContain(phrase);
    for (const phrase of ['localStorage', 'sessionStorage', "page's current origin"]) expect(tool('browser_storage')?.description, phrase).toContain(phrase);
    for (const phrase of ['folder of this session', 'file path']) expect(tool('browser_downloads')?.description, phrase).toContain(phrase);
  });

  it('evaluate: значение — в ограде с типом; исключение — ответ, а не ошибка инструмента', async () => {
    const client = await connect(await startEndpoint());
    answers.push(
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost/', outcome: 'value', text: '{"user":"ann"}', type: 'object', truncated: false } } },
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost/', outcome: 'exception', text: 'ReferenceError: foo is not defined', type: 'exception', truncated: false } } },
    );
    const value = await call(client, 'browser_evaluate', { tab: 't1', expression: 'window.__state' });
    expect(value.isError).toBe(false);
    expect(value.text).toContain('(object)');
    expect(value.text).toContain('```text\n{"user":"ann"}\n```');
    const thrown = await call(client, 'browser_evaluate', { tab: 't1', expression: 'foo' });
    expect(thrown.isError).toBe(false);
    expect(thrown.text).toContain('The script threw');
  });

  it('cookies: без значений — совет values: true; со значениями — запрет повторять секреты', async () => {
    const client = await connect(await startEndpoint());
    const cookie = { name: 'sid', domain: 'localhost', path: '/', secure: false, httpOnly: true, sameSite: 'lax', session: true, expires: null, size: 35 };
    answers.push(
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost/', cookies: [cookie], notes: [] } } },
      { status: 200, body: { ok: true, result: { tab: 't1', url: 'http://localhost/', cookies: [{ ...cookie, value: 'S3CR3T' }], notes: [] } } },
    );
    expect((await call(client, 'browser_cookies', { tab: 't1', action: 'list' })).text).toContain('values: true');
    const shown = await call(client, 'browser_cookies', { tab: 't1', action: 'list', values: true });
    expect(shown.text).toContain('sid=S3CR3T');
    expect(shown.text).toContain('never repeat them');
  });

  it('storage и downloads: списки в ограде; пустой список скачиваний называет папку', async () => {
    const client = await connect(await startEndpoint());
    answers.push(
      { status: 200, body: { ok: true, result: { tab: 't1', origin: 'http://localhost:5173', area: 'local', entries: [{ key: 'theme', value: 'dark', size: 9 }], total: 1, notes: [] } } },
      { status: 200, body: { ok: true, result: { dir: '/h/.parley/desktop/agent-downloads/abc/s-02', downloads: [], notes: [] } } },
    );
    expect((await call(client, 'browser_storage', { tab: 't1', area: 'local', action: 'list' })).text).toContain('theme = dark');
    expect((await call(client, 'browser_downloads', {})).text).toContain('/h/.parley/desktop/agent-downloads/abc/s-02');
  });
});
```

```ts
// settings-file.test.ts — заменить блок «инструменты браузера разрешены заранее»
describe('инструменты браузера разрешены заранее, кроме browser_evaluate (решение владельца 2026-10-20)', () => {
  const ALLOWED = ['tabs', 'console', 'network', 'screenshot', 'open', 'navigate', 'snapshot', 'action', 'wait_for', 'resize', 'cookies', 'storage', 'downloads'].map((op) => `mcp__parley__browser_${op}`);

  it('с каналом агента — тринадцать правил, browser_evaluate среди них нет; без канала — поля нет', () => {
    expect(workSettings({ allowBrowser: true }).permissions).toEqual({ allow: ALLOWED });
    expect(JSON.stringify(workSettings({ allowBrowser: true }))).not.toContain('browser_evaluate');
    expect(workSettings({ allowBrowser: false })).not.toHaveProperty('permissions');
  });

  it('имена правил собраны из настоящих имён сервера и инструментов', () => {
    expect(BROWSER_PERMISSIONS).toEqual(BROWSER_TOOLS.filter((tool) => tool.name !== 'browser_evaluate').map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`));
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/core test -- src/mcp/browser-tools.test.ts src/work/settings-file.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - Аннотации — три константы `READ`, `CONTROL`, `SCRIPT` с комментарием: «политика одобрений Parley (решение владельца 2026-10-20): заранее разрешено всё, кроме `browser_evaluate`; у Claude Code — `permissions.allow`, у Codex — эти аннотации. `openWorldHint: false` у CONTROL — сознательно: инструмент водит панель браузера Parley, которую видит и может приостановить человек».
  - `BROWSER_TOOLS_ASK = ['evaluate'] as const`; в `settings-file.ts`: `BROWSER_PERMISSIONS = BROWSER_TOOL_OPS.filter((op) => !(BROWSER_TOOLS_ASK as readonly string[]).includes(op)).map(…)`; экспорт `BROWSER_TOOLS_ASK` из `core/src/index.ts`.
  - Описания: `browser_evaluate` — «Run JavaScript in the page's main world (the page's own scripts see the same globals) and get the result as JSON, up to 20 KB. expression: an expression or a promise; function: a function source, called with the element of ref as its first argument when ref is given. An exception thrown by the page comes back as the answer. Stops after 10 s. The human approves this tool.»; `browser_cookies` — фразы теста, «list hides values unless values: true»; `browser_storage`, `browser_downloads` — фразы теста.
  - Ответы: `formatEvaluate` (`Script result in t1 (<type>…):` / `The script threw in t1:` + `pageData(text)`; при `truncated` — «cut at 20 KB»), `formatCookies` (строка куки: `name[=value]  domain=… path=…[ secure][ httpOnly] sameSite=… session|expires=…  (N B)`; без значений — «Values are hidden: pass values: true to read them.»; со значениями — «Values are secrets of the human's browser session: never repeat them in replies, files or commits.»; `done` — как есть), `formatStorage` (список `key = value`, `get` — значение в ограде или «(no such key)», `done`), `formatDownloads` (строка: `id  state  name  received/total B  path  from url[ (page tN)]`; пусто — «No downloads yet in this session. Files that your pages download go to <dir>.»).

- [ ] **Шаг 4. Запустить — проходит.**
  - те же тесты → PASS; `pnpm --filter @parley/core build`;
  - `pnpm --filter @parley/protocol test -- src/browser-agent-contract.test.ts` → PASS (схемы, умолчания, ключи подсказок);
  - `pnpm --filter @parley/host test -- src/agent/browser-contract.test.ts` → PASS (операции и пределы).

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/core/src/mcp/browser-tools.ts packages/core/src/mcp/browser-tools.test.ts packages/core/src/work/settings-file.ts packages/core/src/work/settings-file.test.ts packages/core/src/index.ts
git commit -m "feat(core): browser_evaluate, browser_cookies, browser_storage, browser_downloads; pre-allow every browser tool except evaluate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 5. Окно: типы моста, каналы IPC, заглушки (‖ с 2–4)

**Файлы:**
- Изменить: `packages/desktop/src/shared/browser-types.ts`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/renderer/test-utils/fake-bridge.ts`, `packages/desktop/src/main/browser/agent-ops.ts` (только методы-заглушки `stop`, `focusReady`)
- Тесты: `packages/desktop/src/main/ipc.test.ts`, `packages/desktop/src/preload/index.test.ts`, `packages/desktop/src/renderer/test-utils/fake-bridge.test.ts`

**Интерфейсы:**
- Отдаёт: «Общие имена → Окно: типы и мост»; `parseAgentRegistration` переносит `humanBusy` (нет — `false`, не boolean — запись отклонена); каналы `browser:agent-stop` (`webContentsId` — целое, иначе отказ), `browser:agent-focus-ready` (`id` — строка до 64); событие `browser:agent-resize`; `FakeBridge.emitAgentResize(e)`; заглушки `AgentOps.stop`, `AgentOps.focusReady` (пустые, с комментарием «задача 15»).
- Если спайк выбрал В1/В2 «доходит без фокуса» — `focus` в `AgentActivity` и канал `browser:agent-focus-ready` не заводятся (правку вносит задача 1).

- [ ] **Шаг 1. Падающие тесты.**

```ts
// ipc.test.ts
describe('реестр страниц агента: humanBusy (этап D)', () => {
  const page = { kind: 'page', generation: 'g1', webContentsId: 7, workKey: '/p w-1', owner: { kind: 'session', sessionId: 's-02' }, pageId: 'bp-aaaaaa', visible: true };
  it('humanBusy переносится; нет поля — false; не boolean — запись отклонена', () => {
    expect(parseAgentRegistration({ ...page, humanBusy: true })).toMatchObject({ kind: 'page', humanBusy: true });
    expect(parseAgentRegistration(page)).toMatchObject({ kind: 'page', humanBusy: false });
    expect(parseAgentRegistration({ ...page, humanBusy: 'yes' })).toBeNull();
  });
});

describe('каналы Stop и фокуса агента', () => {
  it('browser:agent-stop зовёт agent.stop с целым id; иначе отказ без вызова', async () => {
    // как соседние тесты registerTab: registerIpc с fake ipcMain и browser.agent = { …, stop: vi.fn(), focusReady: vi.fn() }
    await invoke('browser:agent-stop', 7);
    expect(agent.stop).toHaveBeenCalledWith(7);
    await expect(invoke('browser:agent-stop', '7')).rejects.toThrow();
    expect(agent.stop).toHaveBeenCalledTimes(1);
  });
  it('browser:agent-focus-ready зовёт agent.focusReady со строкой до 64 знаков', async () => {
    await invoke('browser:agent-focus-ready', 'f-1');
    expect(agent.focusReady).toHaveBeenCalledWith('f-1');
    await expect(invoke('browser:agent-focus-ready', 'x'.repeat(65))).rejects.toThrow();
  });
});
```

  В `preload/index.test.ts` — по образцу `agentCaptureReady`: `agentStop(7)` → `ipcRenderer.invoke('browser:agent-stop', 7)`, `agentFocusReady('f-1')` → `invoke('browser:agent-focus-ready', 'f-1')`, `onAgentResize` подписывается на `browser:agent-resize` и отписывается. В `fake-bridge.test.ts` — `emitAgentResize` доходит до слушателя `onAgentResize`, `agentStop` пишется в `browserCalls`.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/ipc.test.ts src/preload/index.test.ts src/renderer/test-utils/fake-bridge.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.** Типы — дословно из «Общих имён»; `phase` — `'start' | 'step' | 'end'`; IPC-обработчики — по образцу `browser:agent-capture-ready` (проверка гостя не нужна: main сам находит страницу по id). В `agent-ops.ts` у `AgentOps` — `stop(webContentsId: number): void` и `focusReady(id: string): void`, в `createAgentOps` — пустые тела с комментарием. `RegisterIpcOptions.browser.agent` — пять методов; `main/index.ts` уже передаёт `ops` целиком — проверить, что типы сходятся.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS. `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/shared/browser-types.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/ipc.test.ts packages/desktop/src/renderer/test-utils/fake-bridge.ts packages/desktop/src/renderer/test-utils/fake-bridge.test.ts packages/desktop/src/main/browser/agent-ops.ts
git commit -m "feat(desktop): bridge for agent control — human busy, agent resize, Stop and focus channels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 6. Инспектор: закрытый список этапа D, функции Parley, вход для скриптов агента (‖)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/page-fns.ts`, `packages/desktop/src/main/browser/page-fns.test.ts`
- Изменить: `packages/desktop/src/main/browser/inspector.ts`
- Тест: `packages/desktop/src/main/browser/inspector.test.ts`

**Интерфейсы:**
- Берёт: `REACT_INFO_FN` (`react-info.ts`).
- Отдаёт: `SELECT_OPTION_FN`, `PAGE_FNS`; `CDP_ALLOWED` + методы ниже; `CDP_AGENT_SCRIPT`; `Inspector.sendAgentScript`.

- [ ] **Шаг 1. Падающие тесты.** В `inspector.test.ts` тест «закрытый список этапов A и B» переименовать в «закрытый список A–D» и дополнить ожидание:

```ts
const STAGE_D = [
  'Accessibility.getFullAXTree',
  'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded', 'DOM.focus', 'DOM.setFileInputFiles',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Page.setInterceptFileChooserDialog',
  'Emulation.setFocusEmulationEnabled',
  'Runtime.terminateExecution',
  'DOMStorage.enable', 'DOMStorage.disable', 'DOMStorage.getDOMStorageItems', 'DOMStorage.setDOMStorageItem', 'DOMStorage.removeDOMStorageItem', 'DOMStorage.clear',
];
// ожидание [...CDP_ALLOWED].sort() — прежний список + STAGE_D; Runtime.evaluate по-прежнему нет в CDP_ALLOWED
```

```ts
describe('скрипты агента и функции Parley (этап D)', () => {
  it('send: Runtime.evaluate — отказ; callFunctionOn — только REACT_INFO_FN и SELECT_OPTION_FN', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockClear();
    await expect(inspector.send(7, 'Runtime.evaluate', { expression: '1' })).rejects.toThrow('CDP method not allowed: Runtime.evaluate');
    await expect(inspector.send(7, 'Runtime.callFunctionOn', { objectId: 'o', functionDeclaration: 'function () { return 1; }' })).rejects.toThrow('not allowed');
    expect(dbg.sendCommand).not.toHaveBeenCalled();
    await inspector.send(7, 'Runtime.callFunctionOn', { objectId: 'o', functionDeclaration: SELECT_OPTION_FN, arguments: [{ value: 'Blue' }] });
    expect(dbg.sendCommand).toHaveBeenCalledWith('Runtime.callFunctionOn', expect.objectContaining({ functionDeclaration: SELECT_OPTION_FN }));
  });

  it('sendAgentScript: только Runtime.evaluate и Runtime.callFunctionOn с любой функцией; прочее — отказ без sendCommand', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockClear();
    dbg.sendCommand.mockResolvedValueOnce({ result: { type: 'number', value: 2 } });
    await expect(inspector.sendAgentScript(7, 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true })).resolves.toEqual({ result: { type: 'number', value: 2 } });
    await inspector.sendAgentScript(7, 'Runtime.callFunctionOn', { objectId: 'o', functionDeclaration: '(el) => el.value' });
    await expect(inspector.sendAgentScript(7, 'Page.navigate' as 'Runtime.evaluate', { url: 'file:///etc/hosts' })).rejects.toThrow('not an agent script method');
    expect(dbg.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.evaluate', 'Runtime.callFunctionOn']);
  });

  it('sendAgentScript к чужому или отцепившемуся гостю — отказ, как send', async () => {
    const { inspector } = setup();
    await expect(inspector.sendAgentScript(8, 'Runtime.evaluate', { expression: '1' })).rejects.toThrow('no browser guest: 8');
  });
});
```

  Рамочный тест «в коде main `Runtime.callFunctionOn` зовётся только с `REACT_INFO_FN`» — допускать рядом `functionDeclaration: REACT_INFO_FN` или `functionDeclaration: SELECT_OPTION_FN`; вызовы `sendAgentScript(` в этот поиск не входят (их сторожит задача 21).

  `page-fns.test.ts` (jsdom): `SELECT_OPTION_FN`, собранная `new Function('return ' + SELECT_OPTION_FN)()`, на `<select>` с опциями `red`/`Red`, `blue`/`Blue`: `fn.call(select, 'Blue')` → `{ ok: true, label: 'Blue' }`, `select.value === 'blue'`, слушатели `input` и `change` вызваны по разу (всплывают); `fn.call(select, 'green')` → `{ ok: false, options: ['Red', 'Blue'] }`, значение прежнее; не `<select>` → `{ ok: false, options: [] }`. Не больше 50 опций в ответе.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/inspector.test.ts src/main/browser/page-fns.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - `page-fns.ts`: `SELECT_OPTION_FN` — строка `function (wanted) { … }` (ES5, без внешних глобалов, кроме встроенных): ищет `option` по `value === wanted`, затем по `textContent.trim() === wanted`; ставит `selected`, шлёт `new Event('input', { bubbles: true })` и `new Event('change', { bubbles: true })`; `PAGE_FNS = new Set([REACT_INFO_FN, SELECT_OPTION_FN])`.
  - `inspector.ts`: `CDP_ALLOWED` + `STAGE_D`; `cdpCallAllowed` для `Runtime.callFunctionOn` — `PAGE_FNS.has(params?.functionDeclaration)`; `CDP_AGENT_SCRIPT`; `sendAgentScript(id, method, params)` — та же отправка и тайм-аут `CDP_COMMAND_MS`, что у `send`, но проверка — `CDP_AGENT_SCRIPT.has(method)`, иначе `new Error(\`not an agent script method: ${method}\`)`. Комментарий модуля: «`Runtime.evaluate` — только `sendAgentScript`, вход скриптов агента (`agent-evaluate.ts`, решение владельца 2026-10-20)».

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/page-fns.ts packages/desktop/src/main/browser/page-fns.test.ts packages/desktop/src/main/browser/inspector.ts packages/desktop/src/main/browser/inspector.test.ts
git commit -m "feat(desktop): CDP allow-list for agent control and a separate entry for agent scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 7. Дерево доступности для агента `ax-snapshot.ts` (‖)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/ax-snapshot.ts`, `packages/desktop/src/main/browser/ax-snapshot.test.ts`

**Интерфейсы:**
- Берёт: `isSecretName`, `REDACTED`, `redactSecretsInText` (`shared/redact.ts`).
- Отдаёт: `AxNode`, `AxSnapshot`, `axSnapshot`, `axHasText`, `axState` («Общие имена»).

- [ ] **Шаг 1. Падающий тест.** Взять тест старого плана, задача 10, шаг 1, целиком (четыре теста, набор `NODES`) и дописать:

```ts
it('секрет в значении маскируется и без секретного имени; фрейм — строкой без содержимого (Фокус ревью 5)', () => {
  const nodes: AxNode[] = [
    { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['2', '3'] },
    { nodeId: '2', parentId: '1', ignored: false, role: { value: 'textbox' }, name: { value: 'Note' }, value: { value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' }, backendDOMNodeId: 5 },
    { nodeId: '3', parentId: '1', ignored: false, role: { value: 'Iframe' }, name: { value: 'Payment' }, childIds: ['4'], backendDOMNodeId: 6 },
    { nodeId: '4', parentId: '3', ignored: false, role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 7 },
  ];
  const text = axSnapshot(nodes, { interactiveOnly: false, limitBytes: 51_200 }).text;
  expect(text).not.toContain('eyJ');
  expect(text).toContain('[ref=e2] iframe "Payment"');
  expect(text).not.toContain('Pay"');
});

it('axHasText — видимый текст без учёта регистра и пробелов; игнорируемые узлы не считаются', () => {
  expect(axHasText(NODES, 'remember   ME')).toBe(true); // checkbox под игнорируемым узлом виден
  expect(axHasText(NODES, 'hello')).toBe(true);
  expect(axHasText(NODES, 'missing')).toBe(false);
  expect(axHasText([{ nodeId: '1', ignored: true, role: { value: 'StaticText' }, name: { value: 'Hidden' } }], 'hidden')).toBe(false);
});

it('axState: checked узла по backendNodeId; нет узла — null', () => {
  expect(axState(NODES, 16, 'checked')).toBe('mixed');
  expect(axState(NODES, 12, 'checked')).toBe(false);
  expect(axState(NODES, 999, 'checked')).toBeNull();
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/ax-snapshot.test.ts` → FAIL (нет модуля).

- [ ] **Шаг 3. Реализовать.** Тело `axSnapshot` — как в старом плане, задача 10, шаг 3, с поправками: значение поля — `isSecretName(name) ? REDACTED : redactSecretsInText(clean(raw, VALUE_LIMIT))` (в кавычках `JSON.stringify`); роль `Iframe` (и `iframe`) пишется строкой `iframe "<имя>"` со ссылкой, её дети не обходятся; `axHasText` и `axState` — тем же обходом (`TRANSPARENT`, `SKIPPED`, игнорируемые узлы пропускают свою строку, но не детей).

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS (7 тестов).

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/ax-snapshot.ts packages/desktop/src/main/browser/ax-snapshot.test.ts
git commit -m "feat(desktop): accessibility snapshot for agents — refs, masked values, frames as one line" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 8. Окно операции агента `agent-window.ts` (‖)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-window.ts`, `packages/desktop/src/main/browser/agent-window.test.ts`

**Интерфейсы:**
- Берёт: `AGENT_LIMITS.guardTailMs`.
- Отдаёт: `AgentWindowOwner`, `AgentWindow`, `createAgentWindow` («Общие имена»).

- [ ] **Шаг 1. Падающий тест.**

```ts
// agent-window.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createAgentWindow } from './agent-window.js';

const OWNER = { pageKey: '/p w-1\nbp-aaaaaa', webContentsId: 7, workKey: '/p w-1', sessionId: 's-02', agentId: 't1' };

function timers() {
  const pending: Array<{ fn: () => void; at: number; off: boolean }> = [];
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { const entry = { fn, at: now + ms, off: false }; pending.push(entry); return () => { entry.off = true; }; },
    advance(ms: number) { now += ms; for (const entry of pending.filter((e) => !e.off && e.at <= now)) { entry.off = true; entry.fn(); } },
  };
}

describe('окно операции агента (спека 5.2: операция и 2 с после)', () => {
  it('активно во время операции и ещё guardTailMs после конца; потом onIdle', () => {
    const clock = timers();
    const window = createAgentWindow({ tailMs: 2_000, setTimer: clock.setTimer });
    const idle = vi.fn();
    window.onIdle(idle);
    const end = window.begin(OWNER);
    expect(window.activeFor(7)).toEqual(OWNER);
    expect(window.activeFor(8)).toBeNull();
    end();
    clock.advance(1_999);
    expect(window.activeFor(7)).toEqual(OWNER);
    clock.advance(1);
    expect(window.activeFor(7)).toBeNull();
    expect(idle).toHaveBeenCalledWith(7);
  });

  it('новая операция в хвосте продлевает окно; idle — один раз, после последней', () => {
    const clock = timers();
    const window = createAgentWindow({ tailMs: 2_000, setTimer: clock.setTimer });
    const idle = vi.fn();
    window.onIdle(idle);
    window.begin(OWNER)();
    clock.advance(1_000);
    const end = window.begin({ ...OWNER, sessionId: 's-03' });
    expect(window.activeFor(7)?.sessionId).toBe('s-03');
    clock.advance(5_000);
    expect(idle).not.toHaveBeenCalled();
    end();
    clock.advance(2_000);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('заметки копятся с последнего begin и забираются один раз; вне окна — не копятся', () => {
    const clock = timers();
    const window = createAgentWindow({ tailMs: 2_000, setTimer: clock.setTimer });
    window.note(7, 'early');
    const end = window.begin(OWNER);
    window.note(7, 'The page started a download: a.csv.');
    window.note(8, 'other guest');
    expect(window.take(OWNER.pageKey)).toEqual(['The page started a download: a.csv.']);
    expect(window.take(OWNER.pageKey)).toEqual([]);
    end();
    clock.advance(2_000);
    window.note(7, 'late');
    expect(window.take(OWNER.pageKey)).toEqual([]);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-window.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать `createAgentWindow`.** Карта по `webContentsId`: владелец, счётчик открытых операций, таймер хвоста, заметки по `pageKey`. `begin` — счётчик +1, отменить таймер хвоста, очистить заметки страницы; возвращённый `end` (идемпотентный) — счётчик −1, при нуле — таймер `tailMs`, по нему запись снимается и зовутся `onIdle`. По умолчанию `tailMs = AGENT_LIMITS.guardTailMs`, `setTimer` — `setTimeout`/`clearTimeout`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-window.ts packages/desktop/src/main/browser/agent-window.test.ts
git commit -m "feat(desktop): agent operation window — the operation plus a 2 s tail, with notes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 9. Ввод агента `agent-input.ts` и `Emulation.fitOf` (‖)

Механизм ввода — по итогу спайка (В1–В6). План написан для ветки по умолчанию: CDP `Input.*`, перед первым шагом ввода операции — `borrowFocus` (окно фокусирует `<webview>`), фокус возвращает окно по концу операции.

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-input.ts`, `packages/desktop/src/main/browser/agent-input.test.ts`
- Изменить: `packages/desktop/src/main/browser/emulation.ts`
- Тест: `packages/desktop/src/main/browser/emulation.test.ts`

**Интерфейсы:**
- Берёт: `Inspector.send`; `AgentOpError`; `BrowserAgentModifier` (протокол).
- Отдаёт: «Общие имена → agent-input.ts»; `Emulation.fitOf(id)`.

- [ ] **Шаг 1. Падающие тесты.**

```ts
// agent-input.test.ts
describe('точка ввода и клавиши (этап 0, 0.4; спайк D, В6)', () => {
  it('inputPoint: без эмуляции — как есть; эмуляция — × scale; мобильная — × scale ÷ zoom', () => {
    expect(inputPoint({ x: 200, y: 230 }, null, 2)).toEqual({ x: 200, y: 230 });
    expect(inputPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: false }, 2)).toEqual({ x: 120, y: 138 });
    const mobile = inputPoint({ x: 200, y: 230 }, { scale: 0.6, mobile: true }, 2);
    expect(mobile.x).toBeCloseTo(60);
    expect(mobile.y).toBeCloseTo(69);
  });

  it('keySpec: имена клавиш и символы; незнакомое — null; modifierMask', () => {
    expect(keySpec('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(keySpec('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
    expect(keySpec('b')).toEqual({ key: 'b', code: 'KeyB', keyCode: 66, text: 'b' });
    expect(keySpec('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(keySpec('Hyper')).toBeNull();
    expect(modifierMask(['Alt', 'Shift'])).toBe(9);
    expect(modifierMask(['Meta'])).toBe(4);
  });
});

describe('AgentInput (Фокус ревью 1)', () => {
  function setup(borrow = true) {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const order: string[] = [];
    const inspector = { send: vi.fn(async (_id: number, method: string, params?: Record<string, unknown>) => { calls.push([method, params]); order.push(method); return {}; }) };
    const borrowFocus = vi.fn(async () => { order.push('borrow'); });
    const input = createAgentInput({ inspector, ...(borrow ? { borrowFocus } : {}) });
    const guard = { signal: new AbortController().signal, check: vi.fn() };
    const contents = { id: 7 } as unknown as WebContents;
    return { calls, order, input, guard, contents, borrowFocus };
  }

  // Ветка спайка: без В4 «да» строки 'Emulation.setFocusEmulationEnabled' в ожидании нет; без borrowFocus (В1/В2 «доходит») нет и 'borrow'.
  it('фокус одалживается один раз за операцию и до первой клавиши; check — перед каждым шагом', async () => {
    const { order, input, guard, contents, borrowFocus } = setup();
    await input.text(contents, 'Ann', guard);
    await input.key(contents, keySpec('Enter')!, 0, guard);
    expect(order).toEqual(['borrow', 'Emulation.setFocusEmulationEnabled', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(borrowFocus).toHaveBeenCalledTimes(1);
    expect(guard.check).toHaveBeenCalledTimes(3);
  });

  it('check бросил (Stop) — ни одной команды Input после', async () => {
    const { calls, input, guard, contents } = setup();
    guard.check.mockImplementationOnce(() => { throw new AgentOpError('access_denied', 'paused by the human'); });
    await expect(input.text(contents, 'Ann', guard)).rejects.toMatchObject({ code: 'access_denied' });
    expect(calls.filter(([method]) => method.startsWith('Input.'))).toEqual([]);
  });

  it('press Meta+A — selectAll; иные сочетания — без commands (буфер обмена агенту недоступен)', async () => {
    const { calls, input, guard, contents } = setup();
    await input.key(contents, keySpec('a')!, modifierMask(['Meta']), guard);
    await input.key(contents, keySpec('v')!, modifierMask(['Meta']), guard);
    const downs = calls.filter(([method, params]) => method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown').map(([, params]) => params);
    expect(downs[0]).toEqual({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
    expect(downs[1]).not.toHaveProperty('commands');
    expect(downs[1]).not.toHaveProperty('text');
  });

  it('mouse — шаги по порядку с модификаторами; отмена signal между шагами — остальные не уходят', async () => {
    const { calls, input, contents } = setup(false);
    const controller = new AbortController();
    const guard = { signal: controller.signal, check: vi.fn(() => { if (calls.length === 1) controller.abort(); controller.signal.throwIfAborted(); }) };
    await expect(input.mouse(contents, [{ type: 'mouseMoved', x: 1, y: 2 }, { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 }], 0, guard)).rejects.toThrow();
    expect(calls.map(([, params]) => params?.type)).toEqual(['mouseMoved']);
  });
});
```

```ts
// emulation.test.ts — дописать
it('fitOf: Fit — null; пресет — scale вписывания и mobile пресета', async () => {
  const send = vi.fn(async () => ({}));
  const emulation = createEmulation({ inspector: { send } });
  expect(emulation.fitOf(7)).toBeNull();
  await emulation.set(7, { preset: 'mobile-m', rotated: false, dpr: 2 }, { width: 300, height: 1000 });
  expect(emulation.fitOf(7)).toEqual({ scale: 0.8, mobile: true });
  await emulation.set(7, null, { width: 300, height: 1000 });
  expect(emulation.fitOf(7)).toBeNull();
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-input.test.ts src/main/browser/emulation.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - `keySpec` — таблица именованных клавиш старого плана (задача 12: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) и один печатный символ (`Key<Буква>`, `Digit<цифра>`, прочие — `code` пустой, `keyCode` по `charCodeAt` верхнего регистра); `text` — у Enter (`'\r'`), Space (`' '`) и символов; при модификаторе Meta или Control `text` не ставится.
  - `createAgentInput`: замыкание на операцию не нужно — фокус помнится в `WeakSet<AbortSignal>` (одолжен для этой операции); перед первым `key`/`text` (и `mouse`, если спайк В3 «да») — `borrowFocus(contents, signal)`, затем один раз на гостя (`WeakSet<WebContents>`) `Emulation.setFocusEmulationEnabled({ enabled: true })` (если спайк В4 «да»); `text` — `Input.insertText({ text })`; `key` — `keyDown` (с `text`, `commands: ['selectAll']` только для `a` с Meta или Control), затем `keyUp`; каждый шаг — `guard.check()` и `guard.signal.throwIfAborted()` перед отправкой.
  - `Emulation.fitOf(id)`: из `state` — `{ scale: viewportCommands(spec, area).scale, mobile: viewportSize(spec).mobile }`, нет записи — `null`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-input.ts packages/desktop/src/main/browser/agent-input.test.ts packages/desktop/src/main/browser/emulation.ts packages/desktop/src/main/browser/emulation.test.ts
git commit -m "feat(desktop): agent input — points, keys, text, borrowed guest focus, emulation fit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 10. Скачивания агента `agent-downloads.ts` (‖)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-downloads.ts`, `packages/desktop/src/main/browser/agent-downloads.test.ts`

**Интерфейсы:**
- Берёт: `AGENT_LIMITS.downloadBytes`, `.downloads`; `urlForAgent` (`agent-url.ts`); `cleanupDrops` (`main/drops.ts`) для уборки.
- Отдаёт: «Общие имена → agent-downloads.ts». Папка сессии — `<root>/<sha256(workKey) hex, 12 знаков>/<sessionId>/`.

- [ ] **Шаг 1. Падающий тест.** Временный `root` (`mkdtemp`); `DownloadItem` — заглушка-`EventEmitter` с `getFilename`, `getURL`, `getTotalBytes`, `getReceivedBytes`, `setSavePath`, `cancel`, `getState`.

```ts
describe('скачивания агента (Фокус ревью 6)', () => {
  it('claim — путь в папке сессии без диалога; имя — basename без управляющих символов; повтор имени — (2)', async () => {
    const downloads = createAgentDownloads({ root });
    const first = downloads.claim(item('../../evil\u0007.csv', 'https://example.test/report.csv?token=SECRET'), OWNER);
    expect(first.path).toBe(path.join(downloads.dirOf(OWNER.workKey, OWNER.sessionId), 'evil.csv'));
    expect(items[0]!.setSavePath).toHaveBeenCalledWith(first.path);
    expect(first.url).toBe('https://example.test/report.csv?token=<redacted>');
    expect(first).toMatchObject({ state: 'progressing', tab: 't1', name: 'evil.csv' });
    const second = downloads.claim(item('evil.csv'), OWNER);
    expect(path.basename(second.path)).toBe('evil (2).csv');
    expect((await stat(downloads.dirOf(OWNER.workKey, OWNER.sessionId))).mode & 0o777).toBe(0o700);
  });

  it('done: completed — файл 0600; больше downloadBytes — отмена и заметка', async () => {
    const downloads = createAgentDownloads({ root });
    const ok = downloads.claim(item('a.bin'), OWNER);
    await writeFile(ok.path, 'x');
    items[0]!.finish('completed');
    await vi.waitFor(async () => expect((await stat(ok.path)).mode & 0o777).toBe(0o600));
    expect(downloads.list(OWNER.workKey, OWNER.sessionId)[0]).toMatchObject({ state: 'completed' });
    const big = item('big.iso');
    downloads.claim(big, OWNER);
    big.progress(AGENT_LIMITS.downloadBytes + 1);
    expect(big.cancel).toHaveBeenCalled();
    expect(downloads.list(OWNER.workKey, OWNER.sessionId).at(-1)?.note).toContain('200 MB');
  });

  it('list — только своей сессии, не больше 20, новые последними; dirOf у разных работ различается', () => {
    const downloads = createAgentDownloads({ root });
    for (let i = 0; i < 25; i += 1) downloads.claim(item(`f${i}.txt`), OWNER);
    downloads.claim(item('other.txt'), { ...OWNER, sessionId: 's-03' });
    const list = downloads.list(OWNER.workKey, OWNER.sessionId);
    expect(list).toHaveLength(AGENT_LIMITS.downloads);
    expect(list.at(-1)?.name).toBe('f24.txt');
    expect(downloads.dirOf('/a w-1', 's-02')).not.toBe(downloads.dirOf('/b w-1', 's-02'));
  });

  it('sweep — файлы старше срока удаляются во всех папках сессий', async () => {
    // файл с mtime 8 суток назад и свежий: удалён один
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-downloads.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.** `claim` синхронный (Electron принимает путь только внутри `will-download`): `mkdirSync(dir, { recursive: true, mode: 0o700 })`, имя (`path.basename`, без `\u0000-\u001f`, до 200 кодовых точек, пустое — `download`), свободное имя `existsSync`-перебором `name (N).ext`, `item.setSavePath(path)`; слушатели `updated` (больше `downloadBytes` — `cancel()` и `note: 'Cancelled: larger than 200 MB.'`) и `done` (`state`, `chmod 0o600` при `completed`). Записи — в памяти (по `workKey\nsessionId`, не больше `downloads`, старые выпадают). `sweep` — `cleanupDrops` по каждой папке `<root>/*/*`. Комментарий модуля — про решение «папка скачиваний» из «Решений плана».

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-downloads.ts packages/desktop/src/main/browser/agent-downloads.test.ts
git commit -m "feat(desktop): agent downloads — a folder per session, size limit, weekly sweep" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 11. Скрипты агента `agent-evaluate.ts` (‖)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-evaluate.ts`, `packages/desktop/src/main/browser/agent-evaluate.test.ts`

**Интерфейсы:**
- Берёт: `AGENT_LIMITS.evalMs`, `.evalBytes`; `AgentOpError`; `urlForAgent`. Тип отправителя — свой `AgentScriptSender` («Общие имена»), чтобы не зависеть от задачи 6 при параллельной работе.
- Отдаёт: `AgentScripts`, `createAgentScripts`.

- [ ] **Шаг 1. Падающий тест.**

```ts
describe('скрипт агента в главном мире (решение владельца 2026-10-20; Фокус ревью 2)', () => {
  it('expression: Runtime.evaluate с returnByValue, awaitPromise, userGesture false и timeout; значение — JSON с типом', async () => {
    const { scripts, sender } = setup({ evaluate: { result: { type: 'object', value: { user: 'ann' } } } });
    const result = await scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'window.__state' }, null, signal());
    expect(sender.sendAgentScript).toHaveBeenCalledWith(7, 'Runtime.evaluate', { expression: 'window.__state', returnByValue: true, awaitPromise: true, userGesture: false, timeout: AGENT_LIMITS.evalMs });
    expect(result).toEqual({ tab: 't1', url: 'http://localhost:5173/', outcome: 'value', text: '{"user":"ann"}', type: 'object', truncated: false });
  });

  it('function без ref — вызов выражением; с ref — callFunctionOn над элементом, объект освобождается', async () => {
    const { scripts, sender } = setup({ resolve: { object: { objectId: 'node-1' } }, call: { result: { type: 'string', value: 'Ann' } } });
    await scripts.evaluateOf(contents, 't1', { tab: 't1', function: '() => 1' }, null, signal());
    expect(sender.sendAgentScript).toHaveBeenLastCalledWith(7, 'Runtime.evaluate', expect.objectContaining({ expression: '(() => 1)()' }));
    const value = await scripts.evaluateOf(contents, 't1', { tab: 't1', function: '(el) => el.value', ref: 'e3' }, 42, signal());
    expect(sender.send).toHaveBeenCalledWith(7, 'DOM.resolveNode', { backendNodeId: 42 });
    expect(sender.sendAgentScript).toHaveBeenLastCalledWith(7, 'Runtime.callFunctionOn', { objectId: 'node-1', functionDeclaration: '(el) => el.value', arguments: [{ objectId: 'node-1' }], returnByValue: true, awaitPromise: true, userGesture: false });
    expect(sender.send).toHaveBeenCalledWith(7, 'Runtime.releaseObject', { objectId: 'node-1' });
    expect(value.text).toBe('"Ann"');
  });

  it('исключение страницы — ответ outcome exception с описанием; undefined — тип undefined', async () => {
    const thrown = setup({ evaluate: { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1' } } } });
    expect(await thrown.scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'foo' }, null, signal())).toMatchObject({ outcome: 'exception', text: expect.stringContaining('ReferenceError: foo is not defined'), type: 'exception' });
    const nothing = setup({ evaluate: { result: { type: 'undefined' } } });
    expect(await nothing.scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'void 0' }, null, signal())).toMatchObject({ outcome: 'value', text: 'undefined', type: 'undefined' });
  });

  it('ответ длиннее evalBytes — обрезан, truncated', async () => {
    const { scripts } = setup({ evaluate: { result: { type: 'string', value: 'x'.repeat(AGENT_LIMITS.evalBytes * 2) } } });
    const result = await scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 's' }, null, signal());
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(AGENT_LIMITS.evalBytes);
    expect(result.truncated).toBe(true);
  });

  it('срок вышел или операцию оборвали (Stop) — Runtime.terminateExecution, отказ, результат не отдаётся', async () => {
    const { scripts, sender } = setup({ evaluate: 'hang', evalMs: 20 });
    await expect(scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'while (true) {}' }, null, signal())).rejects.toMatchObject({ code: 'timeout' });
    expect(sender.send).toHaveBeenCalledWith(7, 'Runtime.terminateExecution', {});
    const controller = new AbortController();
    const stopped = setup({ evaluate: 'hang' });
    const pending = stopped.scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'while (true) {}' }, null, controller.signal);
    controller.abort(new AgentOpError('access_denied', 'Stopped by the human (paused by the human).'));
    await expect(pending).rejects.toMatchObject({ code: 'access_denied' });
    expect(stopped.sender.send).toHaveBeenCalledWith(7, 'Runtime.terminateExecution', {});
  });
});
```

  `setup({ evaluate, resolve, call, evalMs })` — заглушка `AgentScriptSender`: `sendAgentScript` отвечает `evaluate`/`call` (`'hang'` — промис, который не разрешается), `send` — `resolve` на `DOM.resolveNode`, `{}` на прочее; `contents` — `{ id: 7, getURL: () => 'http://localhost:5173/' }`.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-evaluate.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать `evaluateOf`.** Гонка: ответ CDP, свой таймер `evalMs` (по нему — `send('Runtime.terminateExecution', {})` и `AgentOpError('timeout', 'The script ran longer than 10 s and was stopped.')`), `signal` (по нему — `terminateExecution` и `signal.reason`, если это `AgentOpError`, иначе `timeout`). `text`: `exceptionDetails` → `exception.description ?? text`; иначе `type === 'undefined'` → `'undefined'`, иначе `JSON.stringify(value)` (`value` нет при несериализуемом — текст «The value could not be returned as JSON (<description>); return a plain value.» с `outcome: 'value'`, `type` из CDP); обрезка по байтам UTF-8 без разрыва кодовой точки. Без маски (решение «маска явных чтений»). `url` — `urlForAgent(contents.getURL())`. Комментарий модуля: «единственный вход скриптов агента (`Inspector.sendAgentScript`); проверки доступа, паузы и `human_busy` — до вызова, в `agent-ops.ts`».

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-evaluate.ts packages/desktop/src/main/browser/agent-evaluate.test.ts
git commit -m "feat(desktop): agent scripts in the page's main world — JSON result, page exceptions, 10 s limit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 12. Куки и хранилище `agent-storage.ts` (‖)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-storage.ts`, `packages/desktop/src/main/browser/agent-storage.test.ts`

**Интерфейсы:**
- Берёт: `AGENT_LIMITS.listEntries`, `.storageValue`; `redactSecretsInText`, `isSecretName`, `REDACTED`; `urlForAgent`; `AgentOpError`.
- Отдаёт: `AgentStorage`, `createAgentStorage`; внутри — `storageIdOf(origin, local)` по итогу спайка В7.

- [ ] **Шаг 1. Падающий тест.**

```ts
describe('куки текущей страницы агента (Фокус ревью 3)', () => {
  it('list — cookies.get({ url: адрес страницы }); значения скрыты; values: true — показаны', async () => {
    const { storage, cookies } = setup({ url: 'https://shop.example.test/cart?x=1' });
    cookies.get.mockResolvedValue([{ name: 'sid', value: 'S3CR3T', domain: '.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true }]);
    const hidden = await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'list' });
    expect(cookies.get).toHaveBeenCalledWith({ url: 'https://shop.example.test/cart?x=1' });
    expect(hidden).toMatchObject({ cookies: [{ name: 'sid', domain: '.example.test', httpOnly: true, session: true, expires: null, size: 9 }] });
    expect(JSON.stringify(hidden)).not.toContain('S3CR3T');
    const shown = await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'list', values: true });
    expect(JSON.stringify(shown)).toContain('S3CR3T');
  });

  it('set — host-only кука адреса страницы; delete — remove(url, name); страница не http(s) — bad_request', async () => {
    const { storage, cookies } = setup({ url: 'http://localhost:5173/a' });
    await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'set', name: 'theme', value: 'dark', sameSite: 'strict', expires: 1_900_000_000 });
    expect(cookies.set).toHaveBeenCalledWith({ url: 'http://localhost:5173/a', name: 'theme', value: 'dark', sameSite: 'strict', expirationDate: 1_900_000_000 });
    expect(cookies.set.mock.calls[0]?.[0]).not.toHaveProperty('domain');
    await storage.cookiesOf(contents, 't1', { tab: 't1', action: 'delete', name: 'theme' });
    expect(cookies.remove).toHaveBeenCalledWith('http://localhost:5173/a', 'theme');
    const blank = setup({ url: 'about:blank' });
    await expect(blank.storage.cookiesOf(contents, 't1', { tab: 't1', action: 'list' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('localStorage и sessionStorage origin страницы', () => {
  it('list — getDOMStorageItems по origin; значения в списке — превью с маской; не больше listEntries', async () => {
    const { storage, inspector } = setup({ url: 'https://app.example.test/x', items: [['theme', 'dark'], ['access_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'], ...Array.from({ length: 150 }, (_, i) => [`k${i}`, 'v'])] });
    const result = await storage.storageOf(contents, 't1', { tab: 't1', area: 'local', action: 'list' });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'https://app.example.test', isLocalStorage: true } });
    expect(result).toMatchObject({ origin: 'https://app.example.test', area: 'local', total: 152 });
    if (!('entries' in result)) throw new Error('list');
    expect(result.entries).toHaveLength(AGENT_LIMITS.listEntries);
    expect(result.entries[1]).toMatchObject({ key: 'access_token', value: '<redacted>' });
  });

  it('get — значение как есть до storageValue; set, delete, clear — свои методы; sessionStorage — isLocalStorage false', async () => {
    const { storage, inspector } = setup({ url: 'https://app.example.test/x', items: [['token', 'abc']] });
    expect(await storage.storageOf(contents, 't1', { tab: 't1', area: 'session', action: 'get', key: 'token' })).toMatchObject({ key: 'token', value: 'abc', truncated: false });
    await storage.storageOf(contents, 't1', { tab: 't1', area: 'local', action: 'set', key: 'theme', value: 'dark' });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOMStorage.setDOMStorageItem', { storageId: { securityOrigin: 'https://app.example.test', isLocalStorage: true }, key: 'theme', value: 'dark' });
    await storage.storageOf(contents, 't1', { tab: 't1', area: 'local', action: 'clear' });
    expect(inspector.send).toHaveBeenCalledWith(7, 'DOMStorage.clear', { storageId: { securityOrigin: 'https://app.example.test', isLocalStorage: true } });
    expect(inspector.send.mock.calls.some(([, , params]) => (params as { storageId?: { isLocalStorage: boolean } })?.storageId?.isLocalStorage === false)).toBe(true);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-storage.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.** Адрес — только `contents.getURL()`, http(s), иначе `AgentOpError('bad_request', 'Page tN shows no web page yet: open or navigate it first.')`. Куки: `size` — `name.length + value.length`; `expires` — ISO из `expirationDate` или `null`; значение — только при `values: true`, обрезано до `AGENT_INPUT.cookieValue`; список — не больше `listEntries` с заметкой «N more cookies are not shown». Хранилище: `storageIdOf(origin, local)` — `{ securityOrigin: origin, isLocalStorage: local }` (или ветка В7); превью значения в списке — `isSecretName(key) ? REDACTED : redactSecretsInText(значение)`, до 200 кодовых точек; `get` — до `storageValue` с `truncated`; `done` — «Set theme in localStorage of https://app.example.test.» и подобные.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-storage.ts packages/desktop/src/main/browser/agent-storage.test.ts
git commit -m "feat(desktop): agent cookies and web storage — scoped to the page's current URL and origin" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 13. Окно: значок агента со Stop в строке страницы (‖)

**Файлы:**
- Создать: `packages/desktop/src/renderer/browser/AgentBadge.tsx`, `packages/desktop/src/renderer/browser/AgentBadge.test.tsx`
- Изменить: `packages/desktop/src/renderer/browser/BrowserChrome.tsx`, `packages/desktop/src/shared/strings.ts`
- Тест: `packages/desktop/src/renderer/browser/BrowserChrome.test.tsx`

**Интерфейсы:**
- Отдаёт: `AgentBadge({ session: string; recent: string[]; onStop(): void })`; `BrowserChromeProps.agent?: { session: string; recent: string[] } | null` и `onAgentStop?(): void` — значок стоит перед кнопкой консоли, только у страницы панели; строки `S.browser.panel.agentActing(session)` («S02 is using this page»), `.agentStop` («Stop»), `.agentStopHint` («Stop the agent and pause agents in this browser»), `.agentRecent` («Recent: …»).

- [ ] **Шаг 1. Падающие тесты.**

```tsx
// AgentBadge.test.tsx
it('ярлык сессии, Stop зовёт onStop, подсказка — последние операции', async () => {
  const onStop = vi.fn();
  render(<AgentBadge session="S02" recent={['snapshot', 'action click', 'wait_for']} onStop={onStop} />);
  expect(screen.getByText('S02')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: S.browser.panel.agentStop }));
  expect(onStop).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('agent-badge')).toHaveAttribute('title', expect.stringContaining('action click'));
});
```

```tsx
// BrowserChrome.test.tsx — дописать
it('значок агента — перед консолью, только когда agent задан; на ширине 800 строка не вылезает', () => {
  const { rerender } = render(<BrowserChrome {...baseProps} paused={false} onPause={vi.fn()} agent={null} />);
  expect(screen.queryByTestId('agent-badge')).toBeNull();
  rerender(<BrowserChrome {...baseProps} paused={false} onPause={vi.fn()} agent={{ session: 'S02', recent: [] }} onAgentStop={vi.fn()} />);
  const badge = screen.getByTestId('agent-badge');
  const consoleButton = screen.getByRole('button', { name: S.browser.devtools.toggle });
  expect(badge.compareDocumentPosition(consoleButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/renderer/browser/AgentBadge.test.tsx src/renderer/browser/BrowserChrome.test.tsx` → FAIL.

- [ ] **Шаг 3. Реализовать.** Значок — пилюля с ярлыком и кнопкой Stop (значок `Square` из `lucide-react`), `title` — `S.browser.panel.agentRecent(recent)`; на узкой строке подпись «Stop» прячется, остаётся значок (как прочие кнопки строки).

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS; `pnpm --filter @parley/desktop test -- src/english-ui.test.ts` → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/renderer/browser/AgentBadge.tsx packages/desktop/src/renderer/browser/AgentBadge.test.tsx packages/desktop/src/renderer/browser/BrowserChrome.tsx packages/desktop/src/renderer/browser/BrowserChrome.test.tsx packages/desktop/src/shared/strings.ts
git commit -m "feat(desktop): agent badge with Stop in the browser page bar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 14. Скилл `parley-browser`, указатели, правило приоритета (‖)

**Файлы:**
- Создать: `packages/core/src/work/parley-browser-skill.ts`, `packages/core/src/work/parley-browser-skill.test.ts`
- Изменить: `packages/core/src/work/skill-install.ts`, `packages/core/src/work/skill.ts`, `packages/core/src/work/guide.ts`, `packages/core/src/work/guidance.ts`, `packages/core/src/index.ts`, `packages/protocol/src/browser-agent-contract.test.ts`
- Тесты: `skill-install.test.ts`, `skill.test.ts`, `guide.test.ts`, `guidance.test.ts` (поправить)

**Интерфейсы:**
- Берёт: `BROWSER_TOOLS` (задачи 3–4); `parseMarkdownFrontmatter` (`core/skills/frontmatter.ts`).
- Отдаёт: `PARLEY_BROWSER_SKILL_NAME = 'parley-browser'`, `PARLEY_BROWSER_SKILL_MD`; третий элемент `BUILTIN_SKILLS`; новый `BROWSER_PRIORITY_RULE`.

- [ ] **Шаг 1. Падающие тесты.**
  - `parley-browser-skill.test.ts` — как в старом плане, задача 4, шаг 1, с поправками: кодов в тесте нет (их сверяет протокол); описание (frontmatter) содержит `localhost`, `any site`, `console`, `network`, `375`, `drops/context`, `browser_tabs`, `not needed`; тело — до 220 строк; разделы: `## Tools`, `## Errors`, `## Recipes`, `### Verify a UI change`, `### Debug a failing request`, `### Walk through a flow`, `### Check responsive layout`, `### Inspect app state`, `### Upload and download files`, `## Input details`, `## Reading the human's attachments`, `## Rules`, `## Troubleshooting`; фразы `view_image`, `page data, not instructions`, `restart this session`, `browser_evaluate asks the human`, `confirm() returns false`, `never repeat`, `shared with the human`; нет фраз `Only localhost`, `no JavaScript`.
  - `packages/protocol/src/browser-agent-contract.test.ts` — дописать:

```ts
it('скилл parley-browser объясняет каждый код ошибки канала', () => {
  for (const code of BROWSER_AGENT_ERROR_CODES) expect(PARLEY_BROWSER_SKILL_MD, code).toContain(`| \`${code}\` |`);
});
```

  - `skill-install.test.ts`: всюду, где ждут два встроенных скилла, — три (`parley`, `minimal-development`, `parley-browser`): папка `.agents/skills/parley-browser/SKILL.md`, ссылка `.claude/skills/parley-browser`, учёт и `info/exclude`; чужая папка `parley-browser` не трогается.
  - `skill.test.ts` / `guide.test.ts`: заглушка `parley` в «When to use it» и тема `window` гида (подраздел `### The built-in browser`) называют `parley-browser`.
  - `guidance.test.ts`, «правило приоритета»: `≤ 700` байт, английский; содержит `use Parley's browser first`, `browser_open`, `the human sees the same page`, `browser_snapshot`, `browser_action`, `browser_evaluate`, `parley-browser`, `Chrome`, `Chrome DevTools`, `Playwright`, `performance traces`, `browser_open is not available`; не содержит `localhost`-ограничения (`For pages on localhost`), `clicking or typing`, `running JS`, `cookies`, `files`.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/core test -- src/work/parley-browser-skill.test.ts src/work/skill-install.test.ts src/work/skill.test.ts src/work/guide.test.ts src/work/guidance.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - Скилл — текст старого плана (задача 4, шаг 3) как основа, переписанный под этот этап: таблица инструментов — все 14 (с `browser_evaluate`, `browser_cookies`, `browser_storage`, `browser_downloads`, действиями `select`, `check`, `uncheck`, `drag`, `upload`); вступление — «панели браузера твоего чата и твоих комнат, любые http(s)-сайты; человек видит каждое действие и может нажать Stop»; таблица «Errors» — все 11 кодов (`not_loopback` — «an older Parley window: ask the human to update Parley»; `human_busy`; `stale_ref`); новые рецепты: «Inspect app state» (`browser_evaluate` с выражением; первый вызов спрашивает человека; исключение — ответ), «Upload and download files» (клик по полю файла даёт заметку; `browser_action upload` с `ref` и абсолютными путями; скачивания — в папку сессии, `browser_downloads`); «Input details»: `type` не очищает поле (⌘A, затем `type`), `select` — по `value` или тексту опции (вместо «первой буквы»), `drag` — мышью, родной HTML5 drag-and-drop может не сработать, `alert`/`confirm`/`prompt` отключены (`confirm() returns false`; при необходимости подменить `window.confirm` через `browser_evaluate`), состояние наведения держится до следующего движения мыши; «Rules»: куки и хранилище общие с человеком (`shared with the human`), удаление куки может разлогинить человека; секреты не повторять (`never repeat`); свежий снимок перед действием; не мешать человеку. До 220 строк.
  - `skill-install.ts`: `{ name: PARLEY_BROWSER_SKILL_NAME, files: { 'SKILL.md': PARLEY_BROWSER_SKILL_MD } }` третьим в `BUILTIN_SKILLS`; комментарий «Two fixed assets» → «Three».
  - Указатели: в `skill.ts` — строка «For the built-in browser (open, read and drive pages your human sees) load the parley-browser skill.»; в `guide.ts` — подраздел `### The built-in browser` темы `window` с той же мыслью (2–4 строки).
  - `guidance.ts`: `BROWSER_PRIORITY_RULE` = «Use Parley's browser first for web pages you build or check: browser_open shows a page in the browser panel of your chat or room, and the human sees the same page; browser_snapshot, browser_action, browser_navigate, browser_console, browser_network, browser_screenshot and browser_evaluate read and drive it (skill parley-browser). Use Chrome, Chrome DevTools or Playwright only for performance traces or when browser_open is not available.»
  - `core/src/index.ts` — экспорт `PARLEY_BROWSER_SKILL_MD`, `PARLEY_BROWSER_SKILL_NAME`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS; `pnpm --filter @parley/core build`; `pnpm --filter @parley/protocol test -- src/browser-agent-contract.test.ts` → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/core/src/work/parley-browser-skill.ts packages/core/src/work/parley-browser-skill.test.ts packages/core/src/work/skill-install.ts packages/core/src/work/skill-install.test.ts packages/core/src/work/skill.ts packages/core/src/work/skill.test.ts packages/core/src/work/guide.ts packages/core/src/work/guide.test.ts packages/core/src/work/guidance.ts packages/core/src/work/guidance.test.ts packages/core/src/index.ts packages/protocol/src/browser-agent-contract.test.ts
git commit -m "feat(core): parley-browser skill, pointers to it, and a browser priority rule for full control" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 15. Main: основа `agent-ops` — любые сайты, занятость, Stop, окно операции, выбор файла, скачивания

**Файлы:**
- Изменить: `packages/desktop/src/main/browser/agent-ops.ts`, `agent-pages.ts`, `agent-capture.ts`, `packages/desktop/src/main/index.ts`
- Тесты: `packages/desktop/src/main/browser/agent-ops.test.ts` (поправить), создать `packages/desktop/src/main/browser/agent-ops-control.test.ts`

**Интерфейсы:**
- Берёт: `AgentWindow` (8), `AgentDownloads` (10), `AgentPageRegistration.humanBusy`, `AgentOps.stop/focusReady` (5), `Inspector.onEvent`.
- Отдаёт (задачам 16–19):
  - `PageRecord` + `humanBusy: boolean`, `seen: boolean` (`visible` хоть раз — спайк 0.2: действия только у страницы, которую человек видел);
  - `onPage(request, agentId, run, use?: { changes?: boolean; window?: boolean; seen?: boolean })` — `changes` → `human_busy`; `window` → окно операции и перехват выбора файла; `seen` → `tab_hidden` у ни разу не показанной страницы; `run(contents, record, guard: InputGuard)` (было `signal`);
  - `AgentOpsDeps` + `agentWindow: AgentWindow`, `inspector` — ещё `onEvent`, `borrowFocus?(contents, signal): Promise<void>`;
  - `createPageRunner(deps: { registry: PageRegistry; agentsAllowed(): Promise<boolean>; agentWindow: AgentWindow; inspector: Pick<Inspector, 'send' | 'onEvent'>; activity(e: AgentActivity): void; opTimeoutMs?: number }): PageRunner`, `PageRunner = { run<T>(request, agentId, task: (contents: WebContents, record: PageRecord, guard: InputGuard) => Promise<T>, use?: { changes?: boolean; window?: boolean; seen?: boolean }): Promise<T>; stop(webContentsId: number): void }` — `createAgentOps` собирает его, задачи 16–19 зовут `runner.run`;
  - `AgentOps.stop(webContentsId)`: панель страницы — на паузу в реестре сразу, текущая операция страницы — `abort(new AgentOpError('access_denied', 'Stopped by the human: agents are paused in this browser panel (paused by the human).'))`;
  - `AgentOps.focusReady(id)` — подтверждение окна для `borrowFocus` (main ждёт его не дольше `AGENT_LIMITS.opMs`, с отменой по `signal`).

- [ ] **Шаг 1. Поправить старые тесты и написать падающие.**
  - В `agent-ops.test.ts` тесты слитой ветки «внешняя страница — not_loopback» и «ушла redirect — not_loopback» заменить: внешняя страница читается (`console`, `network`, `screenshot` → `ok`), `tabs` показывает полный адрес с маской и заголовок (`https://accounts.example.test/signin?sid=<redacted>`, `Sign in`); тест C «страница ушла с localhost посреди снимка — not_loopback» — заменить на «документ сменился посреди снимка — tab_not_loaded» (эпоха уже проверяется).
  - `agent-ops-control.test.ts` — свой `setup()` (копия помощников `agent-ops.test.ts`: `fakeGuest`, `register`, `codeOf`, `messageOf`, `okResult`) с `agentWindow` (настоящий `createAgentWindow`), заглушкой `inspector.onEvent` (`ctx.emitCdp(id, method, params)`) и вторым помощником `pageSetup()` — `createPageRunner` со своим `createPageRegistry` и страницей `t1` (`ctx.runner`, `ctx.register`, `ctx.page(agentId, use)` — вызов `ctx.runner.run(request, agentId, task, use)`), где `task` увеличивает `ctx.ran`, а при `use.hold` ждёт `ctx.release()`. `devtoolsWith({ consoleText, requestUrl })` — снимок журнала с одной записью консоли и одним упавшим запросом (форма — как в тестах C). Тесты:

```ts
describe('любые сайты (решение владельца 2026-10-20; Фокус ревью 5)', () => {
  it('внешняя страница: console и network читаются, URL и тексты — с маской', async () => {
    const ctx = setup({ url: 'https://example.test/reset?token=SECRET1' });
    ctx.inspector.snapshot.mockReturnValue(devtoolsWith({ consoleText: 'login failed for Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', requestUrl: 'https://api.example.test/me?access_token=SECRET2' }));
    const text = JSON.stringify([okResult(await ctx.run('console', { tab: 't1' })), okResult(await ctx.run('network', { tab: 't1', failedOnly: false }))]);
    for (const secret of ['SECRET1', 'SECRET2', 'eyJ']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('<redacted>');
  });
});

describe('занятость, Stop, окно операции', () => {
  it('human_busy: операция с changes у страницы с Select/Annotate — отказ до run; чтение — можно', async () => {
    const ctx = pageSetup();
    ctx.register({ humanBusy: true });
    await expect(ctx.page('t1', {})).resolves.toBeDefined(); // чтение у занятой страницы — можно
    expect(ctx.ran).toBe(1);
    await expect(ctx.page('t1', { changes: true })).rejects.toMatchObject({ code: 'human_busy' });
    expect(ctx.ran).toBe(1);
  });

  it('Stop: пауза в реестре сразу, текущая операция страницы — access_denied, следующая — access_denied', async () => {
    const ctx = pageSetup();
    const pending = ctx.page('t1', { changes: true, hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(1));
    ctx.runner.stop(7);
    await expect(pending).rejects.toMatchObject({ code: 'access_denied', message: expect.stringContaining('paused by the human') });
    await expect(ctx.page('t1', {})).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('окно операции: операция с window открывает перехват выбора файла и окно; после хвоста перехват снят', async () => {
    const ctx = pageSetup({ tailMs: 20 });
    await ctx.page('t1', { window: true });
    expect(ctx.inspector.send).toHaveBeenCalledWith(7, 'Page.setInterceptFileChooserDialog', { enabled: true });
    expect(ctx.agentWindow.activeFor(7)).toMatchObject({ sessionId: 's-02', agentId: 't1' });
    await vi.waitFor(() => expect(ctx.inspector.send).toHaveBeenCalledWith(7, 'Page.setInterceptFileChooserDialog', { enabled: false }));
  });

  it('Page.fileChooserOpened в окне — заметка «use upload»; нативного диалога нет (Фокус ревью 4)', async () => {
    const ctx = pageSetup();
    const done = ctx.page('t1', { window: true, hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(1));
    ctx.emitCdp(7, 'Page.fileChooserOpened', { frameId: 'F', mode: 'selectSingle', backendNodeId: 31 });
    ctx.release();
    await done;
    expect(ctx.agentWindow.take(ctx.pageKey)).toEqual(['The page opened a file chooser; nothing was shown to the human. Take a browser_snapshot and use browser_action with action upload on the file input.']);
  });

  it('страница, которую человек ни разу не видел, — tab_hidden для seen-операций (этап 0, 0.2)', async () => {
    const ctx = pageSetup();
    ctx.register({ visible: false });
    await expect(ctx.page('t1', { seen: true })).rejects.toMatchObject({ code: 'tab_hidden' });
    ctx.register({ visible: true });
    ctx.register({ visible: false });
    await expect(ctx.page('t1', { seen: true })).resolves.toBeDefined();
  });
});
```

  Прямого тестового входа в `createAgentOps` нет: `agent-ops.ts` экспортирует `createPageRunner(deps)` (прежний `onPage` с реестром, очередью, окном операции и Stop), `createAgentOps` собирает его, тест берёт его же. `use.hold` — только опция теста в задаче `ctx.page`, не поле `use` продукта.
  - Скачивания — в `agent-ops-control.test.ts` тест на `routeDownload` (экспорт `agent-ops.ts`): `routeDownload(item, source, { agentWindow, downloads, registry })` → активное окно — `downloads.claim` с владельцем окна и `agentWindow.note(…, 'The page started a download: report.csv → <path> (see browser_downloads).')`, ответ `true`; нет окна — `false`, `claim` не вызван (Фокус ревью 6).

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-ops.test.ts src/main/browser/agent-ops-control.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - `agent-pages.ts`: `PageRecord.humanBusy` (`e.humanBusy === true`), `seen` (`e.visible || previous?.seen === true`); `listTabs` — `url: urlForAgent(record.lastUrl)`, заголовок с маской для всех, размер для всех; `loopback` остаётся полем ответа; `pauseFor(webContentsId): PageRecord | null` — ставит паузу панели записи.
  - `agent-capture.ts`: убрать проверку `isLoopbackUrl` после снимка (эпоха остаётся).
  - `agent-ops.ts`: `checked` без loopback (`isLoopbackUrl` импорт уходит, если больше не нужен); `createPageRunner` — прежний `onPage` плюс: `AbortSignal.any([сигнал очереди, сигнал Stop страницы])`; общий выключатель — `await deps.agentsAllowed()` перед стартом задачи (как сейчас); `guard.check()` синхронный: реестр (пауза панели, `humanBusy` при `changes`) и `signal.throwIfAborted()`; `window` — `agentWindow.begin(...)`, `Page.setInterceptFileChooserDialog { enabled: true }` (один раз на окно; `onIdle` → `enabled: false`), подписка `inspector.onEvent(id, 'Page.fileChooserOpened', …)` на время окна → `agentWindow.note`. Ошибка отмены по Stop отдаётся как `signal.reason`.
  - `routeDownload(item, source, deps): boolean` — экспорт `agent-ops.ts`.
  - `main/index.ts`: `const agentWindow = createAgentWindow()`; `const agentDownloads = createAgentDownloads({ root: path.join(parleyHome(), 'desktop', 'agent-downloads') })`; в `download` стража — `designMode.downloadStarted(source.id)`, затем `if (routeDownload(item, source, …)) return;`, затем прежний путь человека; почасовая уборка рядом с `cleanupDrops` агента — `agentDownloads.sweep(AGENT_LIMITS.downloadDays * 24 * 60 * 60 * 1000)`; `createAgentOps({ …, agentWindow, borrowFocus })`, где `borrowFocus` шлёт окну `browser:agent-activity` с `phase: 'step', focus: { id }` и ждёт `ops.focusReady(id)` (по ветке спайка; иначе не передаётся).

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS; `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-ops.ts packages/desktop/src/main/browser/agent-pages.ts packages/desktop/src/main/browser/agent-capture.ts packages/desktop/src/main/browser/agent-ops.test.ts packages/desktop/src/main/browser/agent-ops-control.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): agent operations on any site — human busy, Stop, operation window, file chooser and download routing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 16. Main: `snapshot`, `wait_for`, ссылки `eN` (`agent-dom.ts`)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-dom.ts`, `packages/desktop/src/main/browser/agent-dom.test.ts`
- Изменить: `packages/desktop/src/main/browser/agent-ops.ts` (`case 'snapshot'`, `case 'wait_for'`)
- Тест: `agent-ops-control.test.ts` (дописать)

**Интерфейсы:**
- Берёт: `axSnapshot`, `axHasText`, `axState` (7); `createPageRunner`, `InputGuard` (15).
- Отдаёт: `AgentDom`, `createAgentDom` («Общие имена»). Ссылки живут в `AgentDom` по `pageKey` с эпохой `inspector.snapshot(id)?.epoch`: новый снимок заменяет карту, другая эпоха — `stale_ref`.

- [ ] **Шаг 1. Падающие тесты.**

```ts
// agent-dom.test.ts
describe('ссылки и ожидание (спека 5.1)', () => {
  it('snapshot: DOM.enable, Accessibility.enable, getFullAXTree; текст и число ссылок; предел snapshotBytes', async () => {
    const { dom, send } = setup({ nodes: NODES });
    const result = await dom.snapshotOf(contents, record, { tab: 't1' });
    expect(send.mock.calls.map(([, method]) => method)).toEqual(['DOM.enable', 'Accessibility.enable', 'Accessibility.getFullAXTree']);
    expect(result).toMatchObject({ tab: 't1', refs: 5, truncated: false });
    expect(result.text).toContain('[ref=e2] button "Save"');
  });

  it('nodeOf: ссылка из текущего снимка — backendNodeId; неизвестная или после смены эпохи — stale_ref (Фокус ревью 7)', async () => {
    const ctx = setup({ nodes: NODES });
    await ctx.dom.snapshotOf(contents, record, { tab: 't1' });
    expect(ctx.dom.nodeOf(contents, record, 'e2')).toBe(12);
    expect(() => ctx.dom.nodeOf(contents, record, 'e99')).toThrow(expect.objectContaining({ code: 'stale_ref' }));
    ctx.epoch = 2;
    expect(() => ctx.dom.nodeOf(contents, record, 'e2')).toThrow(expect.objectContaining({ code: 'stale_ref' }));
  });

  it('centerOf: scrollIntoViewIfNeeded, центр content-квада getBoxModel; узел пропал — stale_ref', async () => {
    const ctx = setup({ box: { content: [100, 200, 300, 200, 300, 260, 100, 260] } });
    expect(await ctx.dom.centerOf(contents, 12)).toEqual({ x: 200, y: 230 });
    expect(ctx.send).toHaveBeenCalledWith(7, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: 12 });
    ctx.boxFails = true;
    await expect(ctx.dom.centerOf(contents, 12)).rejects.toMatchObject({ code: 'stale_ref' });
  });

  it('waitFor: text — found, как только появился; gone — когда пропал; ms — waited; срок — timeout без ошибки', async () => {
    const ctx = setup({ nodes: [] });
    setTimeout(() => { ctx.nodes = NODES; }, 30);
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', text: 'Save' }, signal())).toMatchObject({ outcome: 'found' });
    setTimeout(() => { ctx.nodes = []; }, 30);
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', gone: 'Save' }, signal())).toMatchObject({ outcome: 'gone' });
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', ms: 20 }, signal())).toMatchObject({ outcome: 'waited' });
    ctx.limitMs = 60;
    expect(await ctx.dom.waitFor(contents, record, { tab: 't1', text: 'Never' }, signal())).toMatchObject({ outcome: 'timeout' });
  });
});
```

  В `agent-ops-control.test.ts`: `snapshot` у страницы, которую человек не видит, — `ok` (спайк 0.2); `wait_for` у занятой страницы — `ok`; Stop посреди `wait_for` — `access_denied`, очередь свободна: следующая операция стартует (Фокус ревью 7).

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-dom.test.ts src/main/browser/agent-ops-control.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.** `snapshotOf`: `DOM.enable` и `Accessibility.enable` один раз на гостя (повтор после навигации допустим), `Accessibility.getFullAXTree` → `axSnapshot(nodes, { interactiveOnly, limitBytes: AGENT_LIMITS.snapshotBytes })`; `url` — `urlForAgent`. `waitFor`: опрос `getFullAXTree` раз в `AGENT_LIMITS.pollMs` до `AGENT_LIMITS.waitMs` (тесту — `limitMs`), с `signal`. В `agent-ops.ts`: `snapshot` — `onPage(…)` без `changes`/`window`/`seen`; `wait_for` — то же.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-dom.ts packages/desktop/src/main/browser/agent-dom.test.ts packages/desktop/src/main/browser/agent-ops.ts packages/desktop/src/main/browser/agent-ops-control.test.ts
git commit -m "feat(desktop): browser_snapshot and browser_wait_for — refs per document, visible text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 17. Main: `action` (`agent-actions.ts`)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-actions.ts`, `packages/desktop/src/main/browser/agent-actions.test.ts`
- Изменить: `packages/desktop/src/main/browser/agent-ops.ts` (`case 'action'`), `packages/desktop/src/main/index.ts` (зависимости)

**Интерфейсы:**
- Берёт: `AgentInput`, `inputPoint`, `keySpec`, `modifierMask` (9); `AgentDom` (16); `AgentWindow.take` (8); `SELECT_OPTION_FN` (6); `Emulation.fitOf` (9).
- Отдаёт: `AgentActions`, `createAgentActions`, `withNavigation` («Общие имена»). `action` в `onPage` — `{ changes: true, window: true, seen: true }`.

- [ ] **Шаг 1. Падающие тесты.** Заглушки: `input` (журнал вызовов), `dom` (`nodeOf` — по карте `e1→11, e2→12, e8→18`; `centerOf` — `{ x: 200, y: 230 }`), `inspector.send` (журнал; `DOM.describeNode` — `{ node: { nodeName: 'INPUT', attributes: ['type', 'file', 'multiple', ''] } }`), гость с `EventEmitter` для `did-start-navigation`/`did-stop-loading`.

```ts
describe('action (спека 5.1, 4.8)', () => {
  it('click по ref: центр × fitOf, mouseMoved/Pressed/Released; точка клика — событием step в CSS-пикселях; что сделано', async () => {
    const ctx = setup({ fit: { scale: 0.6, mobile: false } });
    const result = await ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'click', ref: 'e2' }, guard());
    expect(ctx.input.mouse).toHaveBeenCalledWith(contents, [
      { type: 'mouseMoved', x: 120, y: 138 },
      { type: 'mousePressed', x: 120, y: 138, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 120, y: 138, button: 'left', buttons: 0, clickCount: 1 },
    ], 0, expect.anything());
    expect(ctx.activity).toHaveBeenCalledWith(expect.objectContaining({ phase: 'step', point: { x: 200, y: 230 } }));
    expect(result).toMatchObject({ done: 'Clicked e2.', navigated: false, notes: [] });
  });

  it('double_click — clickCount 1 и 2; hover — только mouseMoved и без точки', async () => { /* как в старом плане, задача 12 */ });

  it('type в ref: DOM.focus, затем текст; submit — Enter', async () => {
    const ctx = setup();
    const result = await ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'type', ref: 'e1', text: 'Ann', submit: true }, guard());
    expect(ctx.send).toHaveBeenCalledWith(7, 'DOM.focus', { backendNodeId: 11 });
    expect(ctx.input.text).toHaveBeenCalledWith(contents, 'Ann', expect.anything());
    expect(ctx.input.key).toHaveBeenCalledWith(contents, expect.objectContaining({ key: 'Enter' }), 0, expect.anything());
    expect(result.done).toBe('Typed 3 characters into e1 and pressed Enter.');
  });

  it('press: незнакомая клавиша — bad_request без ввода', async () => {
    const ctx = setup();
    await expect(ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'press', key: 'Hyper' }, guard())).rejects.toMatchObject({ code: 'bad_request' });
    expect(ctx.input.key).not.toHaveBeenCalled();
  });

  it('scroll вниз по умолчанию — на высоту вьюпорта в середине страницы', async () => { /* mouseWheel deltaY = высота cssLayoutViewport, как в старом плане */ });

  it('select: SELECT_OPTION_FN над узлом; нет опции — bad_request со списком опций', async () => {
    const ctx = setup({ selectAnswer: { ok: false, options: ['Red', 'Blue'] } });
    await expect(ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'select', ref: 'e2', value: 'Green' }, guard())).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('Red, Blue') });
    expect(ctx.send).toHaveBeenCalledWith(7, 'Runtime.callFunctionOn', expect.objectContaining({ functionDeclaration: SELECT_OPTION_FN, arguments: [{ value: 'Green' }], returnByValue: true }));
  });

  it('check: уже отмечен — без клика; не отмечен — клик и проверка; не изменился — заметка', async () => { /* dom.checkedOf: true → done 'e5 is already checked.'; false → click, затем true */ });

  it('drag: нажатие в начале, 10 шагов mouseMoved с buttons 1, отпускание в конце; Stop между шагами — следующих нет (Фокус ревью 7)', async () => {
    const ctx = setup();
    await ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'drag', x: 10, y: 10, toX: 110, toY: 10 }, guard());
    const steps = ctx.input.mouse.mock.calls[0]?.[1] as MouseStep[];
    expect(steps[0]).toMatchObject({ type: 'mouseMoved', x: 10, y: 10 });
    expect(steps[1]).toMatchObject({ type: 'mousePressed' });
    expect(steps.filter((step) => step.type === 'mouseMoved' && step.buttons === 1)).toHaveLength(10);
    expect(steps.at(-1)).toMatchObject({ type: 'mouseReleased', x: 110, y: 10 });
  });

  it('upload: DOM.setFileInputFiles с путями после realpath; не поле файла, каталог, нет файла, больше предела, несколько без multiple — bad_request без вызова (Фокус ревью 4)', async () => {
    const ctx = setup({ files: { '/tmp/a.png': { size: 10 }, '/tmp/dir': 'dir', '/tmp/link.png': { size: 10, real: '/tmp/a.png' }, '/tmp/big.iso': { size: AGENT_LIMITS.uploadBytes + 1 } } });
    const ok = await ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'upload', ref: 'e8', files: ['/tmp/link.png'] }, guard());
    expect(ctx.send).toHaveBeenCalledWith(7, 'DOM.setFileInputFiles', { files: ['/tmp/a.png'], backendNodeId: 18 });
    expect(ok.done).toBe('Put 1 file into e8.');
    for (const files of [['/tmp/dir'], ['/tmp/missing.png'], ['/tmp/big.iso']]) {
      ctx.send.mockClear();
      await expect(ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'upload', ref: 'e8', files }, guard()), files[0]).rejects.toMatchObject({ code: 'bad_request' });
      expect(ctx.send.mock.calls.some(([, method]) => method === 'DOM.setFileInputFiles')).toBe(false);
    }
    ctx.describe = { nodeName: 'BUTTON', attributes: [] };
    await expect(ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'upload', ref: 'e8', files: ['/tmp/a.png'] }, guard())).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('upload из секретного места — bad_request без вызова, в том числе через симлинк; обычный файл дома — можно (решение владельца 4)', async () => {
    const ctx = setup({
      home: '/Users/me',
      files: {
        '/tmp/key': { size: 10, real: '/Users/me/.ssh/id_ed25519' },
        '/Users/me/app/.env.local': { size: 10 },
        '/Users/me/Library/Keychains/login.keychain-db': { size: 10 },
        '/Users/me/backup/id_rsa': { size: 10 },
        '/Users/me/app/shot.png': { size: 10 },
      },
    });
    for (const file of ['/tmp/key', '/Users/me/app/.env.local', '/Users/me/Library/Keychains/login.keychain-db', '/Users/me/backup/id_rsa']) {
      ctx.send.mockClear();
      await expect(ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'upload', ref: 'e8', files: [file] }, guard()), file).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('secret locations') });
      expect(ctx.send.mock.calls.some(([, method]) => method === 'DOM.setFileInputFiles')).toBe(false);
    }
    await ctx.actions.actionOf(contents, record, request, { tab: 't1', action: 'upload', ref: 'e8', files: ['/Users/me/app/shot.png'] }, guard());
    expect(ctx.send).toHaveBeenCalledWith(7, 'DOM.setFileInputFiles', { files: ['/Users/me/app/shot.png'], backendNodeId: 18 });
  });

  it('secretUploadPath: по сегментам и без учёта регистра', () => {
    const home = '/Users/me';
    expect(secretUploadPath('/Users/me/.ssh/config', home)).toBe(true);
    expect(secretUploadPath('/Users/me/.SSH/config', home)).toBe(true);
    expect(secretUploadPath('/Users/me/.config/gh/hosts.yml', home)).toBe(true);
    expect(secretUploadPath('/Users/me/.sshx/a.png', home)).toBe(false);
    expect(secretUploadPath('/Users/me/app/id_ed25519.pub', home)).toBe(false);
    expect(secretUploadPath('/Users/me/app/.environment.md', home)).toBe(false);
    expect(secretUploadPath('/Users/me/app/.env.production', home)).toBe(true);
  });

  it('действие вызвало переход — загрузка дождана, navigated, адрес после; заметки окна операции — в ответе', async () => {
    // mouseReleased → гость emit did-start-navigation (main frame, не same-document), через 20 мс did-stop-loading и новый URL;
    // agentWindow.take отдаёт ['The page started a download: report.csv → … (see browser_downloads).']
  });
});
```

  В `agent-ops-control.test.ts`: `action` у занятой страницы — `human_busy`, `input.mouse` не вызван (Фокус ревью из индекса, п. 4); `action` в страницу чужого хозяина — `no_tab`, ни одной команды (Фокус ревью 4); `upload` в чужую страницу — `no_tab`, `DOM.setFileInputFiles` не вызван.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-actions.test.ts src/main/browser/agent-ops-control.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.** Точки — `dom.centerOf` (или `x,y` как есть) → `inputPoint(point, emulation.fitOf(id), contents.getZoomFactor())`; точка для окна (`activity` с `phase: 'step'`, `point`) — в CSS-пикселях страницы (до множителя). `double_click`, `hover`, `scroll`, `press`, `type` — как в старом плане, задача 12, шаг 3 (`done`-тексты оттуда). `select` — `DOM.resolveNode` → `Runtime.callFunctionOn(SELECT_OPTION_FN)` → `Runtime.releaseObject`. `check`/`uncheck` — `dom.checkedOf`, клик при несовпадении, повторное чтение. `drag` — 10 промежуточных `mouseMoved`, `buttons: 1`. `upload` — `DOM.describeNode({ backendNodeId })`: `INPUT` с `type=file` (регистр не важен); `files` — `realpath`, затем `secretUploadPath(real, deps.home ?? os.homedir())` (решение владельца 4: да — `bad_request` «Parley does not upload files from secret locations (~/.ssh, keychains, .env …).»), `stat().isFile()`, `size ≤ uploadBytes`, больше одного — нужен атрибут `multiple`; ошибки — `bad_request` с понятной причиной. Проверка всех файлов — до первого вызова CDP. `withNavigation(contents, run, signal)` — слушает `did-start-navigation` (главный фрейм, `!isSameDocument`) во время `run` и ещё `settleMs`; начался — ждёт `did-stop-loading` до `loadMs` (`loaded: false` — заметка «The page is still loading.»). Заметки — `window.take(record pageKey)`. Каждый шаг ввода — через `guard`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-actions.ts packages/desktop/src/main/browser/agent-actions.test.ts packages/desktop/src/main/browser/agent-ops.ts packages/desktop/src/main/browser/agent-ops-control.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): browser_action — click, type, press, scroll, select, check, drag, upload" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 18. Main: `navigate`, `resize`, `open` с ожиданием загрузки, `screenshot` с `ref`

**Файлы:**
- Изменить: `packages/desktop/src/main/browser/agent-ops.ts`, `agent-capture.ts`, `packages/desktop/src/main/index.ts`
- Тесты: `agent-ops-control.test.ts`, `agent-ops.test.ts` (снимок элемента — рядом с тестами снимка C)

**Интерфейсы:**
- Берёт: `withNavigation` (17); `AgentDom.nodeOf`, `boxOf` (16); `openableHref` (0); `AgentResize` (5); `VIEWPORT_PRESETS`, `viewportSize`.
- Отдаёт: операции `navigate` (`{ changes: true, window: true }`), `resize` (`{ changes: true }`), `open` с `loaded`/`title`, `screenshot` с `ref`; экспорт `resolveAgentUrl(raw, base): string | null` (путь от `/` — от адреса страницы; итог — через `openableHref`), `agentViewport(args, current: ViewportSpec | null): ViewportSpec | null`; `AgentOpsDeps.resize(e: AgentResize): boolean`; `AgentCaptureDeps.image.cropRect(png, rect): Buffer`.

- [ ] **Шаг 1. Падающие тесты.**

```ts
describe('navigate, resize, open, снимок элемента', () => {
  it('resolveAgentUrl: путь — от адреса страницы; другие схемы — null', () => {
    expect(resolveAgentUrl('/settings?x=1', 'https://app.example.test/a/b')).toBe('https://app.example.test/settings?x=1');
    expect(resolveAgentUrl('https://example.com/', 'http://localhost/')).toBe('https://example.com/');
    for (const raw of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings']) expect(resolveAgentUrl(raw, 'http://localhost/'), raw).toBeNull();
  });

  it('navigate url: loadURL, ждёт загрузку, ответ — адрес и заголовок с маской; back/forward/reload/hard — методы webContents', async () => {
    const ctx = setup();
    const result = okResult<BrowserAgentNavigateResult>(await ctx.run('navigate', { tab: 't1', url: 'https://example.test/login?token=SECRET' }));
    expect(ctx.guest.loadURL).toHaveBeenCalledWith('https://example.test/login?token=SECRET');
    expect(result).toMatchObject({ url: 'https://example.test/login?token=<redacted>', loaded: true });
    await ctx.run('navigate', { tab: 't1', back: true });
    expect(ctx.guest.navigationHistory.goBack).toHaveBeenCalled();
    await ctx.run('navigate', { tab: 't1', reload: true, hard: true });
    expect(ctx.guest.reloadIgnoringCache).toHaveBeenCalled();
    expect(codeOf(await ctx.run('navigate', { tab: 't1', url: 'file:///etc/hosts' }))).toBe('bad_request');
  });

  it('navigate у занятой страницы — human_busy, loadURL не вызван', async () => { /* register({ humanBusy: true }) */ });

  it('resize: событие окну с ViewportSpec пресета (DPR — как правило меню размеров), ждёт emulation.current; fit — null', async () => {
    const ctx = setup();
    ctx.afterResize = (e) => ctx.emulationState.set(7, e.viewport);
    const result = okResult<BrowserAgentResizeResult>(await ctx.run('resize', { tab: 't1', preset: 'mobile-m' }));
    expect(ctx.resize).toHaveBeenCalledWith({ webContentsId: 7, viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } });
    expect(result.viewport).toEqual({ width: 375, height: 812, emulated: true });
    await ctx.run('resize', { tab: 't1', fit: true });
    expect(ctx.resize).toHaveBeenLastCalledWith({ webContentsId: 7, viewport: null });
  });

  it('resize: окно не поставило размер за resizeMs — timeout', async () => { /* afterResize ничего не делает */ });

  it('open: после ответа окна ждёт регистрацию страницы и загрузку — loaded и заголовок; не смонтирована — без ожидания, NOT_MOUNTED_NOTE', async () => { /* state.reply mounted true + register через 30 мс + did-stop-loading; mounted false — loaded false */ });

  it('screenshot с ref: прокрутка к элементу, снимок вьюпорта, вырезка рамки × (ширина PNG / CSS-ширина); элемент больше вьюпорта — видимая часть и заметка', async () => {
    // getLayoutMetrics 1280×800, PNG 2560×1600 (DPR 2), box { x: 100, y: 200, width: 300, height: 60 } → cropRect(png, { x: 200, y: 400, width: 600, height: 120 })
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-ops-control.test.ts src/main/browser/agent-ops.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - `navigate`: `resolveAgentUrl` → `bad_request` при `null`; переход — методом `webContents` внутри `withNavigation` (у `loadURL` отказ `ERR_ABORTED` — не ошибка: так бывает при скачивании); ответ — `url`, заголовок (маска, 200 знаков), `loaded`, заметки окна.
  - `resize`: `agentViewport` — пресет: `{ preset, rotated: rotated === true, dpr: <правило presetSpec из ViewportMenu.tsx: прежний DPR пресета или 2 у мобильных, 1 у прочих> }`; размеры — `{ width, height, mobile: false, dpr: текущий dpr или 1 }`; `fit` — `null`. `deps.resize(e)` (в `index.ts` — `hostWebContents.send('browser:agent-resize', e)`; `false` — окна нет → `window_not_connected`); ожидание `emulation.current(id)` равного спецификации (для `null` — `null`) раз в `pollMs` до `resizeMs`.
  - `open`: после ответа окна при `mounted` — ждать запись реестра с `webContentsId` (раз в `pollMs`), окно операции на время первой загрузки, затем загрузку (`isLoading()`/`did-stop-loading`) до `loadMs`; итог — `loaded`, `title`; при `!mounted` — `loaded: false`, `title: ''` и `NOT_MOUNTED_NOTE`.
  - `screenshot` с `ref`: `dom.nodeOf` → `DOM.scrollIntoViewIfNeeded` → прежний снимок без клипа → `dom.boxOf` в той же эмуляции → пересечение с вьюпортом → `image.cropRect` (в `index.ts` — `nativeImage.crop({ x, y, width, height })`); элемент шире или выше вьюпорта — заметка «The element is larger than the viewport; the screenshot shows its visible part.».

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS; `pnpm --filter @parley/desktop typecheck`.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-ops.ts packages/desktop/src/main/browser/agent-capture.ts packages/desktop/src/main/browser/agent-ops-control.test.ts packages/desktop/src/main/browser/agent-ops.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): browser_navigate and browser_resize, browser_open waits for the load, element screenshots" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 19. Main: операции `evaluate`, `cookies`, `storage`, `downloads`

**Файлы:**
- Изменить: `packages/desktop/src/main/browser/agent-ops.ts`, `packages/desktop/src/main/index.ts`
- Тест: `agent-ops-control.test.ts`

**Интерфейсы:**
- Берёт: `AgentScripts` (11), `AgentStorage` (12), `AgentDownloads` (10), `AgentDom.nodeOf` (16), `Inspector.sendAgentScript` (6).
- Отдаёт: четыре операции. `evaluate` — `{ changes: true, window: true }`; `cookies`, `storage` — без `changes`; `downloads` — без страницы (как `tabs`): список сессии `request.ref` и `dir`. `AgentOpsDeps` + `scripts`, `storage`, `downloads`.

- [ ] **Шаг 1. Падающие тесты (Фокус ревью 2, 3).**

```ts
describe('evaluate, cookies, storage, downloads', () => {
  it('evaluate на паузе, при выключенном доступе и у занятой страницы — отказ без sendAgentScript', async () => {
    const ctx = setup();
    ctx.register({ humanBusy: true });
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', expression: '1' }))).toBe('human_busy');
    ctx.register({ humanBusy: false });
    ctx.pause();
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', expression: '1' }))).toBe('access_denied');
    ctx.resume();
    ctx.allowed = false;
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', expression: '1' }))).toBe('access_denied');
    expect(ctx.scripts.evaluateOf).not.toHaveBeenCalled();
  });

  it('evaluate с ref — элемент из текущего снимка; устаревшая ссылка — stale_ref', async () => { /* nodeOf → 12 передан evaluateOf; после смены эпохи — stale_ref */ });

  it('Stop посреди evaluate — access_denied, результат не отдаётся', async () => {
    const ctx = setup();
    ctx.scripts.evaluateOf.mockImplementation((_c, _id, _args, _el, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const pending = ctx.run('evaluate', { tab: 't1', expression: 'while (true) {}' });
    await vi.waitFor(() => expect(ctx.scripts.evaluateOf).toHaveBeenCalled());
    ctx.ops.stop(7);
    expect(codeOf(await pending)).toBe('access_denied');
  });

  it('cookies и storage — только у своей страницы: чужая — no_tab, cookies.get не вызван', async () => {
    const ctx = setup({ owners: [{ kind: 'session', sessionId: 's-02' }] });
    ctx.registerForeign({ owner: { kind: 'session', sessionId: 's-09' }, pageId: 'bp-foreign' }); // t2 — чат другой сессии
    expect(codeOf(await ctx.run('cookies', { tab: 't2', action: 'list', values: true }))).toBe('no_tab');
    expect(codeOf(await ctx.run('storage', { tab: 't2', area: 'local', action: 'list' }))).toBe('no_tab');
    expect(ctx.storage.cookiesOf).not.toHaveBeenCalled();
    expect(ctx.storage.storageOf).not.toHaveBeenCalled();
  });

  it('downloads: список и папка своей сессии; у другой сессии той же работы — свой', async () => {
    const ctx = setup();
    ctx.downloads.list.mockReturnValue([{ id: 'd1', tab: 't1', name: 'a.csv', path: '/d/a.csv', url: 'http://localhost/a.csv', state: 'completed', receivedBytes: 3, totalBytes: 3, startedAt: '2026-10-20T10:00:00.000Z' }]);
    const result = okResult<BrowserAgentDownloadsResult>(await ctx.run('downloads', {}));
    expect(ctx.downloads.list).toHaveBeenCalledWith('/proj w-1', 's-02');
    expect(result.downloads).toHaveLength(1);
    expect(result.dir).toBe(ctx.downloads.dirOf('/proj w-1', 's-02'));
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-ops-control.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.** Четыре `case` в `run`; `evaluate` — `element = args.ref === undefined ? null : dom.nodeOf(contents, record, args.ref)`, затем `scripts.evaluateOf(contents, record.agentId, args, element, guard.signal)`; в `index.ts` — `createAgentScripts({ inspector })`, `createAgentStorage({ cookies: browserSession.cookies, inspector })` (раздел `BROWSER_PARTITION`), `agentDownloads` из задачи 15.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS; `pnpm --filter @parley/desktop typecheck`.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-ops.ts packages/desktop/src/main/browser/agent-ops-control.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): browser_evaluate, browser_cookies, browser_storage and browser_downloads in the window" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 20. Окно: занятость, размер от агента, Stop, значок, рамка, точка клика, фокус (‖ с 21)

**Файлы:**
- Изменить: `packages/desktop/src/renderer/browser/BrowserSurface.tsx`, `packages/desktop/src/renderer/browser/panel/agent-registry.ts`
- Создать: `packages/desktop/src/renderer/browser/agent-activity.ts` (состояние значка, точки и фокуса по событиям; чистые функции и маленький стор), `agent-activity.test.ts`
- Тесты: `BrowserSurface.test.tsx`, `panel/agent-registry.test.ts`

**Интерфейсы:**
- Берёт: `AgentBadge`, `BrowserChromeProps.agent`/`onAgentStop` (13); `onAgentResize`, `agentStop`, `agentFocusReady`, `AgentActivity.point`/`focus` (5); `pausePanel` (`panel/actions.ts`); `toggleBrowserMode`, `BrowserTabState.mode`; `setViewport` в `BrowserSurface.tsx`; `AGENT_LIMITS.guardTailMs`, `.clickDotMs`, `.badgeOps`, `.typingIdleMs`.
- Отдаёт: `reportAgentPage(bridge, workKey, owner, pageId, webContentsId, visible, humanBusy)` (седьмой аргумент); `useAgentActivity(webContentsId)` → `{ acting: { session, recent } | null; dot: { x, y } | null }`; `createFocusLender({ view(): HTMLElement | null; ready(id: string): void; typingIdleMs: number; now(): number })` → `{ borrow(id: string): void; restore(): void; dispose(): void }` (ветка спайка «одолжить фокус»).

- [ ] **Шаг 1. Падающие тесты.**

```ts
// agent-activity.test.ts
it('start — значок с ярлыком; end — значок ещё guardTailMs; recent — последние badgeOps операций', () => { /* фейковые таймеры vitest */ });
it('step с point — точка на clickDotMs', () => { /* … */ });
it('фокус (Фокус ревью 1): ждёт typingIdleMs тишины клавиатуры окна, ставит фокус на <webview>, подтверждает; на end возвращает фокус прежнему элементу, если фокус всё ещё на <webview>', async () => {
  vi.useFakeTimers();
  const chat = document.createElement('textarea'); document.body.append(chat); chat.focus();
  const view = document.createElement('div'); view.tabIndex = 0; document.body.append(view);
  const ready = vi.fn();
  const focus = createFocusLender({ view: () => view, ready, typingIdleMs: 1_000, now: () => Date.now() });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
  focus.borrow('f-1');
  await vi.advanceTimersByTimeAsync(900);
  expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(document.activeElement).toBe(view);
  expect(ready).toHaveBeenCalledWith('f-1');
  focus.restore();
  expect(document.activeElement).toBe(chat);
});
```

```tsx
// BrowserSurface.test.tsx — дописать (FakeBridge)
it('страница панели сообщает humanBusy при Select и Annotate', async () => { /* toggleBrowserMode(tabId, 'annotate') → browserCalls registerTab с humanBusy: true; off → false */ });
it('агент поставил размер — он ложится в раскладку страницы панели, как выбор человека', async () => { /* emitAgentResize({ webContentsId, viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } }) → updatePanelPage viewport */ });
it('Stop на значке: пауза панели и agentStop(webContentsId)', async () => { /* emitAgentActivity start → клик Stop → panel.paused, browserCalls agentStop */ });
it('рамка подсвечена, пока агент действует; точка клика — над <webview> в точке × scale + сдвиг stage', async () => { /* data-agent-acting="true"; [data-testid="agent-dot"] style left/top */ });
```

  `agent-registry.test.ts`: повторный отчёт с другим `humanBusy` уходит, с тем же — нет.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop test -- src/renderer/browser/agent-activity.test.ts src/renderer/browser/BrowserSurface.test.tsx src/renderer/browser/panel/agent-registry.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - `agent-registry.ts`: `humanBusy` в `Sent` и в записи; кеш сравнивает и его.
  - `agent-activity.ts`: `createFocusLender({ view, ready, typingIdleMs, now })` — `borrow(id)`: ждёт, пока последнее `keydown` окна (слушатель на `window`, фаза capture) старше `typingIdleMs`, не дольше `AGENT_LIMITS.opMs`; запоминает `document.activeElement` (если это не сам `<webview>`), `view.focus()`, `ready(id)`; `restore()`: если `document.activeElement === view` и запомненный элемент ещё в документе — `focus()` ему. Стор значка и точки — по `webContentsId`.
  - `BrowserSurface.tsx`: `reportAgentPage(…, state.mode !== 'off')`; подписка `onAgentResize` → `setViewport(e.viewport)`; подписка `onAgentActivity` → стор, `focus` → `lender.borrow(id)`, `end` → `lender.restore()`; `BrowserChrome` получает `agent` и `onAgentStop` (`pausePanel(workKey, owner, true)` и `bridge.browser.agentStop(webContentsId)`) у страницы панели; рамка — `ring-2 ring-primary` и `data-agent-acting` на поле страницы; точка — `div` `pointer-events-none` над `<webview>` в `left = stage.left + x × stage.scale` (без `stage` — `x`), 600 мс. Не трогать подписку C на `capture`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS; `pnpm --filter @parley/desktop typecheck`.

- [ ] **Шаг 5. Коммит.**

```bash
git add packages/desktop/src/renderer/browser/BrowserSurface.tsx packages/desktop/src/renderer/browser/BrowserSurface.test.tsx packages/desktop/src/renderer/browser/agent-activity.ts packages/desktop/src/renderer/browser/agent-activity.test.ts packages/desktop/src/renderer/browser/panel/agent-registry.ts packages/desktop/src/renderer/browser/panel/agent-registry.test.ts
git commit -m "feat(desktop): the window shows agent control — badge with Stop, frame, click dot; reports human busy, applies agent size, lends focus" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 21. Рамочные тесты агента в браузере (‖ с 20)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-frame.test.ts`
- Изменить: `packages/desktop/src/main/browser/design-mode.test.ts` (только если его рамочный тест мешает новым модулям)

**Интерфейсы:**
- Берёт: исходники `packages/desktop/src/main/**/*.ts` (без `.test.`), `CDP_ALLOWED`, `CDP_AGENT_SCRIPT`, `PAGE_FNS`.

- [ ] **Шаг 1. Написать тесты** (сканирование исходников, как рамочные тесты `inspector.test.ts` и `design-mode.test.ts`):
  - `sendAgentScript(` вызывается только в `browser/agent-evaluate.ts` (определение в `inspector.ts` не в счёт);
  - строка `'Runtime.evaluate'` встречается только в `inspector.ts` и `agent-evaluate.ts`;
  - `.cookies.get(`, `.cookies.set(`, `.cookies.remove(` — только в `agent-storage.ts`; там же адрес — только `contents.getURL()` (в файле нет параметра `url` у `cookiesOf`, проверка по тексту: `cookies.get({ url: page })` где `page` объявлен из `getURL()`);
  - `DOM.setFileInputFiles` — только в `agent-actions.ts`;
  - `setSavePath(` — только в `agent-downloads.ts` и в пути E2E `main/index.ts` (`__parleySaveAnswer`);
  - `executeJavaScript(` нет нигде в main; `executeJavaScriptInIsolatedWorld(` — только с `PICK_WORLD_ID` (уже есть — не дублировать, сослаться);
  - `Page.navigate` нет в `CDP_ALLOWED`; `Runtime.evaluate` нет в `CDP_ALLOWED`, есть в `CDP_AGENT_SCRIPT`;
  - в `agent-ops.ts` у `case 'evaluate'` — `changes: true` (по тексту между `case 'evaluate'` и следующим `case`).

- [ ] **Шаг 2. Запустить.** `pnpm --filter @parley/desktop test -- src/main/browser/agent-frame.test.ts` → PASS (это проверка готового кода; красный тест — находка, её чинит задача-владелец, а не этот тест).

- [ ] **Шаг 3. Коммит.**

```bash
git add packages/desktop/src/main/browser/agent-frame.test.ts
git commit -m "test(desktop): frame tests for agent browser control — single script entry, cookie scope, upload and download paths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 22. E2E: агент управляет страницей

**Файлы:**
- Создать: `packages/desktop/e2e/browser-agent-control.spec.ts`

**Интерфейсы:**
- Берёт: каркас `e2e/browser-agent-read.spec.ts` (`openApp`, `agentTool`, `openPage`, `tabsLoaded`, `panelOf`, `call`, `readLines`, `guestEval` — скопировать в файл, как принято в репозитории); стаб-агент `STUB_MCP <tool> <json>`; переключатели E2E `__parleyDownloads`/`__parleySaveAnswer`; `globalThis.__parleyAnnotate` (`count()`, `waiting()`) — только чтение.
- Внешний сайт — `--host-resolver-rules=MAP example.test 127.0.0.1` в `electron.launch` (спайк В13): `http://example.test:<порт>/` — не loopback.
- Ввод человека — только мышью и клавиатурой Playwright по окну (`window.mouse`, `window.keyboard`): `sendInputEvent` окна-хозяина в гостя не маршрутизируется (проба 2026-10-20).

- [ ] **Шаг 1. Тестовый сервер.** Страницы: `/form` (поле `#name` с выводом в `#echo` по `input`; кнопка Save → текст «Saved» через 300 мс; `<select>` Red/Blue; чекбокс; `<input type=file multiple>` с выводом имён; ссылка `/report.csv` с `Content-Disposition: attachment`; `console.error('token=SECRET5')`; `fetch('/api/me?access_token=SECRET6')` → 401); `/next`; `/state` (`window.__state = { user: 'ann' }`, `document.cookie = 'theme=dark'`, `localStorage.k = 'v'`). Кука `sid=S3SS` с `HttpOnly` ставится ответом `/form`.

- [ ] **Шаг 2. Тесты** (каждый — свой `openApp`, как в `browser-agent-read.spec.ts`):
  1. **Поток формы:** `browser_open` `/form` в свой чат → ответ «… loaded»; `browser_snapshot` `interactiveOnly` → ссылки; `browser_action type` в поле → `#echo` = текст; `click` Save; `browser_wait_for text Saved` → found; `select` Blue; `check`; `browser_console` и `browser_network` → `SECRET5`, `SECRET6` нет, есть `<redacted>`.
  2. **Ввод не попадает в Chat (Фокус ревью 1):** человек кликает в поле Chat и печатает `hello` (`window.keyboard`), агент сразу шлёт `type` `agent-text` в `#name`; итог: в поле Chat — `hello`, в `#echo` — `agent-text`, `document.activeElement` окна — поле Chat.
  3. **Переходы и устаревшая ссылка (Фокус ревью 7):** `snapshot` → `browser_navigate url /next` → `browser_action click` старой ссылкой → `stale_ref`; `navigate back` → адрес `/form`.
  4. **Размер:** `browser_resize preset mobile-m` → в госте `innerWidth` = 375, подпись размера у человека «375 × 812»; `fit` → эмуляции нет.
  5. **Внешний сайт (Фокус ревью 5):** `browser_open http://example.test:<порт>/form` → `snapshot`, `console`, `network`, `screenshot` — `ok`; `?token=` в адресе и `SECRET5`/`SECRET6` замаскированы.
  6. **Занятость:** человек включает Annotate (`menu:action browser.annotate`), ждёт `__parleyAnnotate.waiting()`; агент `click` → `human_busy`; `__parleyAnnotate.count()` = 0; чтение `console` — `ok`.
  7. **Stop (Фокус ревью 7):** агент `wait_for text Never` → человек жмёт Stop на значке → ответ `access_denied` «paused by the human», панель на паузе, следующий `console` — `access_denied`, «Resume agents» снимает.
  8. **Скрипт (Фокус ревью 2):** `browser_evaluate expression window.__state` → `{"user":"ann"}`; `expression foo` → «The script threw»; `expression while (true) {}` → `timeout`, после него `click` по кнопке — `ok` (страница жива); на паузе — `access_denied`.
  9. **Куки и хранилище (Фокус ревью 3):** `browser_cookies list` на `/state` → `theme`, `sid` (httpOnly) без значений; `values: true` → `S3SS`; `set` → `document.cookie` в госте содержит; `delete` → нет. Вкладка человека на `http://example.test:<порт>/` с кукой `human=1` — у страницы агента на `127.0.0.1` в списке нет `human`. `browser_storage set/get/list/clear` `localStorage` — видно в госте.
  10. **Файлы (Фокус ревью 4, 6):** `click` по полю файла → ответ с заметкой «file chooser … upload», в госте `input.files.length` = 0 (выбор перехвачен, системного окна нет); `upload` временным файлом → имя в странице; `click` по ссылке `/report.csv` → заметка со путём в `agent-downloads`, файл там, `browser_downloads` — `completed`; клик человека (`window.mouse`) по той же ссылке вне окна агента → запись в `__parleyDownloads` (диалог человека), в папке агента второго файла нет.

- [ ] **Шаг 3. Запустить.** `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop e2e -- e2e/browser-agent-control.spec.ts` → PASS. Повторно — `e2e/browser-agent-read.spec.ts` и `e2e/browser-agent-open.spec.ts` (их ожидания про loopback задачи 15 поменяли — поправить там же, этим коммитом).

- [ ] **Шаг 4. Коммит.**

```bash
git add packages/desktop/e2e/browser-agent-control.spec.ts packages/desktop/e2e/browser-agent-read.spec.ts packages/desktop/e2e/browser-agent-open.spec.ts
git commit -m "test(desktop): E2E for agent browser control — forms, focus, Stop, scripts, cookies, files, external sites" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 23. Документы: спека, индекс, спека окна, README, CHANGELOG

**Файлы:**
- Изменить: `docs/specs/2026-10-07-browser-devtools-agent-design.md`, `docs/specs/2026-10-07-browser-devtools-agent-plan.md`, `docs/specs/2026-09-26-desktop-orca-ui-design.md`, `README.md`, `CHANGELOG.md`

- [ ] **Шаг 1. Спека браузера.** Записка в шапке «2026-10-20: решения владельца — полное управление, JS, любые сайты, файлы, куки и хранилище; план `2026-10-20-browser-agent-control-plan.md`». Правки:
  - 1.5, критерий 3 — «на любом http(s)-сайте … исполняет JS по одобрению человека»; убрать «не может уйти с loopback, исполнить JS или прочитать куки»;
  - 2, п. 8 — полное управление на любых http(s) в панелях своего чата и комнат; «Никогда» — только разрешения сайта, другие схемы, вкладки человека; п. 9–11 — без изменений по смыслу, п. 10 — ещё `ref`; п. 14 — убрать «JS агентом и доступ к кукам»;
  - 3.3 — закрытый список: методы задачи 6, `Runtime.evaluate`/`Runtime.callFunctionOn` с функцией агента — только `sendAgentScript` из `agent-evaluate.ts`; `callFunctionOn` через `send` — `REACT_INFO_FN` и `SELECT_OPTION_FN`; куки — через `session.cookies`, не CDP;
  - 3.7 — ни слова о loopback у чтения; `open` ждёт загрузку;
  - 3.9 — новые файлы main (`agent-*.ts`, `ax-snapshot.ts`, `page-fns.ts`);
  - 4.8 — значок, рамка и точка рисует окно; Stop — пауза и обрыв;
  - 5.1 — таблица 14 инструментов; разрешения (всё заранее, кроме `browser_evaluate`; аннотации); блок «Как исполняется» — ввод по итогу спайка (фокус), `select` — `SELECT_OPTION_FN`, `wait_for` — дерево доступности, снимок элемента — вырезка; заметку 2026-10-16 о вводе закрыть ссылкой на `docs/research/2026-10-20-browser-agent-control-spike.md`; коды ошибок — 11, `not_loopback` — только окна до D, `navigation_blocked` — нет;
  - 5.2 — переписать: где можно (без loopback), окно операции (скачивания, выбор файла), `human_busy`, Stop, буфер обмена, фреймы; «Никогда» — разрешения, `file:`/`javascript:`/… , вкладки человека;
  - 5.3 — разделы скилла;
  - 6 — правило «явных значений» без маски;
  - 7 — `shared/loopback.ts` остаётся для поля `loopback` в `browser_tabs`, операции агента его не проверяют;
  - 8 — новые строки пределов (`AGENT_LIMITS` этапа D, скачивания, загрузка);
  - 9 — новые строки: внешний сайт, Stop посреди скрипта, скачивание в окне и вне, выбор файла, фрейм чужого origin («клики проходят, снимок фрейм не раскрывает»);
  - 10 — тесты этапа D; рамочный тест — по задаче 21;
  - 11 — текст 15.1 п. 9 и README (ниже);
  - 12 «Этап D» — состав по этому плану;
  - 13 — закрыть вопросы ввода и фреймов; **новый пункт о риске:** «Раздел `persist:harnas-browser` общий у человека и агентов. Агент на сайте, где человек вошёл во встроенном браузере, действует от имени человека: читает куки этого адреса (с `values: true` — значения), исполняет JS с его сессией, может удалить куку и разлогинить человека. Скрипт агента может оставить таймеры в странице: после Stop они живут до перезагрузки. Отдельный раздел для страниц агентов — возможное решение позже»; fuse `EnableCookieEncryption` — как было.
- [ ] **Шаг 2. Индекс плана.** Записка в шапке «2026-10-20: этап D — `2026-10-20-browser-agent-control-plan.md`; в «Глобальных ограничениях» пункты «только loopback», «`Runtime.evaluate` нет», «никогда — JS, куки, хранилища, файлы, другие сайты» для этапа D перекрыты решениями владельца 2026-10-20»; строка таблицы «Файлы плана» этапа D — новый файл.
- [ ] **Шаг 3. Спека окна** `2026-09-26-desktop-orca-ui-design.md`: 12.2 — пункт «**Агент управляет браузером**» вместо «Агент читает браузер» (кратко, ссылки на спеку браузера 3.7, 5.1, 5.2); 15.1 п. 9 — «Агент работает только в браузере своего чата и в браузерах комнат, где он участник: на любых http(s)-сайтах переходит, кликает, вводит, читает консоль, сеть и дерево страницы, снимает экран, меняет размер, загружает файлы в поля, получает скачанные файлы, читает и меняет куки и хранилище текущей страницы, а JS исполняет только после одобрения человека. Вкладки браузера человека агенту недоступны. Действия агента видны человеку; Stop и «Pause agents» ставят панель на паузу, выключатель в настройках выключает всё сразу».
- [ ] **Шаг 4. README.** «Legal boundary» (строка про embedded browser) — заменить: «the agent uses the embedded browser only in the browser panel of its own chat and of the rooms it belongs to: it opens, reads and drives pages on any http(s) site there, uploads files into page fields (never from secret locations such as ~/.ssh, keychains or .env files), receives downloads in a folder of its session, reads and changes the cookies and storage of the page it is on, and runs JavaScript only after you approve the browser_evaluate tool; the browser's cookies are shared with you, so an agent on a site where you are signed in acts as you; your own browser tabs are closed to it; Stop and Pause agents pause a panel, Settings turns it off;». Раздел об агентах и браузере (~строка 759) и Settings → Browser — те же факты коротко.
- [ ] **Шаг 5. CHANGELOG** — `## Unreleased` (над `## 0.18.0`), по-английски: «### Added» — «Agents drive their browser panels», «Any site», «Scripts with approval», «Files», «Cookies and storage», «Badge with Stop», «parley-browser skill»; «### Changed» — «Every browser tool is allowed in advance except browser_evaluate».
- [ ] **Шаг 6. Проверка.** `pnpm --filter @parley/desktop test -- src/release-docs.test.ts` → PASS (заголовки CHANGELOG).
- [ ] **Шаг 7. Коммит.**

```bash
git add docs/specs/2026-10-07-browser-devtools-agent-design.md docs/specs/2026-10-07-browser-devtools-agent-plan.md docs/specs/2026-09-26-desktop-orca-ui-design.md README.md CHANGELOG.md
git commit -m "docs(browser): stage D — full agent control, scripts with approval, any site, files, cookies and storage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 24. Живые проверки — ТОЛЬКО ПО ЯВНОМУ СОГЛАСИЮ ЧЕЛОВЕКА (тратит лимит подписки)

Перед каждым запуском `claude`, `codex` или GLM — спросить человека и ждать явного «да». Без согласия задача пропускается с пометкой в отчёте.

- [ ] **Шаг 1. Claude Code со скиллом** на учебном приложении (dev-сервер в проекте): правка → `browser_open` → `snapshot` → `action` (форма) → снимки 1280 и 375 → ошибка консоли → починка → повтор. Проверить: `browser_*`, кроме `browser_evaluate`, не спрашивают; `browser_evaluate` спрашивает при первом вызове; ответ «Don't ask again» пишет правило только в файлы проекта, не в `~/.claude`.
- [ ] **Шаг 2. Codex** — тот же сценарий: спрашивает только про `browser_evaluate`; картинка снимка видна (или `view_image`).
- [ ] **Шаг 3. GLM** — снимок и одно действие.
- [ ] **Шаг 4. Отчёт** — в описание будущего PR: что спрашивалось, сколько операций, задержки (`op:"browser.agentOp"` в `host.log`), найденное.

---

## Задача 25. Завершение этапа и финальная рецензия

- [ ] **Шаг 1.** `pnpm typecheck` и `pnpm exec eslint packages/protocol/src packages/core/src/mcp packages/core/src/work packages/desktop/src/main packages/desktop/src/renderer/browser packages/desktop/src/shared` → без ошибок.
- [ ] **Шаг 2.** Тесты всех файлов, изменённых веткой: `git diff --name-only origin/master...HEAD | grep -E '\.test\.tsx?$'` — по пакетам `pnpm --filter <пакет> test -- <файлы>`; E2E — `e2e/browser-agent-*.spec.ts`. Полный прогон не нужен.
- [ ] **Шаг 3. Визуальная проверка** в dev-окне (`pnpm dev`): 800×500 и DPR 2 — значок со Stop не ломает строку, точка клика в нужном месте при эмуляции.
- [ ] **Шаг 4. Финальная рецензия ветки — Opus** (навык superpowers:requesting-code-review): по «Фокусу ревью» и «Решениям плана»; правки — отдельными коммитами.
- [ ] **Шаг 5.** Push и PR — только по просьбе человека; описание PR кончается строкой `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Оценка

26 задач (0–25).

| Пачка | Задачи | Объём (грубо) |
|---|---|---|
| 0. База | 2 | слияние — минуты; спайк — 3–5 ч работы агента, ~0 строк продукта |
| 1. Контракт | 4 | ~1 300 строк (протокол ~350, core ~700, мост ~250), из них половина — тесты |
| 2. Кирпичи | 9 | ~2 800 строк, параллельно; каждый модуль 150–400 строк кода + тест |
| 3. Операции main | 5 | ~2 000 строк, последовательно — самая длинная цепочка |
| 4. Окно и проверки | 3 | ~1 300 строк (окно ~500, рамочные ~200, E2E ~600) |
| 5. Документы и выпуск | 3 | ~250 строк документов; живые проверки — по согласию |

Итого ~7–8 тыс. строк с тестами. Последовательный путь: 0 → 1 → 2 → (2…4 цепочка core) → пачка 3 (5 задач подряд) → 20 → 22 → 23 → 25.

## Самопроверка плана

- **Покрытие решений владельца:** объём старого D — задачи 3, 7, 13, 16–18, 20; JS — 6, 11, 19; любые сайты — 0, 15, 22; файлы — 10, 15, 17; куки и хранилище — 12, 19; разрешения и аннотации — 4; защита (Stop, `human_busy`, `stale_ref`, очередь, пределы, маска дерева) — 7, 9, 15–17; буфер обмена — 9 (`selectAll`), 11 (`userGesture: false`); спайк 0.4 — 1; документы — 23; живые — 24.
- **Имена между задачами:** `createPageRunner` и `InputGuard` (15) — в 16–19; `AgentDom` (16) — в 17–19; `withNavigation` (17) — в 18; `fitOf` (9) — в 17; `AgentWindow.take` (8) — в 15, 17, 18; `AgentScriptSender` (11) совместим с `Inspector` (6) по сигнатурам; `reportAgentPage` с `humanBusy` (20) читает `AgentPageRegistration.humanBusy` (5).
- **Красные между задачами (ожидаемо):** контрактные тесты протокола и хоста — от задачи 2 до 4; тесты `agent-ops.test.ts` про loopback — до задачи 15; E2E `browser-agent-read`/`-open` про loopback — до задачи 22.
