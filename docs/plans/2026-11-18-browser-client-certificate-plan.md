# План: клиентский сертификат по выбору человека (SSO с mTLS)

> **Исполнителю:** прочитай «Global Constraints» и «Решения, принятые при планировании», затем только свою задачу. Шаги — флажки `- [ ]`, иди по порядку. Чужих файлов не трогай; если задача без них не делается, остановись и напиши ведущему.

**Goal:** Сайт, который просит клиентский сертификат, получает его после выбора человеком в слое над вкладкой; выбор запоминается по `хост:порт` и действует для страниц агента.

**Architecture:** Меняется только окно (`packages/desktop`) и текст навыка в core. Решение принимает новый модуль main `client-cert.ts`: страж передаёт ему событие `select-client-certificate`, модуль отвечает сам (не гость, пустой список, запомненный выбор) или спрашивает окно-хозяина гостя по каналу `browser:cert-*`. Образец во всём — HTTP basic-auth (`basic-auth.ts`, `AuthPrompt.tsx`): тот же путь запроса, отмены и ответа.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes: true`), Electron 44.4.5, React 18, Tailwind 4, vitest 2 + jsdom + @testing-library/react.

**Spec:** `docs/specs/2026-11-18-browser-client-certificate-design.md`. При расхождении спеки и плана в именах и файлах верен план; в поведении — спека.

**База:** ветка `feat/browser-client-certificate` от свежего `origin/master`. Факты сверены с `origin/master` 196850cf (v0.37.1); номера строк — ориентир, искать по имени. Короткие пути: `main/…`, `renderer/…`, `shared/…`, `preload/…` — от `packages/desktop/src/`. Спека и план лежат в основной рабочей копии вне git; в ветку их добавляет последний коммит задачи 5.

## Ход исполнения

Заполняет ведущий после каждой задачи: что сделано, чем проверено, коммиты.

| Задача | Состояние |
|---|---|
| 0 | |
| 1 | |
| 2 | |
| 3 ∥ 4 | |
| 5 | |
| 6 | |

## Решения, принятые при планировании

| Вопрос | Решение |
|---|---|
| Ключ памяти | `хост:порт` с явным портом. Событие отдаёт его готовым (`auth.example.com:6443`); из адреса страницы он считается: `hostPortOf('https://auth.example.com/x')` → `auth.example.com:443` |
| Что хранится | Отпечаток `Certificate.fingerprint` Electron как есть. Файл `<дом Parley>/desktop/browser-client-certs.json`, вид `{ "version": 1, "choices": { "auth.example.com:6443": "sha256/…" } }`, запись — `writeAtomic` и `createFileQueue` из `main/atomic-file.ts` |
| Выбор без галочки | Parley не хранит: до выхода из Parley его помнит Chromium (поправка 1) |
| Кто гость | `contents.getType() === 'webview' && contents.session === session.fromPartition(BROWSER_PARTITION)`; проверку даёт `index.ts` зависимостью `isGuest` |
| Ответ окна | Окно шлёт отпечаток, не сертификат. Отпечаток не из списка запроса — как отмена |
| Запрос висит, вкладка ушла | Как у basic-auth: `did-start-navigation` главного фрейма не в том же документе и `destroyed` снимают запрос ответом без сертификата |
| «Список пуст» | Событие `browser:cert-notice` окну-хозяину; окно показывает его тостом `toast(…)` из `sonner`, как остальные тосты `BrowserSurface.tsx` |
| Заметка агенту | Отдельная константа `CLIENT_CERT_HINT`; ожидание человека для `settleLoad` — объединение basic-auth и сертификата функцией `humanWait` |
| Снимок при висящем запросе | Не меняется (у basic-auth он отдаёт подсказку вместо дерева; сертификату это не нужно: старая страница ещё на месте) |
| Журнал | Зависимость `log(line)`; `index.ts` передаёт запись в консоль main: `console.info('[parley] client certificate', JSON.stringify(line))` |
| Автоматический E2E | Нет: нужен сертификат в Связке ключей. Unit с подставным `app` и тест компонента |

## Поправка 1 — после спайка (2026-11-18)

Отчёт: `docs/research/2026-11-18-browser-client-certificate-spike.md` (ветка исполнителя, коммит a15b6d8e). Где текст задач ниже расходится с этим разделом, верен этот раздел.

**Что показал замер**
- Аргумент `url` события — `хост:порт` без схемы (`127.0.0.1:18444`), не адрес.
- Ответ на `хост:порт` — и сертификат, и отказ — Chromium помнит, пока жив раздел, то есть до выхода из Parley. Второго события для того же `хост:порт` в этом запуске нет. Сбросить это нельзя: ни `closeAllConnections`, ни `clearAuthCache`, ни `clearStorageData`, ни `clearCache`, ни `clearData` не помогают.
- Одновременные запросы приходят отдельными событиями, каждому нужен свой `callback`.
- После `callback(cert)` macOS показывает своё окно доступа к ключу; рукопожатие ждёт ответа человека без срока. Parley этого окна не видит.
- Предзапрос CORS несёт сертификат; режим `credentials` на событие не влияет.

**Что меняется в задачах**
1. `hostPortOf` принимает оба вида: `хост:порт` (как в событии) и адрес `https://…`; отдаёт `хост:порт`.
2. Память Parley — только выборы с галочкой, на диске. Выбор без галочки Parley не хранит: до выхода его помнит сам Chromium. В `CertChoiceStore` метод `set(hostPort, fingerprint)` без флага `persist`; `answer(…, remember: false, …)` в хранилище не пишет.
3. В слое выбора — строка под списком: `S.browser.cert.keyAccess`.
4. «Clear browsing data» стирает сохранённые выборы; сайт, на который в этом запуске уже ответили, спросит снова только после перезапуска Parley. Строка CHANGELOG и приёмка — в этих словах.
5. В навыке вторая строка в Troubleshooting — про окно macOS.

**Два правила зависят от добавочных замеров пункта 1 (вопросы 6 и 7). Ведущий называет ветку в комнате до старта задачи 1.**

> **Выбрано ведущим 2026-11-18 по отчёту (коммит 0900e43f):** вопрос 6 — **«не приходит»**; вопрос 7 — **«не сейчас»**. Задачи 1–5 исполняются по этим веткам; другая ветка каждого вопроса не делается.
> Оговорка к «не сейчас»: при живой вкладке забытый запрос страницы кончается сам примерно через 28 с ошибкой TLS (замер 7в); придёт ли после этого событие для следующего запроса, не замерено — проверяет живая приёмка.

Вопрос 6: приходит ли событие, когда сервер просит сертификат, а подходящих в связках нет.
- *Приходит с пустым списком* — ветка «пустой список» остаётся как в задачах 1–3.
- *Не приходит* — ветка мёртвая: из задач 1–3 уходят исход `empty`, событие `browser:cert-notice`, `BrowserCertNotice`, `onCertNotice`, `S.browser.cert.none` и их тесты.

Вопрос 7: что будет, если на событие не ответить вовсе (`callback` не вызван, ссылка на него отпущена), а вкладка ушла со страницы или закрыта: придёт ли событие для того же `хост:порт` при следующем запросе, и чем кончится оставленный запрос.
- *Ветка «не сейчас»* (событие приходит снова, оставленный запрос не держит вкладку): отмена — это «не сейчас». Кнопка `Not now`, `Escape`, уход со страницы и закрытие вкладки забывают запрос **без вызова `callback`**; ждавшие того же ответа запросы забываются так же. Ограничение «`callback` зовётся ровно один раз» читается как «не больше одного раза; у забытого запроса — ни разу». Журнал: `cancelled`.
- *Ветка «отказ»* (иначе): кнопка `Cancel` зовёт `callback()` и это отказ до перезапуска. В слое над кнопками — строка `S.browser.cert.cancelWarning`; `Escape` слой не закрывает. Уход со страницы и закрытие вкладки тоже зовут `callback()`.

Строки к блоку `S.browser.cert` (задача 3):

```ts
keyAccess: 'macOS may then ask for access to the key. Choose "Always Allow", or agents will stop at that window.',
notNow: 'Not now',                                                                       // ветка «не сейчас», вместо cancel
cancelWarning: 'If you cancel, this site will not ask again until you restart Parley.',  // ветка «отказ»
```

Строка навыка (задача 4, вторая): `` - A page that keeps loading right after the human chose a certificate may wait for a macOS key access window: ask the human to answer it with "Always Allow". ``

Строка CHANGELOG (задача 5) вместо прежней: `- Built-in browser: sites that ask for a client certificate (SSO over mTLS) now show a chooser over the tab. The choice can be saved per site; "Clear browsing data" removes the saved choices, and a site already answered in this run asks again after Parley restarts.`

## Global Constraints

- Правила исполнителей — `docs/plans/2026-11-10-review-fixes/executor-rules.md`: vitest не запускать, приложение не стартовать, `pnpm install` не звать; тесты пишутся, гоняет их CI. Шаг «Проверка» каждой задачи — команды из раздела «Checks» этих правил для изменённых пакетов и `pnpm exec eslint <изменённые файлы>`.
- Подписи окна и тексты агенту — по-английски, только из `S` (`shared/strings.ts`) или из констант, названных в задаче. Комментарии и названия тестов — по-русски. Страж `packages/desktop/src/english-ui.test.ts` не пускает кириллицу в строковые литералы.
- `callback` события зовётся ровно один раз в каждой ветке. `event.preventDefault()` — всегда.
- Приватных ключей, имён субъектов и отпечатков в журнале нет.
- Необязательное поле, которого может не быть, передаётся условным разворотом: `{...(x === undefined ? {} : { x })}`.
- Тесты окна: без jest-dom, `cleanup` вручную, проверки через `toBeTruthy`, `toBeNull`, `getAttribute`. Образцы: `main/browser/basic-auth.test.ts`, `main/browser/guard.test.ts` (`setupGuard`, `fakeContents`, `fakeEvent`), `renderer/browser/AuthPrompt.test.tsx`.
- Рамочный тест `main/browser/agent-frame.test.ts` закрепляет, в каких файлах встречаются `Runtime.evaluate`, `Input.dispatch…`, `executeJavaScript(`: в новый код эти строки не писать.
- Один коммит на задачу, заголовок — из последнего шага задачи. Push и pull request — только по слову человека. Описание PR несёт карточку влияния (`PARLEY.md`).

## Review Focus

1. **Не гость не получает сертификат.** Событие от главного окна, острова или `contents === null` — ответ без сертификата, окну ничего не шлётся. Тест — задача 1.
2. **Окно не может подсунуть сертификат.** Отпечаток, которого нет в списке запроса, и ответ от чужого `sender` — отмена и игнор. Тесты — задачи 1 и 2.
3. **Запрос не повисает.** Вкладка ушла со страницы или закрыта — `callback` вызван один раз, очередь других хостов продолжается. Тест — задача 1.
4. **Запомненный, но пропавший сертификат.** Отпечатка нет в `list` — запись снята из памяти и с диска, человек спрошен. Тест — задача 1.
5. **Битый файл выборов.** Не JSON или не та форма — пустая память, приложение стартует, файл не затирается до первой записи. Тест — задача 1.

## Порядок исполнения

| Шаг | Задачи | После |
|---|---|---|
| A | 0 (спайк) | Ведущий читает отчёт и, если нужно, правит раздел 3 спеки и задачи 1–4 |
| B | 1 → 2 | Проверки задач; диф задачи 1 читает старшая модель (безопасность) |
| C | 3 ∥ 4 | Файлов не делят: 3 — рендерер, 4 — `agent-*.ts`, `index.ts`, навык |
| D | 5 | Итоговые проверки, ревью ветки старшей моделью, PR по слову человека |
| E | 6 | Живая приёмка человеком |

`main/index.ts` правят задачи 1, 2 и 4 — строго по очереди.

---

### Task 0: Спайк на локальном стенде mTLS

**Files:**
- Create: `docs/research/2026-11-18-browser-client-certificate-spike.md`
- Скрипты и сертификаты — в scratchpad сессии, в репозиторий не входят.

**Вопросы (каждый — замером):**
1. Что в `list` события: поля `subjectName`, `issuerName`, `fingerprint`, `validExpiry` у сертификата из временной связки.
2. Приходит ли событие для `fetch` страницы на другой порт (`credentials: 'include'` и без) и для подфрейма; какой у него `webContents` и `url`.
3. Несёт ли сертификат предварительный запрос CORS (`OPTIONS`), если сервер требует сертификат на рукопожатии.
4. После `callback(cert)`: приходит ли событие для того же `хост:порт` снова в том же запуске. После `callback()`: приходит ли снова при перезагрузке страницы; если нет — чем сбросить без перезапуска (`session.closeAllConnections()`, `session.clearAuthCache()`).
5. Показывает ли macOS запрос доступа к ключу в dev-Electron.

- [ ] **Шаг 1.** Записать `security list-keychains -d user` в файл scratchpad — «до».
- [ ] **Шаг 2.** Выпустить тестовый центр, сертификат сервера для `127.0.0.1` и клиентскую пару (`openssl`), собрать `.p12`. Создать временную связку (`security create-keychain`), импортировать `.p12`, добавить связку в список поиска пользователя, сохранив прежние.
- [ ] **Шаг 3.** Сервер Node `https` на двух портах `127.0.0.1` (спека 5.1) и стенд Electron 44.4.5 по образцу `docs/research/2026-10-20-browser-agent-control-spike.md`: `<webview>`, раздел, страж как у Parley; сертификат сервера принимает только стенд. Обработчик `select-client-certificate` стенда пишет аргументы в журнал и отвечает по сценарию вопроса.
- [ ] **Шаг 4.** Прогнать вопросы 1–5, записать замеры.
- [ ] **Шаг 5. Уборка.** Вернуть список поиска к записанному, `security delete-keychain` временной связки, стереть тестовые файлы. `security list-keychains -d user` «после» совпадает с «до» дословно — оба вывода в отчёт.
- [ ] **Шаг 6.** Отчёт: вопрос — замер — вывод; отдельной строкой — что из раздела 3 спеки замер подтверждает, а что требует правки.
- [ ] **Шаг 7. Коммит:** `docs(research): record the client certificate spike`

**Добавочные замеры (поправка 1).** Подпись в них не нужна, окна macOS быть не должно. Временная связка, сервер и стенд — заново, по тем же правилам и с той же уборкой.

6. Сервер просит сертификат (порты B и C), подходящих в связках нет (временная связка не добавлена в список поиска): приходит ли событие и с каким `list`; что получает сервер.
7. Сертификат в списке есть. Стенд на событие не отвечает: `callback` не вызывается, ссылка на него отпускается. Затем (а) вкладка уходит на другую страницу, (б) `<webview>` удаляется из DOM. После каждого — новый запрос к тому же `хост:порт` в том же запуске: приходит ли событие снова. Чем и когда кончился оставленный запрос (`fetch` упал, висит, сколько ждали); растёт ли число открытых соединений сервера.

- [ ] **Шаг 8.** Дописать в отчёт раздел «Добавочные замеры» с вопросами 6 и 7 и вывод: какая ветка поправки 1 следует из каждого. Уборка — снова с выводом `security list-keychains -d user` до и после.
- [ ] **Шаг 9. Коммит:** `docs(research): add the empty list and unanswered request measurements`

---

### Task 1: Модуль решения и страж

**Files:**
- Create: `shared/client-cert.ts`, `main/browser/client-cert.ts`, `main/browser/client-cert.test.ts`
- Modify: `main/browser/guard.ts` (обработчик `select-client-certificate`, зависимость `clientCert`), `main/browser/guard.test.ts`, `main/index.ts` (создание модуля, зависимость стража)

**Interfaces — Produces:**

```ts
// shared/client-cert.ts
export interface ClientCertInfo { fingerprint: string; subjectName: string; issuerName: string; serialNumber: string; validExpiry: number }
export interface BrowserCertRequest { requestId: string; webContentsId: number; host: string; pageHost: string | null; certificates: ClientCertInfo[] }
export interface BrowserCertCancel { requestId: string; webContentsId: number }
export interface BrowserCertNotice { webContentsId: number; host: string }

// main/browser/client-cert.ts
export const CLIENT_CERT_HINT = 'The site asks for a client certificate: ask the human to choose it in the browser panel.';
export type CertOutcome = 'asked' | 'remembered' | 'empty' | 'denied-not-guest' | 'cancelled' | 'chosen';
export function hostPortOf(value: string): string | null;          // 'a.b:6443' как есть; 'https://a.b/x' → 'a.b:443'; http и мусор — null
export interface CertChoiceStore {
  load(): Promise<void>;                                           // битый файл — пусто, без исключения
  get(hostPort: string): string | null;
  set(hostPort: string, fingerprint: string): Promise<void>;       // только выбор с галочкой; всегда на диск
  delete(hostPort: string): Promise<void>;
  clear(): Promise<void>;
}
export function createCertChoiceStore(deps: { file: string }): CertChoiceStore;
export interface ClientCert {
  select(contents: WebContents | null, url: string, list: Certificate[], callback: (certificate?: Certificate) => void): void;
  attach(contents: WebContents): void;                             // did-start-navigation, destroyed
  isPending(contentsId: number): boolean;
  onPending(contentsId: number, listener: () => void): () => void;
  answer(requestId: string, fingerprint: string | null, remember: boolean, sender: WebContents): void;
  clear(): Promise<void>;                                          // память и файл
}
export function createClientCert(deps: {
  isGuest(contents: WebContents): boolean;
  store: CertChoiceStore;
  newId?(): string;
  log?(line: { host: string; count: number; outcome: CertOutcome }): void;
}): ClientCert;
/** Ожидание человека для settleLoad: basic-auth или сертификат. Оба undefined — undefined. */
export function humanWait(
  basicAuth?: Pick<BasicAuth, 'isPending' | 'onPending'>,
  clientCert?: Pick<ClientCert, 'isPending' | 'onPending'>,
): Pick<BasicAuth, 'isPending' | 'onPending'> | undefined;
```

`pageHost` — `host` адреса страницы гостя (`contents.getURL()`), когда его `хост:порт` отличается от запрошенного; иначе `null`. Событие окну — `host.send('browser:cert-request', …)`, `'browser:cert-cancel'`, `'browser:cert-notice'`, где `host` — `contents.hostWebContents`.

- [ ] **Шаг 1. Тесты `client-cert.test.ts`** (подставные `WebContents` — как в `basic-auth.test.ts`):

  | Тест | Проверка |
  |---|---|
  | `hostPortOf: оба вида` | `'127.0.0.1:18444'` → `'127.0.0.1:18444'`; `'https://auth.example.com/x'` → `'auth.example.com:443'`; `'https://a.b:6443/'` → `'a.b:6443'`; `'http://a.b/'`, `'nope'`, `'a.b'`, `'a.b:99999'` → `null` |
  | `не гость — отказ` | `isGuest` → `false` и `contents === null`: `callback` вызван один раз без аргументов, `send` окна не вызван, журнал `denied-not-guest` |
  | `пустой список — отказ и уведомление` | `callback()` один раз; окну ушёл `browser:cert-notice` с `host: 'auth.example.com:6443'`; журнал `empty`, `count: 0` |
  | `запомненный отпечаток в списке — без вопроса` | `callback` вызван с тем же объектом сертификата из `list`; запроса окну нет; журнал `remembered` |
  | `запомненный отпечаток пропал — запись снята, вопрос задан` | `store.get` после события → `null`; окну ушёл `browser:cert-request` |
  | `вопрос: поля запроса` | `certificates` несёт пять полей `ClientCertInfo`; `pageHost` — `'example.com'` при странице `https://example.com/login` и запросе к `auth.example.com:6443`, `null` при том же `хост:порт`; `isPending(id)` → `true`; слушатель `onPending` вызван |
  | `ответ с отпечатком из списка` | `answer(id, fp, false, host)` → `callback(cert)`, `store.set` не вызван. С `remember: true` — `store.set(hostPort, fp)`. Журнал `chosen` |
  | `ответ null — отмена` | По ветке вопроса 7 (поправка 1): «не сейчас» — `callback` не вызван ни разу, запрос забыт; «отказ» — `callback()` без аргументов. В обеих `store.get` → `null`, журнал `cancelled` |
  | `отпечаток не из списка — отмена` | как `null` |
  | `чужой sender и неизвестный requestId — игнор` | `callback` не вызван, запрос висит |
  | `второй запрос к тому же хост:порт ждёт первого` | окну ушёл один запрос; после ответа вызваны оба `callback` с одним сертификатом |
  | `запрос к другому хост:порт — в очередь` | второй `browser:cert-request` уходит только после ответа на первый |
  | `уход со страницы снимает запрос` | `did-start-navigation` `{ isMainFrame: true, isSameDocument: false }` → окну `browser:cert-cancel`, следующий из очереди показан; `callback` — по ветке вопроса 7; `destroyed` — то же без события окну |
  | `хранилище: файл` | `set(k, fp)` пишет `{ version: 1, choices: { [k]: fp } }`; `load` битого файла (`'{'`, `[]`, `{ choices: 5 }`) даёт пустую память и не бросает; `clear` стирает память и пишет пустые `choices` |
  | `humanWait` | оба `undefined` → `undefined`; `isPending` истинен, если истинен любой; отписка `onPending` снимает обоих |
  | `в журнале нет имён и отпечатков` | у каждой записи журнала ключи ровно `host`, `count`, `outcome` |

- [ ] **Шаг 2. Тест `guard.test.ts`.** Заменить тест `select-client-certificate — preventDefault и callback() без сертификата`: событие уходит в `deps.clientCert.select` с теми же `contents`, `url`, `list`, `callback`; `event.defaultPrevented` → `true`. Без зависимости `clientCert` — прежнее поведение (`callback()` без аргументов): тест остаётся вторым случаем. Гость (`fakeContents(42, 'webview')`) получает `clientCert.attach`.
- [ ] **Шаг 3. Реализация** `shared/client-cert.ts` и `main/browser/client-cert.ts` по интерфейсам выше; порядок веток `select` — таблица раздела 3 спеки.
- [ ] **Шаг 4. Страж.** В `BrowserGuardDeps` — `clientCert?: Pick<ClientCert, 'select' | 'attach'>`. Обработчик: `event.preventDefault()`, затем `deps.clientCert === undefined ? callback() : deps.clientCert.select(contents, url, list, callback)`. `guardGuest` зовёт `deps.clientCert?.attach(contents)` рядом с `deps.basicAuth?.attach(contents)`. Комментарий над обработчиком переписать: сертификат отдаётся только по выбору человека, ссылка на спеку.
- [ ] **Шаг 5. `index.ts`.** Рядом с `createBasicAuth()`: хранилище с файлом `path.join(parleyHome(), 'desktop', 'browser-client-certs.json')`, `void store.load()`, `createClientCert({ isGuest, store, log })` по «Решениям»; передать `clientCert` в `installBrowserGuard`.
- [ ] **Шаг 6. Проверка** — Global Constraints.
- [ ] **Шаг 7. Коммит:** `feat(desktop): ask the human before presenting a client certificate`

---

### Task 2: Канал окна

**Files:**
- Modify: `main/ipc.ts` (обработчик `browser:cert-response`, зависимость `browser.clientCert`), `preload/index.ts`, `shared/browser-types.ts` (мост), `main/index.ts` (зависимость `registerIpc`); тесты рядом с каналом `browser:auth-response` (найти по имени канала)

**Interfaces:**
- Consumes: `ClientCert.answer`, типы `shared/client-cert.ts` (задача 1).
- Produces — мост `bridge.browser`:

```ts
onCertRequest(listener: (e: BrowserCertRequest) => void): () => void;
onCertCancel(listener: (e: BrowserCertCancel) => void): () => void;
onCertNotice(listener: (e: BrowserCertNotice) => void): () => void;
/** `null` — отмена. */
certResponse(requestId: string, answer: { fingerprint: string; remember: boolean } | null): Promise<void>;
```

Канал: `ipcRenderer.invoke('browser:cert-response', requestId, answer === null ? null : answer.fingerprint, answer?.remember === true)`.

- [ ] **Шаг 1. Тесты канала** (по образцу тестов `browser:auth-response`): `requestId` не строка, пустой или длиннее 64 → `bad_request`; `fingerprint` не `null` и не строка, или длиннее 256 → `bad_request`; `remember` не `boolean` → `bad_request`; верный вызов → `clientCert.answer(requestId, fingerprint, remember, sender)` с `sender` события; `null` → `answer(requestId, null, false, sender)`.
- [ ] **Шаг 2. `main/ipc.ts`:** обработчик рядом с `browser:auth-response`, в `browser` зависимостей — `clientCert: Pick<ClientCert, 'answer' | 'clear'>`.
- [ ] **Шаг 3. `preload/index.ts` и `shared/browser-types.ts`:** три набора слушателей и `certResponse` по образцу `onAuthRequest`, `onAuthCancel`, `authResponse`.
- [ ] **Шаг 4. `index.ts`:** передать `clientCert` в `registerIpc` рядом с `basicAuth`.
- [ ] **Шаг 5. Проверка.** Подставные мосты тестов рендерера (найти `authResponse` в `renderer/**/test-utils` и `*.test.tsx`) получают новые методы, иначе typecheck тестов упадёт.
- [ ] **Шаг 6. Коммит:** `feat(desktop): add the window channel for the client certificate choice`

---

### Task 3: Слой выбора над вкладкой

**Files:**
- Create: `renderer/browser/CertPrompt.tsx`, `renderer/browser/CertPrompt.test.tsx`
- Modify: `renderer/browser/BrowserSurface.tsx`, `shared/strings.ts`; тест `BrowserSurface` рядом с проверками `AuthPrompt` (найти по `browser-auth`)

**Interfaces:**
- Consumes: мост задачи 2, типы задачи 1.
- Produces:

```ts
export interface CertPromptProps {
  request: BrowserCertRequest;
  failed?: boolean;
  onSubmit(answer: { fingerprint: string; remember: boolean } | null): void;
}
export function CertPrompt(props: CertPromptProps): JSX.Element;   // data-testid="browser-cert"
```

Строки — блок `S.browser.cert` рядом с `S.browser.auth`:

```ts
cert: {
  title: (host: string): string => `${host} asks for a certificate that identifies you.`,
  requestedBy: (pageHost: string): string => `Requested by the page ${pageHost}.`,
  issuer: (name: string): string => `Issued by ${name}`,
  expires: (date: string): string => `Valid until ${date}`,
  serial: (serial: string): string => `Serial ${serial}`,
  remember: "Remember for this site. Agents working in Parley's browser will be identified by it too.",
  use: 'Use certificate',
  cancel: 'Cancel',
  sendFailed: "Couldn't send the choice. Try again or cancel.",
  none: (host: string): string => `${host} asked for a client certificate, but macOS Keychain has none that Parley can use.`,
},
```

Дата — `new Date(validExpiry * 1000).toLocaleDateString()`.

- [ ] **Шаг 1. Тесты `CertPrompt.test.tsx`:**
  - один сертификат: радио выбрано заранее; кнопка `Use certificate` → `onSubmit({ fingerprint, remember: false })`;
  - три сертификата: первый выбран; выбор третьего и галочка → `onSubmit({ fingerprint: третий, remember: true })`;
  - `pageHost: 'example.com'` → есть строка `Requested by the page example.com.`; `null` → строки нет;
  - `Escape` и кнопка `Cancel` → `onSubmit(null)`;
  - `failed` → `role="alert"` с `S.browser.cert.sendFailed`;
  - новый `requestId` сбрасывает галочку и выбор на первый.
- [ ] **Шаг 2. `CertPrompt.tsx`:** разметка и классы — по `AuthPrompt.tsx` (тот же слой `absolute inset-0 z-30`, карточка `max-w-sm`, прокрутка внутри слоя). Список — `radiogroup`, строка сертификата: имя субъекта (`break-all`), ниже мелко издатель, срок, серийный номер. Фокус при появлении — на выбранном радио.
- [ ] **Шаг 3. `BrowserSurface.tsx`:** состояние и подписки — копия пути `authRequest` (`certRequest`, `currentCertIdRef`, `dismissCert`, `certFailed`, `answerCert`), фильтр по `webContentsId` своей вкладки тот же. Рендер: `certRequest === null ? null : <CertPrompt … />` рядом с `AuthPrompt`; если висят оба, сверху basic-auth. `onCertNotice` своей вкладки → `toast(S.browser.cert.none(e.host))` (`sonner`, уже импортирован в файле).
- [ ] **Шаг 4. Тест `BrowserSurface`:** событие `onCertRequest` своей вкладки рисует `browser-cert`, чужой вкладки — нет; `onCertCancel` с тем же `requestId` убирает; ответ зовёт `certResponse`.
- [ ] **Шаг 5. Проверка.**
- [ ] **Шаг 6. Коммит:** `feat(desktop): show the client certificate chooser over the tab`

---

### Task 4: Агент видит ожидание выбора

**Files:**
- Modify: `main/browser/agent-actions.ts`, `main/browser/agent-ops.ts`, `main/index.ts`, `packages/core/src/work/parley-browser-skill.ts`; тесты `main/browser/agent-actions.test.ts`, `main/browser/agent-ops.test.ts`, `main/browser/settle-load-auth.test.ts`, `packages/core/src/work/parley-browser-skill.test.ts`

**Interfaces — Consumes:** `CLIENT_CERT_HINT`, `humanWait`, `ClientCert['isPending' | 'onPending']` (задача 1).

- [ ] **Шаг 1. Тесты:**
  - `settle-load-auth.test.ts`: `settleLoad(contents, ms, signal, humanWait(undefined, cert))` при `cert.isPending` → `false` сразу; `onPending` во время загрузки → `false` раньше срока;
  - `agent-actions.test.ts`: действие при висящем запросе сертификата — в `notes` есть `CLIENT_CERT_HINT`; при висящих обоих — обе заметки, basic-auth первой;
  - `agent-ops.test.ts`: `open` и `navigate` при висящем запросе — `CLIENT_CERT_HINT` в `notes`, `loaded: false` у `open`;
  - навык: в разделе Troubleshooting есть строка с текстом `client certificate`.
- [ ] **Шаг 2. `agent-actions.ts`:** в зависимостях `createAgentActions` — `clientCert?: Pick<ClientCert, 'isPending' | 'onPending'>`. `withNavigation(contents, act, guard.signal, humanWait(deps.basicAuth, deps.clientCert))`; после заметки basic-auth: `if (deps.clientCert?.isPending(contents.id) === true) notes.push(CLIENT_CERT_HINT)`. Ветка `The page is still loading.` — только когда не ждёт ни одно из двух.
- [ ] **Шаг 3. `agent-ops.ts`:** та же зависимость; `humanWait` в `settleLoad` у `open` и в `withNavigation` у `navigate`; заметка `CLIENT_CERT_HINT` в `open` и `navigate`; проброс `clientCert` в `createAgentActions`.
- [ ] **Шаг 4. `index.ts`:** передать `clientCert` туда же, куда `basicAuth` уходит в операции агента.
- [ ] **Шаг 5. Навык**, раздел Troubleshooting, одна строка: `` - A note says the site asks for a client certificate: only the human can choose it, in the browser panel. Ask them, then retry. `` Навык остаётся ≤ 220 строк.
- [ ] **Шаг 6. Проверка** (desktop и core).
- [ ] **Шаг 7. Коммит:** `feat(desktop): tell the agent when a page waits for a client certificate`

---

### Task 5: Очистка, спека окна, CHANGELOG

**Files:**
- Modify: `main/ipc.ts` (`browser:clear-data`) и его тест, `docs/specs/2026-09-26-desktop-orca-ui-design.md` (раздел 12.2), `CHANGELOG.md`
- Add to git: `docs/specs/2026-11-18-browser-client-certificate-design.md`, `docs/plans/2026-11-18-browser-client-certificate-plan.md`

- [ ] **Шаг 1. Тест:** `browser:clear-data` зовёт `clientCert.clear()` после `clearStorageData` и `clearCache`.
- [ ] **Шаг 2. `ipc.ts`:** `await browser.clientCert.clear()` в обработчике.
- [ ] **Шаг 3. Спека окна 12.2:** пункт «сертификат клиента не отдаётся» заменить на «сертификат клиента отдаётся только по выбору человека в слое над вкладкой; не гостям раздела — отказ (спека 2026-11-18-browser-client-certificate-design.md)».
- [ ] **Шаг 4. `CHANGELOG.md`,** раздел Unreleased → Added: `- Built-in browser: sites that ask for a client certificate (SSO over mTLS) now show a chooser over the tab; the choice can be remembered per site and is cleared with "Clear browsing data".`
- [ ] **Шаг 5. Проверка** всех изменённых пакетов ветки и `pnpm exec eslint` по всем изменённым файлам ветки.
- [ ] **Шаг 6. Коммит:** `feat(desktop): clear remembered client certificates with browsing data`

---

### Task 6: Живая приёмка (человек)

- [ ] Вход на настоящем SSO в панели человека: слой показан, после выбора вход завершён.
- [ ] Галочка «Remember»: после перезапуска Parley сайт проходит без вопроса и у человека, и на странице агента (`browser_open`); без галочки — до выхода из Parley, после перезапуска вопрос снова.
- [ ] Окно macOS «доступ к ключу» после выбора: что в нём названо в собранном приложении; после «Always Allow» страница агента проходит без окна.
- [ ] «Clear browsing data», затем перезапуск Parley → вопрос задаётся снова.
- [ ] «Not now» при открытой вкладке, затем новая попытка входа на том же сайте → слой показан снова.
- [ ] Сайт с mTLS, для которого в связках нет подходящего сертификата: Parley ничего не показывает (Chromium не спрашивает) — вход просто не проходит. Так проявится и случай «Parley не видит сертификат токен».
- [ ] Вид слоя в окне 800×500 с длинным именем субъекта, обе темы.
- [ ] Ответ на остаток вопроса 1 раздела 5 спеки (виден ли сертификат «токен») дописан в спеку.

## Not verified

- Всё, что перечислено в разделе 5 спеки, до задачи 0.
- Интерфейсы сняты чтением `origin/master` 196850cf; сборка и тесты не запускались.
