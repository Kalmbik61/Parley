# Локализация Parley на английский и русский

Исходный реестр и глоссарий для пункта 1 плана `pl-12` (редакция 0). Срез исходников зафиксирован на `f7978af8156cfb426016f999fb6d36798adf7d73`.

Английский текст и сигнатуры на этом срезе служат исходником. В таблицах «к переводу» означает, что русской версии в срезе ещё нет. «Смешанный» означает, что в одном источнике есть и подписи для человека, и исходные данные либо инструкции. Явно помеченные исходные значения используются в обеих локалях.

## Каталог desktop

В [shared/strings.ts](../../packages/desktop/src/shared/strings.ts#L48) **56 групп, 2 042 конечных ключа и 351 функция с параметрами**. В подсчёт входят девять ключей `S.states` из [STATE_WORDS](../../packages/core/src/work/session-state.ts). Вложенные словари раскрыты, массив считается одним ключом, а ветви функции входят в один ключ. Это размер исходного каталога, включая шаблоны для агентов и технические значения.

В таблице «ключи / функции» указано общее число конечных ключей и число ключей с формальными параметрами. У статических ключей параметров нет. Точные имена, типы и значения по умолчанию для каждого ключа даёт команда ниже. Аудитория по умолчанию — человек в desktop. Прочие получатели указаны в строке группы.

| Группа `S` | Ключи / функции | Экран или применение | Основные параметры | RU и аудитория |
| --- | ---: | --- | --- | --- |
| `plans` | 84 / 7 | Карточка плана, режим комнаты, приёмка, попытки | Редакция, режим, числа задач и доставок, статус | К переводу |
| `capabilities` | 58 / 2 | Панель навыков и плагинов | Имя провайдера | К переводу, внешние имена как есть |
| `projectPanel` | 68 / 1 | Панель проекта, разрешения и ссылки на ресурсы | Провайдер | К переводу |
| `mcpActions` | 47 / 1 | Подключения и действия MCP в панели проекта | Число запущенных сессий | К переводу, идентификаторы MCP как есть |
| `backlog` | 43 / 5 | Бэклог, предложения, подтверждения | Заголовок, количество, причина, размеры | К переводу, записи как есть |
| `decisions` | 25 / 5 | Журнал решений, просмотр, экспорт | Реквизиты решения, причина | К переводу, решения как есть |
| `memory` | 41 / 3 | Память проекта, предложения, правка | Количество, размеры, причина | К переводу, записи как есть |
| `projectSearch` | 35 / 3 | Поиск по материалам проекта | Количество, запрос, причина | К переводу, совпадения как есть |
| `usage` | 25 / 4 | Токены, стоимость и активность | Числа, окно времени, цена | К переводу |
| `context` | 28 / 10 | Контекст сессии, перенос данных и ссылки | Имя, время, количество, размер | К переводу, выбранный материал как есть |
| `roles` | 5 / 2 | Выбор и отображение роли | Имя или провайдер | К переводу, сторонние роли как есть |
| `recipes` | 44 / 7 | Выбор, настройка и сохранение сценария | Имя, путь, причина, количество | Смешанный. `playbookTemplate` поступает ведущему как инструкция |
| `common` | 7 / 0 | Общие кнопки и подтверждения | — | К переводу |
| `outbox` | 5 / 0 | Очередь исходящих писем | — | К переводу |
| `quit` | 3 / 2 | Диалог выхода, предупреждение о сессиях | Число сессий и попыток | К переводу |
| `states` | 9 / 0 | Состояния сессии в строках, карточках и подсказках | — | К переводу, общие слова берутся из core |
| `need` | 20 / 16 | Состояние «ждёт вас», требования внимания | Вид события, имя, провайдер, время | К переводу, вопрос и команда агента как есть |
| `landing` | 2 / 0 | Стартовый экран | — | К переводу, бренд как есть |
| `titlebar` | 5 / 0 | Заголовок и навигация окна | — | К переводу, включая доступные имена |
| `sidebar` | 68 / 21 | Дерево проектов, работ, комнат и сессий | Имена, число агентов и писем, ветка, пути | К переводу |
| `cardMenu` | 16 / 3 | Действия в меню карточки работы | Название, количество | К переводу |
| `time` | 5 / 3 | Краткое и относительное время | Число, готовое значение интервала | К переводу |
| `statusBar` | 17 / 5 | Строка состояния, провайдеры и лимиты | Провайдер, версия, время, лимит | К переводу |
| `providerCard` | 54 / 4 | Карточка провайдера, ключ, подписка и проверка | Версия, имя, данные проверки | К переводу, продуктовые имена как есть |
| `customProviders` | 65 / 3 | Пользовательские провайдеры и тест подключения | Имя, время, результат обновления | К переводу, URL и имена как есть |
| `accounts` | 29 / 3 | Аккаунты провайдеров, вход и отключение | Провайдер, версия, ярлык | К переводу |
| `dialogs` | 88 / 16 | Создание работы, комнаты и сессии, доверие к папке | Имена, путь, количество, текст ошибки | К переводу. Команды, имена, пути и введённый текст как есть |
| `mail` | 8 / 2 | Почта, тип письма и участники | Имя, количество | К переводу, тело письма как есть |
| `rooms` | 68 / 17 | Лента комнаты, письма, действия и итоги | Имена, ID, количества, причина ожидания | К переводу, авторское содержание как есть |
| `settings` | 99 / 9 | Настройки приложения, проектов, Telegram и острова | Пути, даты, пределы, сочетания клавиш | К переводу. Язык помощника и диктовки выбирается отдельно |
| `update` | 3 / 1 | Тост обновления | Версия | К переводу, бренд как есть |
| `palette` | 17 / 6 | Палитра команд и поиск | Запрос, имя, число совпадений | К переводу, клавиши и данные как есть |
| `agentsPanel` | 25 / 3 | Список агентов и ход их задач | Числа, имя | К переводу |
| `changes` | 63 / 17 | Git-изменения, коммит, слияние и сравнение | Ветка, путь, автор, число файлов и строк | К переводу, Git-данные как есть |
| `terminal` | 12 / 1 | Рамка терминала и состояние сессии | Относительное время | К переводу. Вывод PTY как есть |
| `chat` | 143 / 23 | Чат, свёрнутые ходы, вложения и подробности выполнения | Имя инструмента, пути, числа, время, текст результата | К переводу. Транскрипт и данные инструмента как есть |
| `send` | 11 / 10 | Отправка в сессию, комнату или буфер | Получатель, файл, вид вложения, количество | К переводу, полезная нагрузка как есть |
| `notes` | 19 / 8 | Комментарии в diff и подготовка отправки | Путь, строки, число заметок, получатель | Смешанный. Кнопки для человека. `header`, `file`, `line`, `lines`, `sideOriginal`, `note` входят в Markdown агенту |
| `links` | 5 / 0 | Действия со ссылкой | — | К переводу, URL как есть |
| `tabs` | 15 / 2 | Вкладки и панели просмотра | Название, количество | К переводу |
| `browser` | 152 / 26 | Адресная строка, вкладки, поиск, DevTools, аннотации и эмуляция | URL, профиль, размеры, число совпадений, статус и текст браузера | К переводу, страница и диагностические данные как есть |
| `contextFile` | 56 / 35 | Markdown из браузера и строка отправки в терминал | URL, путь, CSS/DOM, снимок, HTTP, место и текст аннотации | Агентский исходник. Внешний UI отправки в `S.browser` |
| `banners` | 4 / 0 | Системные баннеры окна | — | К переводу |
| `works` | 2 / 0 | Ошибка чтения списка работ | — | К переводу |
| `connection` | 14 / 5 | Состояние соединения с хостом и восстановление | Версия, задержка, попытка, причина | К переводу, коды и техническая диагностика как есть |
| `menu` | 5 / 0 | Верхнее меню macOS | — | К переводу, роли Electron как есть |
| `actions` | 52 / 2 | Действия меню, палитры и горячих клавиш | Номер вкладки или окна | К переводу, стабильные ID команд как есть |
| `notifications` | 20 / 10 | Заголовки и подписи системных уведомлений | Имя, место, отправитель, число | К переводу, цитаты как есть |
| `island` | 70 / 11 | Остров, вырез, план, разрешения и прогресс | Имена, количества, источник запроса | К переводу. У `consentSource` отдельно учесть человекочитаемую подпись и код источника |
| `participants` | 7 / 2 | Участники и подписи адресатов | Имя, количество, устаревшая ссылка | К переводу, имена и ID как есть |
| `errors` | 78 / 11 | Ошибки UI и лимиты запуска | Область, лимит и расход, действие, причина | К переводу, код ошибки как есть |
| `files` | 56 / 8 | Дерево, просмотр файлов и ошибки редактора | Имя, путь, размер, количество и причина | К переводу, имена и содержимое как есть |
| `shell` | 3 / 0 | Оболочка и резервные состояния desktop | — | К переводу |
| `diagnostics` | 10 / 1 | Сбор диагностики и инструкция из архива | Причина сбоя | Смешанный. Переводятся меню и инструкция для человека, поля архива и имена файлов как есть |
| `assistant` | 94 / 12 | Помощник, подтверждения, напоминания и настройки | Имя, адресат, действие, период, число | К переводу, реплики помощника/пользователя и выбранный язык как есть |
| `voice` | 35 / 3 | Диктовка и индикаторы распознавания | Ошибка, состояние и размер модели | К переводу, транскрипция и язык распознавания как есть |

### Воспроизведение по ключам

Из корня репозитория с установленной зависимостью `typescript` запустить команду ниже. Она читает зафиксированную Git-ревизию и пишет JSONL на stdout. Поле `baseline` содержит исходное выражение, включая ветви и интерполяцию. По второй части `key` строка связывается с экраном и аудиторией из таблицы. Для конкретной ветви шаблона учитываются аргументы функции и данные, перечисленные в разделе о границах.

```sh
node - <<'NODE'
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const { execFileSync } = require('node:child_process');
const revision = 'f7978af8156cfb426016f999fb6d36798adf7d73';

function source(path) {
  const text = execFileSync('git', ['show', revision + ':' + path], { encoding: 'utf8' });
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function unwrap(value) {
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) {
    value = value.expression;
  }
  return value;
}

function object(file, name) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const entry = statement.declarationList.declarations.find((d) => d.name.getText(file) === name);
    if (!entry) continue;
    const value = unwrap(entry.initializer);
    if (ts.isObjectLiteralExpression(value)) return value;
  }
  throw new Error('Object missing: ' + name);
}

function* entries(initializer, key) {
  const value = unwrap(initializer);
  if (!ts.isObjectLiteralExpression(value)) {
    if (value.getText() === 'STATE_WORDS') {
      yield* entries(object(states, 'STATE_WORDS'), key);
      return;
    }
    const file = value.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(value.getStart()).line + 1;
    const params = ts.isArrowFunction(value) ? value.parameters.map((p) => p.getText(file)) : [];
    yield { key, source: file.fileName + ':' + line, params, value: value.getText(file) };
    return;
  }
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('Unsupported entry: ' + property.getText());
    yield* entries(property.initializer, key + '.' + property.name.text);
  }
}

const agentKeys = new Set([
  'S.recipes.playbookTemplate',
  ...['header', 'file', 'line', 'lines', 'sideOriginal', 'note'].map((key) => 'S.notes.' + key),
]);

const shared = source('packages/desktop/src/shared/strings.ts');
const states = source('packages/core/src/work/session-state.ts');
const groups = object(shared, 'S');
const rows = [...entries(groups, 'S')];
if (process.argv.includes('--summary')) {
  console.log(groups.properties.length, rows.length, rows.filter((r) => r.params.length).length);
  for (const group of groups.properties) {
    const groupRows = rows.filter((r) => r.key.startsWith('S.' + group.name.text + '.'));
    console.log(group.name.text, groupRows.length, groupRows.filter((r) => r.params.length).length);
  }
  const telegram = source('packages/host/src/telegram/texts.ts');
  console.log('Telegram T/B/RECEIPTS:', ...['T', 'B', 'RECEIPTS'].map((name) => object(telegram, name).properties.length));
} else {
  for (const { key, source, params, value } of rows) {
    const ru = agentKeys.has(key) || key.startsWith('S.contextFile.') ? 'agent-source' : 'pending';
    console.log(JSON.stringify({ key, source, params, baseline: value, en: 'source', ru }));
  }
}
NODE
```

Для короткого отчёта заменить первую строку на `node - --summary <<'NODE'`. Итог для `S` — `56 2042 351`. Отдельная строка для Telegram — `52 15 13`. Статус в JSONL отмечает исходник `en: source`, русские ключи к переводу `ru: pending` и агентский исходник `ru: agent-source`. Исключения внутри смешанных групп приведены в таблице и ниже.

## Тексты вне объекта S

Места приведены относительно корня репозитория. Таблица фиксирует группы источников для сверки при реализации. Статус «к переводу» относится к собственному тексту Parley в указанном месте. Исходная строка или выражение находятся в названном файле.

| Источник или место | Экран и аудитория | Параметры и исходные данные | Статус EN/RU |
| --- | --- | --- | --- |
| [desktop/src/shared/strings.ts, функции после S](../../packages/desktop/src/shared/strings.ts#L311) и [session state](../../packages/core/src/work/session-state.ts) | Строка состояния, ошибки запуска, уведомления, имена провайдеров. Последние также приходят в Telegram через core | `providerName(id, label)`, `errorText(code, action)`, `startErrorText(failure, action)`, `noticeText(notice, label)`. Коды, поля лимита, путь миграции, ярлык и версия | EN исходник. К переводу — формулировки ошибок и уведомлений, `ERROR_REASON`, `NOTICE_DETAIL`. Имена провайдеров как есть |
| [desktop/src/shared/context-markdown.ts](../../packages/desktop/src/shared/context-markdown.ts), `CONTEXT_NAMES` и `CONTEXT_NOUNS` над `S`, [renderer/review/notes/format.ts](../../packages/desktop/src/renderer/review/notes/format.ts) | Отправка контекста браузера и заметок из diff. Тост видит человек, Markdown получает агент | Категория, число элементов, URL, координаты, пути, заметки и исходное содержимое страницы | Смешанный. Тост и оболочка UI к переводу. Служебный контекст и формат письма агенту сохраняют исходник |
| [desktop/src/renderer/index.html](../../packages/desktop/src/renderer/index.html), [renderer/main.tsx](../../packages/desktop/src/renderer/main.tsx), [renderer/shell](../../packages/desktop/src/renderer/shell), [renderer/components](../../packages/desktop/src/renderer/components), [renderer/chat](../../packages/desktop/src/renderer/chat), [renderer/sidebar](../../packages/desktop/src/renderer/sidebar) и [preload/index.ts](../../packages/desktop/src/preload/index.ts) | Главное окно, документ `lang`, исходные подписи в JSX, доступные имена и ошибки на границе IPC. Примеры вне `S` — `aria-label="Suggested"` в BacklogPanel и MemoryPanel, `Clear owner` в RoomRowMenu | Имена, запросы и отрывки, состояние экранов. Названия файлов вроде `PARLEY.md` используются в подписи как данные | EN исходник. Собственные подписи и метаданные страницы к переводу. Каналы preload и данные сохраняют исходник |
| [desktop/src/renderer/island.html](../../packages/desktop/src/renderer/island.html), [renderer/island/main.tsx](../../packages/desktop/src/renderer/island/main.tsx), [renderer/island](../../packages/desktop/src/renderer/island), [main/island/window.ts](../../packages/desktop/src/main/island/window.ts) и [preload/island.ts](../../packages/desktop/src/preload/island.ts) | Отдельное окно острова, капсула у выреза, помощник и голос, запросы разрешения, plan/consent, ошибки bootstrap | Количество агентов и задач, источник согласия, вопрос и варианты агента, выбранный язык помощника | EN исходник. Собственная оболочка, `lang`, заголовок и доступные имена к переводу. Карточки агента и язык его речи сохраняют исходник |
| [desktop/src/main/menu.ts](../../packages/desktop/src/main/menu.ts), [main/index.ts](../../packages/desktop/src/main/index.ts), [main/notifications.ts](../../packages/desktop/src/main/notifications.ts), [renderer/attention/notify.ts](../../packages/desktop/src/renderer/attention/notify.ts), [electron-builder.yml](../../packages/desktop/electron-builder.yml#L77) | Меню приложения и системные роли, уведомления, диалоги открытия, файл разрешения микрофона в пакете macOS | Бренд, действие и горячая клавиша, имя и место сессии, пути, причина отказа. `limit-return-blocked` может использовать сырой `notice.text` | Ручные `About Parley`, `Quit Parley` и `NSMicrophoneUsageDescription` в EN. Собственные подписи и ресурс к переводу. Системные наименования Electron/macOS проверяются отдельно |
| [desktop/src/main/browser/guest-pick.js](../../packages/desktop/src/main/browser/guest-pick.js), [main/browser/guest-annotate.js](../../packages/desktop/src/main/browser/guest-annotate.js), [main/browser/guard.ts](../../packages/desktop/src/main/browser/guard.ts), [renderer/browser](../../packages/desktop/src/renderer/browser), [renderer/files/preview/PdfPreview.tsx](../../packages/desktop/src/renderer/files/preview/PdfPreview.tsx) | Внедрённые оверлеи и браузерные ошибки, просмотрщик файлов и встроенная локаль PDF | Селектор, размеры, имя загрузки, URL, содержимое страницы или файла | Смешанный. Текст оболочки и язык встроенного просмотра к переводу. Веб-страница, DOM и содержимое файла как есть |
| [desktop/src/renderer/lib/relative-time.ts](../../packages/desktop/src/renderer/lib/relative-time.ts), [attention/derive.ts](../../packages/desktop/src/renderer/attention/derive.ts), [shell/StatusBar.tsx](../../packages/desktop/src/renderer/shell/StatusBar.tsx), [review/ChangesPanel.tsx](../../packages/desktop/src/renderer/review/ChangesPanel.tsx), [review/notes/NoteZone.tsx](../../packages/desktop/src/renderer/review/notes/NoteZone.tsx), [components/settings/TelegramSettings.tsx](../../packages/desktop/src/renderer/components/settings/TelegramSettings.tsx), [components/providers/check-line.tsx](../../packages/desktop/src/renderer/components/providers/check-line.tsx), [palette](../../packages/desktop/src/renderer/palette), [files/Tree.tsx](../../packages/desktop/src/renderer/files/Tree.tsx) и [sidebar/sort.ts](../../packages/desktop/src/renderer/sidebar/sort.ts) | Часы и дата в панелях, время в ленте и diff, доступные имена, поиск команд, сортировка подписей | Дата ISO, часовой пояс, число, запрос, название. Сохранённая дата, текст команды и ID используются как данные | Частично жёсткие `en-US` / `en-GB` / `en`. Форматировать отображение по локали, проверять поиск по русским подписям и стабильность технической сортировки |
| [host/src/activity](../../packages/host/src/activity), [sessions](../../packages/host/src/sessions), [wake](../../packages/host/src/wake), [works](../../packages/host/src/works), [rooms](../../packages/host/src/rooms), [methods](../../packages/host/src/methods), [desktop/src/renderer/store/notices.ts](../../packages/desktop/src/renderer/store/notices.ts) | Сообщения хоста, ошибки RPC, системные письма, причины остановки и статус без открытого desktop | `NoticeKind`, `HostError.code` и `data`, ссылка на сессию, лимит, причина, внешний stderr. Журнал может получать исходный `notice.text` | Смешанный. Для собственного текста человеку нужен локализованный вывод. Коды, структурированные поля, внешний stderr, старые сохранённые письма и инструкции в PTY сохраняют исходник |
| [host/src/telegram/texts.ts](../../packages/host/src/telegram/texts.ts), [cards.ts](../../packages/host/src/telegram/cards.ts), [format.ts](../../packages/host/src/telegram/format.ts), [notify.ts](../../packages/host/src/telegram/notify.ts), [service.ts](../../packages/host/src/telegram/service.ts), [callbacks.ts](../../packages/host/src/telegram/callbacks.ts), [assistant-bridge.ts](../../packages/host/src/telegram/assistant-bridge.ts) | Telegram: помощь, /status, карточки плана, вопросы, разрешения, ответ, голос и подтверждения | В `T` 52 записи, в `B` 15 кнопок, в `RECEIPTS` 13 подтверждений. Параметры включают время, инициатора, комнату, инструмент, номер вопроса, причину и текст пользователя | EN исходник. Человекочитаемые подписи и описание команд к переводу. Имена команд, `callback_data`, ссылки, варианты агента и тела писем сохраняют исходник |
| [core/src/cli.ts](../../packages/core/src/cli.ts), [core/src/mcp/server.ts](../../packages/core/src/mcp/server.ts) и [host/src/main.ts](../../packages/host/src/main.ts) | Справка и сообщения для человека в CLI `parley-core`, старт и диагностика отдельных процессов `parley-mcp` и `parley-host` | Команда, флаг, путь, ID, код выхода, сообщение внешней ошибки. `parley-core` печатает данные JSON в stdout, MCP использует stdout для JSON-RPC | Смешанный. Справка и собственные сообщения CLI человеку к переводу. Машинный вывод, аргументы, флаги, коды и внешняя диагностика сохраняют исходник |
| [core/src/roles/builtin.ts](../../packages/core/src/roles/builtin.ts), [recipes/builtin.ts](../../packages/core/src/recipes/builtin.ts), [roles/catalog.ts](../../packages/core/src/roles/catalog.ts), [recipes/catalog.ts](../../packages/core/src/recipes/catalog.ts), [skills/catalog.ts](../../packages/core/src/skills/catalog.ts), [host/src/providers/codex-catalog.ts](../../packages/host/src/providers/codex-catalog.ts) | Выбор из 9 встроенных ролей и 3 встроенных сценариев, внешние каталоги навыков и агентов | `builtin:…`, описание, роль ведущего, провайдер, модель, путь. Роли сторонних CLI и проектные сценарии содержат исходный авторский текст | EN исходник. Отдельные имена и описания встроенных позиций для человека к переводу. Сторонние каталоги, `instruction`, `playbook` и ID сохраняют исходник |
| [core/src/work/guide.ts](../../packages/core/src/work/guide.ts), [parley-md.ts](../../packages/core/src/work/parley-md.ts), [brief.ts](../../packages/core/src/work/brief.ts), [session-layer.ts](../../packages/core/src/work/session-layer.ts), [plan-effects.ts](../../packages/core/src/work/plan-effects.ts), [delivery.ts](../../packages/core/src/work/delivery.ts), [guidance.ts](../../packages/core/src/work/guidance.ts), [core/src/mcp/tools.ts](../../packages/core/src/mcp/tools.ts) и [host/src/wake/wake-service.ts](../../packages/host/src/wake/wake-service.ts) | Встроенный гид, шаблон правил команды, бриф и системные письма. Человек читает некоторые материалы как справку, модель получает их для выполнения | Имена тем и инструментов, пример команды, правила проекта, условия плана, ID, пути, авторские тексты | Смешанный. Справка человеку и новые шаблоны для человека к переводу. `read_guide` для модели, бриф, агентский указатель, служебные письма назначения и вложенные правила модели сохраняют исходник |
| [core/src/work/plan-snapshots.ts](../../packages/core/src/work/plan-snapshots.ts), [decision-journal.ts](../../packages/core/src/work/decision-journal.ts), [backlog.ts](../../packages/core/src/work/backlog.ts), [desktop/src/main/recipe-file.ts](../../packages/desktop/src/main/recipe-file.ts), [desktop/src/main/diagnostics](../../packages/desktop/src/main/diagnostics) | Генерируемый Markdown, записи проекта, сохранённый сценарий и архив диагностики | Заголовки, дата, ID, ссылка, имя файла, хеш и авторские записи. Шаблоны могут содержать машинные поля | Смешанный. В новых материалах локализуются собственные заголовки и пояснения. Записанные файлы, YAML/JSON, имена, коды, хеши и авторские записи сохраняют исходник |
| [README.md](../../README.md#install-and-use) и [docs/media](../media) | Публичная справка по установке и запуску, команды, подписи и alt-текст иллюстраций | Бренд, архитектура, имена DMG, URL, версии и команды | EN справка есть. RU инструкция и нужные пояснения к иллюстрациям в пункте 7. Публикации, для которых проект требует английский, сохраняют этот язык |

Исторический тест `english-ui.test.ts` проверял английский `lang` главного окна и искал кириллицу в исходниках desktop. [Актуальный тест каталогов](../../packages/desktop/src/locale-catalogs.test.ts) проверяет кириллицу в английских каталогах, совпадение ключей и параметров EN/RU. Проверка интерфейса охватывает строки в обоих окнах и источники вне `S`.

## Глоссарий EN/RU

Термины основной навигации и девять состояний опираются на [глоссарий desktop](../specs/2026-09-26-desktop-orca-ui-plan.md#сквозные-ограничения). Дополнения ниже задают рабочие формы для поверхностей плана `pl-12`. Кнопки пишутся с прописной буквы, краткие состояния в строке сессии — со строчной.

| EN | RU | Контекст |
| --- | --- | --- |
| Project | Проект | Папка проекта, группирует работы |
| Workspace | Работа | `New workspace` → «Новая работа». Git-папка сессии — рабочее дерево |
| Session / Agent | Сессия / Агент | Сессия — запуск с историей и состоянием. Агент — участник, который работает в сессии |
| Room / Member / Lead | Комната / Участник / Ведущий | «Ведущий комнаты». `Feature Lead` — роль «Руководитель разработки» |
| Mail / Message / Letter | Почта / Письмо / Письмо | Письмо в почте и ленте комнаты. В чате, консоли браузера, Telegram и общих уведомлениях уместно «сообщение» |
| Note / Question / Decision | Заметка / Вопрос / Решение | Типы письма. Комментарий к строке diff — «заметка», обоснование возврата — «причина возврата» |
| Auto-wake / Wake / Resume | Будильник / Разбудить / Возобновить | Будильник автоматически доставляет почту. `Wake and send` → «Разбудить и отправить» |
| Pointer | Указатель на почту | Строка в терминале агента. Указатель мыши в браузере имеет другой контекст |
| Worktree / Branch | Рабочее дерево / Ветка | `Own worktree` → «Отдельное рабочее дерево». При первом подробном пояснении можно указать `git worktree` |
| Tab / Group / Board | Вкладка / Группа / Доска | Доска показывает задачи плана комнаты |
| Changes / Files / Agents | Изменения / Файлы / Агенты | Вкладки правой панели |
| Command palette | Палитра команд | Поиск команд в выбранной локали |
| Settings / Notifications | Настройки / Уведомления | Путь в Telegram и нативный вывод используют те же названия |
| System / English / Русский | Как в системе / English / Русский | Выбор языка интерфейса. Имена конкретных языков показаны на самих языках |
| Provider / Model / Effort | Провайдер / Модель / Усилие | `Effort` можно объяснить как уровень усилия модели. ID модели сохраняется исходным |
| Role / Recipe / Playbook | Роль / Сценарий / Инструкция ведущему | Перевод названия и описания встроенных вариантов при показе; содержимое инструкции исходное |
| Planner / Architect / Critic | Планировщик / Архитектор / Критик | Имена встроенных ролей для человека |
| Executor / Reviewer / Verifier | Исполнитель / Рецензент / Проверяющий | Рецензент ищет дефекты и риски. Проверяющий сверяет результат с критериями приёмки |
| Debugger / Researcher | Специалист по отладке / Исследователь | Имена встроенных ролей для человека |
| Plan & build / Review / Debug | Планирование и реализация / Рецензирование / Отладка | Имена трёх встроенных сценариев для человека |
| Plan / Revision / Item | План / Редакция / Задача | Редакция плана и задача в плане. «Пункт» подходит для ссылки на номер в документации |
| Free / Checklist / Verified / Autonomous | Свободный / Чек-лист / С проверкой / Автономный | Режимы комнаты. `Verified` как состояние задачи — «Проверено» |
| Owner / Scope / After | Ответственный / Объём работ / После | У задачи плана. Владелец проекта, комнаты или аккаунта — «владелец» |
| Acceptance criteria / Evidence / Artifacts | Критерии приёмки / Подтверждение выполнения / Артефакты | `Submit evidence` → «Отправить подтверждение» |
| Attempt / Check | Попытка / Проверка | Автономный план |
| Accept / Verify / Return for rework | Принять / Проверить / Вернуть на доработку | «Принять» для решения или результата, «Проверить» для задачи. Отказ в разрешении — «Отказать» |
| Trust folder / Permission / Approval | Доверять папке / Разрешение / Подтверждение | Различать доверие к папке, право выполнить действие и приёмку плана |
| Backlog / Memory / Decision journal | Бэклог / Память / Журнал решений | Материалы проекта |
| Island / Assistant / Voice dictation | Остров / Помощник / Голосовая диктовка | Остров — отдельная область Parley. Диктовка и речь помощника имеют собственные настройки языка |
| Console / Network request / Annotation | Консоль / Сетевой запрос / Аннотация | Инструменты браузера Parley. Данные консоли, сети и страницы исходные |
| working / needs you / done · unseen | работает / ждёт вас / завершено · не просмотрено | Компактное состояние сессии |
| idle / not started / asleep | простаивает / ожидает запуска / спит | Компактное состояние сессии |
| closed / done / failed | закрыта / готово / сбой | Компактное состояние сессии |

### Границы перевода

- **Подписи и имена.** Переводится обрамление Parley, включая кнопки, доступные имена, подсказки, состояния, текст ошибок по коду и подписи встроенных ролей и сценариев. Сохраняются написания Parley, Codex, Claude Code, Git, GitHub, macOS и Telegram, метки внешних провайдеров, пользовательские имена работ, проектов, комнат, сессий, ролей, сценариев и файлов. Вставка имени в шаблон сохраняет его форму. Например, «Письмо от агента „{name}“» позволяет согласовать фразу вокруг имени.
- **Авторский и внешний текст.** Письма, решения, план и его критерии, артефакты, заметки, реплики, вопросы и варианты агента, подсказки инструментов стороннего CLI, транскрипты, Markdown, Git diff, вывод терминала, страницы и сообщения внешних ошибок сохраняются в исходном виде. Локализуются подписи вокруг них. Пользовательский язык подсказок модели, помощника и распознавания выбирается отдельно. Даты и числа для человека форматируются в выбранной локали. Для количества учитываются формы «1 письмо», «2 письма», «5 писем», «11 писем», «21 письмо», «22 письма», «25 писем», «0 писем» и дробный формат «1,5» с подходящей единицей.
- **Инструкции и смешанные материалы.** Текст, от которого зависит работа модели, сохраняется на исходном языке, включая `S.recipes.playbookTemplate`, агентский `S.contextFile`, правила проекта, `instruction`, `playbook`, агентский гид и письма назначения. Для человека у встроенных вариантов есть отдельное представление. В новом пользовательском экспорте или шаблоне переводятся собственные заголовки и пояснения. Модельные инструкции, пользовательские блоки и записанная история сохраняются в исходной форме.
- **Протокол и хранение.** Значения перечислений, команды и флаги, имена инструментов, RPC/IPC-методов и параметров, `callback_data`, типы `NoticeKind`, коды ошибок, ID, URL, ветки и пути сохраняют значения. Так же обрабатываются JSON, YAML-поля, даты ISO, имена файлов экспорта, ссылки и хеши. Для терминов с техническим значением, например `create_session` в `S.island.consentSource`, локализуется читаемая подпись для человека, а код по-прежнему используется для действия.

## Сверка desktop после переноса

[Тест каталогов](../../packages/desktop/src/locale-catalogs.test.ts) связывает пользовательские группы с парами EN/RU и отдельно проверяет агентскую группу `S.contextFile`. Обе локали используют одни и те же ключи и сигнатуры. Английская навигация и её действия проверяются вместе с русской в [сценариях Electron](../../packages/desktop/e2e/locale-desktop.spec.ts).

| Исходная подпись или данные | Как используются |
| --- | --- |
| Parley, Claude Code, Codex, Claude Desktop, Claude.ai, Git, GitHub, Finder, macOS, Telegram, Z.ai, GLM, Qwen3-TTS и названия моделей Whisper | Имена продуктов, сервисов, движков и моделей. Переводится текст вокруг имени |
| URL, HTTP, Fetch/XHR, CSS, JS, CORS, POSIX, PCRE, JSON, YAML, UTF-8, `PATH`, `PARLEY.md` и имена файлов | Технические обозначения, коды и реальные пути. Числа и единицы в описательных подписях форматируются для человека |
| `S.contextFile`, `S.context.roomDefault`, `S.context.sessionDefault`, `S.recipes.playbookTemplate`, `S.changes.askAgentIntro`, `S.changes.askAgentInstruction`, заголовки `S.notes` для отправки | Письма и инструкции агенту используют общие исходные шаблоны |
| Текст страницы, DOM, CLI-команды, варианты ответа и заголовки от провайдера, имена и тексты автора | Отображаются как данные. Например, на карточке Острова подпись «Запустить» берётся из RU каталога, а строка команды и её подсказка сохраняют оригинал |
| `⌘J`, `⌘N`, значки, короткие коды и имена собственных файлов приложения | Используются в обеих локалях |
| Текст запроса доступа к микрофону | macOS выбирает `InfoPlist.strings` из `en.lproj` или `ru.lproj` по языку приложения в системе. Меню, окно, Остров и уведомления Parley используют выбранную локаль интерфейса |

## Сверка с master для 0.39.1

Перенос сделан на `5c4e48648ccb0653122c6be67ad1b434509a42a1`. Каталоги включают общую доску и доску комнаты, рои, очередь и сон сессий, обновление приложения и CLI, переключение провайдеров, подсказки Kimi Code, Qwen Code и OpenCode, терминальные запросы в чате, сертификаты браузера, а также настройки удалённого доступа на Mac. Строки окна загружаются вместе с обоими мостами `worksSync`. Проверка собранных приложений сверяет оба `InfoPlist.strings` с исходными файлами.
