# Матрица паритета: что человек делает в окне и что с этим у помощника

- **Дата:** 2026-11-15. **Приложение к:** `docs/specs/2026-11-15-assistant-autonomous-mode-design.md` (§7).
- **База:** origin/master@68dd8060.
- **Статус:** черновик. Перечень собран чтением `packages/protocol/src` и `packages/host/src/methods`; механическая
  сверка с реестром хоста — задача M0 плана.

## Правило подсчёта

В матрицу входят методы хоста, которые меняют состояние и которые человек вызывает действием в окне. Не входят:
чтения, списки, подписки и события; транспорт самого помощника, голоса и телефона (перечислен в конце). Реестр хоста —
`packages/host/src/methods/index.ts:281-457` и модули методов, которые он подключает целиком (`backlog`, `memory`,
`consents`, планы комнат, свои провайдеры, плагины, навыки, Telegram).

Всего строк — 110.

## Классы

| Класс | Что значит | Строк |
|-------|------------|-------|
| есть | Помощник уже умеет; пробел, если он есть, назван и закрывается на этапе 2 | 12 |
| этап 2 | Новый шаг или инструмент чтения; задача P1–P9 плана. В режиме исполняется сразу | 75 |
| клик | Этап 2, но всегда карточкой с кликом (решение человека 6) | 6 |
| нет | Помощнику недоступно (решение человека 7) | 14 |
| позже | Нужен другой механизм; причина названа | 1 |
| н/п | У помощника нет такой роли | 2 |

Классы «клик» и «нет» человек принял 2026-11-15 (спека §2, решения 6 и 7).

Что от чего зависит:

| Строки | От чего зависят | Что ещё может измениться |
|--------|-----------------|----------------------------|
| «клик», 6 строк, и удаление плагина с потерей данных | Решено: с кликом | — |
| «нет», 14 строк, и запрещённые ключи `settings.set` | Решено: недоступно | — |
| «позже», 1 строка (`pty.input`) | Ни от чего: нужен механизм чтения экрана | Отложено независимо от ответов |
| «этап 2», 75 строк | Только от приёмки этапа 1 и таблиц шагов | — |

## Работы

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `works.create` | есть | Шаг `create_work`; новая папка проекта отвергается — снимается в P4 |
| `works.rename` | этап 2 | P4 |
| `works.setStatus` | этап 2 | P4; `archived` прячет работу из обзора |
| `works.setCloseFinished` | этап 2 | P4; даёт агентам право закрывать сессии — `danger` |
| `works.delete` | клик | P8; удаляет файлы работы и историю комнат |

## Сессии

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `sessions.create` | есть | Шаг `create_session`; нет `effort` и `worktree` — P2 |
| `sessions.resume` | есть | Шаг `wake` |
| `sessions.stop` | есть | Шаг `sleep` |
| `sessions.close` | есть | Шаг `close` |
| `sessions.rename` | этап 2 | P2; можно и закрытую сессию |
| `sessions.setModel` | этап 2 | P2; живая сессия перезапускается |
| `sessions.setEffort` | этап 2 | P2 |
| `sessions.setMode` | этап 2 | P2; режим разрешений — `danger` |
| `sessions.setKeepAwake` | этап 2 | P2 |
| `sessions.compact` | этап 2 | P2 |
| `sessions.cancelCompact` | этап 2 | P2 |
| `sessions.switchAgent` | этап 2 | P2; `requestId`, `carry`, `roleChange` |
| `sessions.resumeInterrupted` | этап 2 | P2; подъём всех прерванных рестартом |
| `sessions.delete` | клик | P8; с `force` теряется несохранённый код |

## Лента и чат

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `feed.decide` | есть | `propose_decision`; нет текста отказа — P7 |
| `feed.interrupt` | есть | Шаг `interrupt` |
| `pty.send` | есть | `propose_message`, шаг `message` |
| `activity.seen` | этап 2 | P7; отметка «просмотрено» |
| `mail.markRead` | этап 2 | P7 |
| `pty.input` | позже | Сырые нажатия в терминал: ответ на запрос CLI без карточки требует чтения экрана |
| `pty.resize` | н/п | Размер терминала окна |

## Комнаты

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `rooms.create` | есть | `propose_room`, шаг `create_room`; нет `mode`, `recipe`, `quiet` — P4 |
| `rooms.addMember` | есть | Шаг `add_to_room` |
| `rooms.send` | есть | `propose_message`, шаг `message`; нет `replyTo` — P7 |
| `rooms.resolveProposal` | есть | `propose_room_decision` |
| `rooms.rename` | этап 2 | P4 |
| `rooms.setLead` | этап 2 | P4 |
| `rooms.setOwner` | этап 2 | P4; передаёт комнату сессии — `danger` |
| `rooms.archive` | этап 2 | P4; может остановить сессии |
| `rooms.reopen` | этап 2 | P4 |
| `rooms.history.share` | этап 2 | P4; публикует историю в git — `danger` |
| `rooms.history.unshare` | этап 2 | P4 |
| `rooms.delete` | клик | P8 |

## Планы комнат

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `rooms.setMode` | этап 2 | P5; `autonomous` запускает движок — `danger` |
| `plans.verify` | этап 2 | P5 |
| `plans.cancel` | этап 2 | P5; `danger` |
| `plans.resumeAutonomous` | этап 2 | P5 |
| `plans.submit` | этап 2 | P5 |
| `plans.update` | этап 2 | P5 |
| `plans.retryEffects` | этап 2 | P5 |

## Доска и память

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `backlog.add` | этап 2 | P6 |
| `backlog.update` | этап 2 | P6 |
| `backlog.remove` | этап 2 | P6; файл в git, восстановимо — `danger` |
| `backlog.take` | этап 2 | P6 |
| `backlog.prepareTake` | этап 2 | P6 |
| `backlog.move` | этап 2 | P6 |
| `backlog.transfer` | этап 2 | P6 |
| `backlog.inbox` | этап 2 | P6 |
| `backlog.suggestions.accept` | этап 2 | P6 |
| `backlog.suggestions.dismiss` | этап 2 | P6 |
| `backlog.preferences.set` | этап 2 | P6 |
| `backlog.file.set` | этап 2 | P6 |
| `memory.add` | этап 2 | P6; читает каждый агент |
| `memory.update` | этап 2 | P6 |
| `memory.accept` | этап 2 | P6 |
| `memory.dismiss` | этап 2 | P6 |
| `memory.undo` | этап 2 | P6 |

## Согласия и доверие

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `consents.decide` | этап 2 | P1; доверие папке, MCP проекта, смена агента |
| `trust.grant` | этап 2 | P1 |
| `trust.revoke` | этап 2 | P1 |

## Код

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `worktrees.commit` | этап 2 | P3 |
| `changes.commitProject` | этап 2 | P3; коммит всей папки проекта — `danger` |
| `worktrees.merge` | этап 2 | P3; `danger` |
| `worktrees.discard` | клик | P8 |
| `worktrees.removeCopy` | клик | P8 |
| `worktrees.hold` | н/п | Удержание копий открытым окном |

## Настройки хоста

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `settings.set` | этап 2 | P7 — обычные ключи. Класс «нет»: `assistantAutonomy`, `remoteCreate`, ключи Telegram |
| `wake.pause` | этап 2 | P7 |
| `wake.resume` | этап 2 | P7 |

## Провайдеры и аккаунты

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `providers.setKey` | нет | Секрет |
| `providers.clearKey` | нет | Секрет |
| `providers.saveCustom` | нет | Содержит ключ или аккаунт |
| `providers.signIn` | нет | Вход в аккаунт |
| `providers.signInInput` | нет | Вход в аккаунт |
| `providers.signInResize` | нет | Вход в аккаунт |
| `providers.cancelSignIn` | нет | Вход в аккаунт |
| `providers.signOut` | нет | Вход в аккаунт |
| `providers.deleteCustom` | клик | P8; может удалить папку |
| `providers.install` | этап 2 | P9; запускает установщик — `danger` |
| `providers.update` | этап 2 | P9; `danger` |
| `providers.skipUpdate` | этап 2 | P9 |
| `providers.checkUpdates` | этап 2 | P9 |
| `providers.check` | этап 2 | P9 |
| `providers.refreshLimits` | этап 2 | P9 |

## Инструменты агентов

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `capabilities.mcp.add` | этап 2 | P9; `danger` |
| `capabilities.mcp.remove` | этап 2 | P9 |
| `capabilities.mcp.check` | этап 2 | P9 |
| `capabilities.plugins.install` | этап 2 | P9; `danger` |
| `capabilities.plugins.uninstall` | этап 2 | P9; с потерей данных — класс «клик», P8 |
| `capabilities.plugins.enable` | этап 2 | P9 |
| `capabilities.plugins.disable` | этап 2 | P9 |
| `capabilities.plugins.addMarketplace` | этап 2 | P9 |
| `capabilities.skills.share` | этап 2 | P9 |
| `capabilities.skills.unshare` | этап 2 | P9 |
| `capabilities.refresh` | этап 2 | P9 |

## Telegram, рои, хост

| Метод | Класс | Задача и пояснение |
|-------|-------|--------------------|
| `telegram.setToken` | нет | Секрет |
| `telegram.clearToken` | нет | Секрет |
| `telegram.link` | нет | Удалённый доступ |
| `telegram.unlink` | нет | Удалённый доступ |
| `telegram.takeOver` | нет | Удалённый доступ |
| `swarms.create` | этап 2 | P7 |
| `swarms.cancel` | этап 2 | P7; `danger` |
| `swarms.seen` | этап 2 | P7; отметка |
| `host.profile.start` | этап 2 | P7 |
| `host.shutdown` | нет | Останавливает хост и самого помощника |

## Транспорт — в матрицу не входит

`assistant.ask`, `assistant.cancel`, `assistant.decide`, `assistant.reissue`, `assistant.reset`,
`assistant.configure`, `requests.submit`, `requests.ack`, `jobs.submit`, `jobs.cancel`, `jobs.ackInline`,
`cards.decide`, `voice.session.prepare`, `voice.session.close`, `voice.telemetry.record`, `voiceProvider.setKey`,
`voiceProvider.clearKey`, `voiceProvider.check`, `browser.agentResult`, `works.sync`, `push.register`,
`feed.progress`.

Ключи голосового провайдера (`voiceProvider.setKey`, `clearKey`) — секреты; помощнику они недоступны по тому же
решению 7.

## Не инвентаризировано

Действия окна вне RPC хоста (Electron IPC: запись файлов, коммит выбранных файлов, панель браузера, сохранение
рецептов, загрузка голосовых моделей). Решено 2026-11-15 в эту работу не включать; в бэклоге — предложение sg-52
(спека §12, п. 3).
