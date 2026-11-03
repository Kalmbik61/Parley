# Мастер relay: одна кнопка и окно лога — план

Спека: `docs/specs/2026-11-03-relay-wizard-one-click-design.md` (дальше — «спека», разделы по номерам). Лид —
s-238, владелец — s-38. Исполнители — Claude Sonnet (`builtin:executor`), по одной задаче за раз; каждую задачу
проверяет независимый критик на Opus, вердикт — за лидом. Без push, PR и тегов. Коммиты — на английском, по
одному или несколько на задачу, с префиксом области (`fix(desktop): …`, `test(desktop): …`).

## Общие правила для каждой задачи

- Рабочий каталог и ветка — те, что назвал лид в задаче. Другие каталоги и ветки не трогать, не переключать ветку,
  не переписывать историю.
- Ничего не запускать на реальных серверах (82.146.37.224 и любых других). Стенд — только контейнеры
  `parley-stand-*` на этом Маке.
- Новые команды на сервере — только фиксированные шаблоны; всё переменное — после проверки (`input.ts`, спека
  3.4) и через `shQuote`. Секреты не попадают ни в лог, ни в окно (существующие тесты маскировки остаются
  зелёными).
- Комментарии в коде — на английском, как в соседнем коде `relay-setup/`.
- Проверка перед сдачей: `pnpm --filter @parley/desktop exec vitest run <затронутые тесты>`,
  `pnpm --filter @parley/desktop typecheck`, `pnpm exec eslint <затронутые файлы>`. Полный
  `pnpm --filter @parley/desktop test` — в задачах T5, T7 и T10.
- Отчёт лиду: SHA коммитов, список файлов, команды проверки и их итог (числа тестов), что не сделано и почему.

## Дорожки

- **A** (каталог лида): T1 → T2 → T3 → T4 → T4b → T5.
- **B** (отдельный каталог `git worktree`, ветка `fix/relay-wizard-one-click-runtime` от коммита спеки): T6 → T7.
  После T5 и T7 лид вливает B в основную ветку.
- **После слияния:** T8, затем T9 и T10 (могут идти параллельно, файлы не пересекаются).

## T1. Поле Relay принимает `https://` (спека 9)

- Файлы: `packages/desktop/src/shared/relay-input.ts` (+ `.test.ts`),
  `packages/desktop/src/renderer/components/settings/RemoteSettings.tsx` (+ `.test.tsx`),
  `packages/desktop/src/shared/strings.ts` (`settings.remote.relayInvalid`, новая `relayInsecure`).
- Состав: `normalizeRelayInput` снимает `https://` (без учёта регистра), как сейчас `ws://`/`wss://`, и один `/`
  в конце; `http://` → `null`. Новая `relayInputProblem(text): 'insecure' | 'invalid' | null` — окно показывает
  `relayInsecure` для `http://`, иначе `relayInvalid`. `relayInvalid` упоминает, что подходит и адрес `https://`.
  `remote-ipc.ts` `configure` не меняется (та же функция).
- Приёмка: `https://82-146-37-224.sslip.io` → `82-146-37-224.sslip.io`; `https://relay.example.com:8443/` →
  `relay.example.com:8443`; `HTTPS://Relay.example.com` → как у текущей логики для регистра хоста (тест
  фиксирует поведение); `http://relay.example.com` → `null` и `relayInputProblem` = `insecure`;
  `https://relay.example.com/path`, `https://user@relay.example.com` → `null`, `invalid`. Тест окна: ввод
  `https://…` → в поле `host`, `configure` вызван с `host`; ввод `http://…` → текст `relayInsecure`, `configure` не
  вызван. Существующие тесты (`wss://`, `ws://`) зелёные.

## T2. Разведка контейнеров и держатели портов (спека 3.1, 3.2; ошибка 2)

- Файлы: `packages/desktop/src/main/relay-setup/probe.ts` (+ `.test.ts`), `plan.ts` (+ `plan.test.ts`), новый
  каталог фикстур `packages/desktop/src/main/relay-setup/fixtures/course-vps/`.
- Состав:
  - `PROBE.containers` — команда спеки 3.1 (одна строка JSON на контейнер, шаблон `--format` — одна
    фиксированная строка). `parseContainers(text): ContainerInfo[]` — терпит пустой вывод, битые строки
    пропускает. `ContainerInfo`: `id`, `name` (без `/`), `image`, `labels`, `path`, `args`, `workdir`,
    `mounts[] {type, source, destination, rw}`, `published[] {hostPort, hostIp}`, `networks[]`, `networkMode`.
  - `ProbeResult.containers: ContainerInfo[]` (пусто без Docker или при ошибке команды).
  - `portHolders(probe)` / `holderOf(probe, port)` по спеке 3.2: наш контейнер — метка
    `com.docker.compose.project=parley-relay`; занятые порты — объединение `ss` и `published`; держатель —
    `{ kind: 'container', container } | { kind: 'process', names } | { kind: 'unknown-docker' }`.
  - `foreign()` и `isDockerProcess` больше не решают «наш/чужой»; `decidePorts` работает через держателей.
    Наличие `.env` на решение не влияет.
- Фикстуры (по файлу s-38, спека 6.5): `ss-ltnp.txt` (80/443 у `docker-proxy`, 22 у `sshd`), `containers.jsonl`
  (контейнер `course-platform-prod-caddy-1`: образ `caddy:2`, метка проекта `course-platform-prod`, публикует
  80 и 443 на `0.0.0.0` и `::`, сеть `course-platform-prod_default`, bind-тома
  `/opt/course-platform/deploy/Caddyfile → /etc/caddy/Caddyfile` и `/opt/evdev-site/caddy → /etc/caddy/sites`,
  `Path` `caddy`, `Args` `run --config /etc/caddy/Caddyfile --adapter caddyfile`; контейнер
  `parley-relay-relay-1` с метками из файла s-38, без опубликованных портов, в той же сети), `env.txt` (`.env`
  прогона 2), `previous-env.txt` (`.env` прогона 1, `RELAY_MODE=proxy`).
- Приёмка:
  - тест «прогон 2»: фикстуры course-VPS → решение **не** `caddy`; держатель 80 и 443 — контейнер
    `course-platform-prod-caddy-1` (до T4 решение — `proxy`, это ожидаемо);
  - userland-proxy выключен: `ss` без 80, контейнер чужого проекта публикует 80 → 80 занят;
  - наш контейнер (`parley-relay`) публикует 80/443 → не занято → `caddy` 80/443 (повтор своей установки);
  - `docker-proxy` на 80 без контейнера в списке → занято (`unknown-docker`);
  - старые тесты `plan.test.ts`/`probe.test.ts` обновлены там, где они опирались на `.env`, и зелёные.

## T3. Разведка веб-сервера (спека 3.3, 3.4, 5.3)

- Файлы: новые `packages/desktop/src/main/relay-setup/web.ts` (+ `web.test.ts`), `probe.ts` (третий этап
  разведки), `service.ts` (вызов третьего этапа в `finishProbe`), фикстуры.
- Состав:
  - Шаблоны спеки 3.4 (`isContainerId`, `isNetworkName`, `isSafePath`, …). Всё, что не прошло, — «не
    поддерживается» с причиной, не исключение.
  - `parseCaddyfile(text)` → `{ imports: string[] (верхний уровень), admin: 'off' | string | null }` с учётом
    комментариев, кавычек и вложенных скобок; `parseNginxDump(text)` → `{ mainFile, httpIncludes: string[],
    files: string[] }` по заголовкам `# configuration file …:`.
  - `hostPathOf(mounts, containerPath)` — самый длинный `destination`, bind или volume, **режим `:ro` не мешает**
    (спека 3.3).
  - `probeWeb(probe, shell): WebSurvey` — команды только чтения: `systemctl is-active caddy nginx apache2 httpd`,
    `systemctl show -p ExecStart --value caddy`, `systemctl show -p ExecReload --value caddy`,
    `docker exec <id> caddy version`, `docker exec <id> nginx -v`, `docker exec <id> nginx -T`, `nginx -T`,
    `cat <путь на хосте>` для Caddyfile и для возможных наших файлов (`parley-relay<суффикс>`, `parley-relay.conf`),
    `cat /var/tmp/parley-relay-setup/active` и проверка, жив ли этот процесс (`kill -0`). Значения в командах —
    только после шаблонов и `shQuote`.
  - `WebSurvey`: держатель 80/443, вид (`caddy` | `nginx` | `apache` | `other`), runtime (`docker` | `host` |
    `null`), контейнер (id, имя, сеть — по правилу спеки 3.3: та, где уже наш relay, иначе первая по имени),
    путь конфигурации на хосте и в контейнере, sha256 и текст Caddyfile, адрес admin, каталог для нашего файла
    (хост и контейнер) с суффиксом, найденные наши правки (файл или блок, по спеке 5.3), заняты ли имена
    `parley-relay`/`parley-relay-acme` чужим контейнером в выбранной сети, список причин «почему нельзя» (пустой —
    можно).
  - `ProbeResult.web: WebSurvey | null`; `ProbeResult.activeCommand: { pid, id } | null` (жив — план
    блокируется, спека 7.3).
- Фикстуры: Caddyfile курса (из файла s-38, байт в байт), Caddyfile с `admin off`, с `admin 127.0.0.1:2020`, с
  блоком-маркером, с одним маркером; `nginx -T` официального образа `nginx:1.27` и Debian 12 (`conf.d` и
  `sites-enabled`); `parley-relay.caddy` ручной (из файла s-38) и чужой файл с тем же именем.
- Приёмка: на фикстурах course-VPS `WebSurvey` = Caddy, docker, сеть `course-platform-prod_default`, каталог
  `/opt/evdev-site/caddy` ↔ `/etc/caddy/sites`, суффикс `.caddy`, admin `127.0.0.1:2019`, ручной файл
  распознан как наш; те же тома с `rw: false` дают тот же результат; путь с `..`, сеть `bridge`, `admin off`,
  Caddyfile не на томе, `--resume`, юнит без `ExecReload`, чужой файл с нашим именем, один маркер, чужой
  контейнер с именем `parley-relay` в сети — каждый даёт свою причину; контейнер в двух сетях — выбор
  детерминирован (тест на перестановку порядка); живой `active` → блок; все команды третьего этапа проверены
  тестом на фиксированный вид (ни одна не пишет на сервер).

## T4. Таблица решений (Caddy), шаблоны, установка и транзакция правки (спека 4, 5.1, 5.2, 6.1)

- Файлы: `plan.ts` (+ тест), `templates.ts` (+ тест), новый `web-edit.ts` (+ `web-edit.test.ts`),
  `packages/desktop/src/shared/relay-setup-types.ts` (`RelayPlanView.web`, спека 8.3), `service.ts` (`view()`).
- Состав:
  - `decideLayout(probe): Layout` — таблица спеки 4 по порядку, вместо `decidePorts`, для строк 1, 1б, 2, 4а, 5
    (строки 3 и 4б — в T4b; до неё nginx уходит в раскладку 5). Раскладка 5 несёт держателя и причину; держатель
    — контейнер в пользовательской сети → relay в этой сети и сниппет на `parley-relay:8787`; порты на петле —
    по спеке 4. Живой `activeCommand` и занятые имена в сети — блок с текстом спеки 3.3.
  - Шаблоны: `COMPOSE_NETWORK` (сервис **`parley-relay`**, внешняя сеть `${RELAY_NETWORK}`, без `aliases`),
    тексты наших правок для Caddy (спека 5.1), `renderEnv` с новыми ключами спеки 6.1 (без
    `RELAY_WEB_CONTAINER`). `COMPOSE_CADDY`/`CADDYFILE`/`COMPOSE_PROXY` не меняются.
  - `buildEditScript(edit)` — скрипт спеки 5.2 (`set -eu`, sha до и после записи, свободное место, копия в
    `/var/backups/parley-relay/`, запись на месте, проверка и перезагрузка по runtime: Docker — `docker exec`
    с путём в контейнере и `--address`; host Caddy — только `systemctl reload caddy`) для действий `add`,
    `replace`, `append`, `remove`, `remove-block`; обратимый блок с отметкой о дописанном `\n`.
  - Шаги установки по таблице спеки 6.1; проверка `web` — sha **и** «сервер знает наш сайт» (admin API
    `GET /config/` через `wget`/`curl`; нечем проверить → шаг выполняется); проверка `start` ищет сервис
    раскладки; `start` с `--quiet-pull`. Шаг образа строится одной функцией (её же меняет T6) и получает список
    образов раскладки.
  - Заметки плана и блок `web` для экрана (спека 2, 8.3), строка «reload applies your whole configuration».
- Приёмка:
  - по тесту на каждую строку таблицы 4 (1, 1б, 2, 4а, 5) и на каждую причину раскладки 5;
  - фикстуры course-VPS → `caddy-site` docker, адрес `82-146-37-224.sslip.io`, шаги `docker, dir, files, image,
    start, web`, правка — `replace` файла `/opt/evdev-site/caddy/parley-relay.caddy` (на чистом сервере без
    ручного файла — `add`), `caddy validate --config /etc/caddy/Caddyfile` и `caddy reload … --address
    127.0.0.1:2019` через `docker exec <id>`;
  - `web-edit.test.ts` запускает сгенерированный скрипт `/bin/sh` во временном каталоге с подставными
    validate/reload (`true`/`false`): копия байт в байт; inode цели не меняется (`stat`); провал validate →
    файл как был; провал reload → файл как был; новый файл при провале удалён; изменённый sha → выход до
    записи; «дописать → убрать» возвращает исходный sha для файла с `\n` в конце и без; `remove-block`
    оставляет остальной текст байт в байт; значения с пробелами и кавычками не ломают скрипт (через `shQuote`);
  - все команды плана — фиксированные шаблоны (тест на отсутствие непроверенных значений, как в
    существующих тестах `plan.test.ts`).

## T4b. Раскладка `nginx-acme` (спека 4 строки 3 и 4б, 4.1)

- Файлы: `plan.ts`, `templates.ts`, `web-edit.ts`, `web.ts` при нужде (+ тесты).
- Состав: строки 3 и 4б таблицы; шаблоны `COMPOSE_ACME_DOCKER`, `COMPOSE_ACME_HOST` (сервисы `parley-relay` и
  `parley-relay-acme`), `CADDYFILE_ACME`; блоки nginx спеки 4.1 (Docker — `resolver 127.0.0.11` и переменная,
  host — `127.0.0.1:<RELAY_ACME_PORT>`); проверка `nginx -t` (с провалом на `conflicting server name "<имя>"`) и
  `nginx -T` (наш файл подключён, путь в контейнере); `nginx -s reload`; порядок шагов `… ufw (8443), web,
  start`; ufw 8443.
- Приёмка: тесты строк 3 и 4б и их причин раскладки 5 (`conf.d` не подключён, не на томе, 8443 занят, сеть
  `bridge`, нет порта на петле); фикстуры `nginx -T` официального образа и Debian 12; `web` идёт до `start`;
  скрипт правки nginx в `web-edit.test.ts` (вывод `nginx -t` с конфликтом имени → откат). Если задача не
  проходит критику дважды — nginx остаётся в раскладке 5 (спека 10а).

## T5. Повтор, обновление, откат, удаление; распознавание раскладок (спека 6.2–6.5)

- Файлы: `plan.ts` (+ тест), при нужде `web.ts`, `service.ts` (`addressFromEnv` для новых раскладок, проверка
  здоровья `proxy` во время разведки).
- Состав: живая разведка — источник истины для всех действий (6.2); правило перехода (блок с текстом при
  переносе нашей правки); работающий `proxy` сохраняется (одна попытка `https://<адрес>/v1/health` с Мака,
  таймаут 5 с, через тот же `HealthFetcher`); строка о смене адреса; откат только в той же раскладке по
  условию 6.3; удаление по таблице 6.4 с `web-undo` перед `down`, выбор строки — по живой разведке; удаление
  оставшихся томов проекта при «delete data»; `addressFromEnv` и экран после отката для `caddy-site` и
  `nginx-acme`.
- Приёмка:
  - course-VPS (фикстуры T2/T3): установка разрешена несмотря на `RELAY_MODE=caddy`; откат сразу после этого
    блокирован (в `previous` — `proxy`); удаление **без предварительной переустановки** (`.env` с `caddy`) —
    шаги `web-undo, down, ufw, files`, `web-undo` убирает только `parley-relay.caddy`;
  - наша правка в Caddy, а теперь 80 держит nginx → установка блокирована текстом спеки 6.2;
  - `.env` с `proxy` и отвечающее здоровье → раскладка `proxy` сохраняется, строка в плане; не отвечает → переход
    на новую раскладку со строкой о смене адреса;
  - `caddy` → `caddy-site` (правки не было) → разрешено, `start` с `--remove-orphans`;
  - откат в одной раскладке — шаги `restore, start`; другой домен или порт в `previous` — блок;
  - удаление с данными — команда томов по метке проекта; без данных — тома не трогаются; копии
    `/var/backups/parley-relay/` не удаляются;
  - повтор с теми же файлами — проверки шагов совпадают с тем, что пишет установка (тест сравнивает sha
    шаблонов с проверкой шагов `files` и `web`);
  - полный `pnpm --filter @parley/desktop test` зелёный.

## T6. Команды вне канала SSH, прогресс образа и отмена (спека 7) — дорожка B

- Файлы: `ssh.ts`, `shell.ts`, `steps.ts` (+ тесты), новый `pull-progress.ts` (+ тест), `plan.ts` (только
  функция шага образа и поле `interruptible` у `PlanStep`), `service.ts` (`cancel`, фаза `cancelled`, текст при
  обрыве), `relay-setup-types.ts` (фаза `cancelled`, события `progress` и `cancelling`).
- Состав:
  - Обёртка спеки 7.3 для каждой команды шага (не для проверок): `setsid`, журнал и код в
    `/var/tmp/parley-relay-setup/`, файл `active`, `tail --pid`. Одна функция строит обёртку; идентификатор
    команды — из id шага и номера, по шаблону `[a-z0-9-]+`.
  - `PlanStep.interruptible`; отмена прерываемого шага — второй командой `kill -TERM -- -<pid>` по `active`; у
    прочих — событие `cancelling` и остановка после шага; прерванная нами команда → `stopped`, не `failed`.
  - Обрыв канала во время команды → итог с текстом спеки 7.3 (не «failed: step»).
  - Шаг `image`: команда спеки 7.1 на каждый образ, параметры `fromImage`/`tag` по правилу 7.1 (digest →
    `tag=sha256:…`, без текстового тега; пустой `tag` запрещён), проверка `docker image inspect` всех образов.
  - `createPullProgress()` — разбор строк Engine API (слои, байты, ошибки, неизвестные статусы терпимо) и
    запасного вывода `docker pull` (только слои); события `progress` не чаще 4 раз в секунду; в лог — итоги по
    спеке 7.1, а не сырые строки JSON.
  - `start`: `up -d --remove-orphans --quiet-pull`.
  - Итог отмены — `{ phase: 'cancelled', step, message }` с текстом спеки 7.2; отмена во время проверки
    здоровья — `cancelled` с `step: 'health'`.
- Приёмка:
  - обёртка 7.3 запускается `/bin/sh` локально в тесте (с подменой каталога): журнал и код пишутся, `tail`
    отдаёт строки; убитый «канал» (`kill` процесса `tail`) не останавливает команду — она дописывает код;
    `kill -TERM -- -<pid>` по `active` останавливает команду; если на macOS нет `setsid` или `tail --pid`, тест
    запускается в контейнере `ubuntu:24.04` или помечается пропущенным с причиной в отчёте;
  - разбор на строках Engine API (снять у локального Docker через `curl --unix-socket … /images/create` любого
    маленького образа и сохранить фикстурой; Docker Desktop запущен лидом) и на выводе `docker pull` из
    `~/.parley/remote/relay-setup.log` (17:58Z); `caddy:2.11.7@sha256:…` → `fromImage=caddy&tag=sha256:…`;
  - отмена во время шага `image` на поддельной оболочке → вторая команда `kill`, шаг `stopped`, фаза
    `cancelled`, следующих шагов нет; отмена во время `start` → событие `cancelling`, `start` доходит до конца,
    дальше `stopped`, фаза `cancelled`; ошибка `{"error":…}` в потоке при нулевом коде `curl` → шаг падает по
    `docker image inspect`; обрыв канала → текст 7.3.

## T7. Прогон живёт в main (спека 8.1, 8.2) — дорожка B

- Файлы: `service.ts` (+ тест), `relay-setup-types.ts` (`RelayRunView`, вызовы `state` и `dismiss`, `seq` у
  событий, событие `phase`), `ipc.ts` (+ тест), `packages/desktop/src/main/index.ts` (`dispose` на `quit`
  вместо `before-quit`), `packages/desktop/src/renderer/test-utils/fake-bridge.ts`.
- Состав: запись прогона по спеке 8.1; `run` отвечает сразу `{ phase: 'running' }`; итог — событие `phase` и
  `state`; `check` обновляет итог; `dismiss` во время прогона — отказ; `begin` при записи с итогом — забывает её;
  строки — не больше 200 на шаг в записи (в лог — все, как сейчас).
- Приёмка: тест сервиса — `run` возвращается до конца поддельного прогона; `state` во время прогона содержит
  шаги, строки, прогресс; после итога — итог; `seq` растёт на каждое событие и совпадает между событиями и
  `state`; `dismiss` во время прогона отклонён, после — `state` = `null`; в записи нет ни пароля, ни парольной
  фразы, ни пароля sudo (расширение существующего теста маскировки); `ipc.test.ts` пропускает `state` и
  `dismiss`; в `index.ts` `dispose` мастера висит на `quit` (проверка кодом и строкой в отчёте: отменённый
  выход прогон не трогает); полный `pnpm --filter @parley/desktop test` зелёный.

## T8. Окно мастера (спека 7, 8.2, 8.3) — после слияния A и B

- Файлы: `RelaySetupDialog.tsx` (+ `.test.tsx`), `strings.ts`, при нужде `RemoteSettings.tsx`.
- Состав: закрытие только крестиком (Esc и клик по фону — нет, во всех фазах); крестик до Run — отмена сеанса,
  во время прогона и после — только спрятать; при открытии — подписка, затем `state`, затем буфер событий с
  `seq` больше снимка (спека 8.1); есть запись → её вид; полоса прогресса и текст спеки 7.1; «Cancelling after
  this step…» с неактивным Cancel; фаза `cancelled` без красного; подвал итога — Close (`dismiss` + закрыть) и
  New setup (`dismiss` + форма); блок «Your web server» на плане (спека 8.3).
- Приёмка (тесты окна на `fake-bridge`): Esc и клик по фону не закрывают ни форму, ни прогон; крестик во время
  прогона не вызывает `cancel`; повторное открытие показывает тот же лог; после «перезагрузки» (новый экземпляр
  компонента) — вид из `state`; событие, пришедшее между подпиской и ответом `state`, не теряется; прогресс и
  «Cancelling after this step…» видны; план с правкой показывает путь, действие, содержимое, копию; Close и New
  setup вызывают `dismiss`; существующие тесты окна обновлены и зелёные.

## T9. Стенд Docker (спека 10) — после T8

- Файлы: `packages/desktop/test/relay-setup/` (`stand.ts`, новые `stand-web.test.ts` или расширение
  `stand-install.test.ts`, каталог `docker/course-vps/` с файлами раскладки 6.5, `README.md`), `stand.test.ts`
  (случай nginx теперь ждёт `nginx-acme` host).
- Состав: S1, S2, S3 по спеке 10 (в S1 тома `:ro`, свой сервис `relay` человека в сети, `down`/`up` проекта
  человека; в S2 — удаление и после повтора, и сразу); желательно — nginx в Docker, обрыв SSH во время долгой
  команды, загрузка образа из локального `registry:2` внутри сервера с проверкой событий `progress`. Здоровье —
  запрос к relay изнутри сервера, как сейчас.
- Приёмка: команды из README выполнены на этом Маке, число пройденных тестов и время — в отчёте; S1–S3
  зелёные; не сделанное желательное — в отчёте с причиной. Контейнеры `parley-stand-*` удалены после прогона.

## T10. Снимки окна, документация — после T8

- Файлы: `packages/desktop/src/main/index.ts` (подмена SSH сценарием через `PARLEY_RELAY_SETUP_FAKE_SSH`, только
  при `!app.isPackaged`), `packages/desktop/e2e/relay-setup.spec.ts`, `packages/desktop/e2e/fake-relay-ssh.mjs`,
  `docs/specs/2026-10-29-mobile-app-design.md` (6.7: отсылка к новой спеке в «Занятые 80 и 443» и в
  «Безопасность»), `CHANGELOG.md` (`## Unreleased`).
- Состав: сценарный SSH отвечает на разведку фикстурами course-VPS, на `image` — медленным потоком JSON
  Engine API, на `start` — держит шаг, пока тест не разрешит; здоровье — подставное. Снимки в каталог
  `RELAY_SHOTS`: план с чужой правкой, прогресс загрузки, «Cancelling after this step…», возврат в идущую
  установку из Settings (и после `window.reload()`), экран готово.
- Приёмка: `pnpm --filter @parley/desktop build` и e2e-тест зелёные; пять снимков в каталоге, пути — в отчёте;
  подмена недоступна в упакованной сборке (тест или проверка кода с объяснением); записи `CHANGELOG.md`
  (Fixed/Changed) без раздела «что дальше».
