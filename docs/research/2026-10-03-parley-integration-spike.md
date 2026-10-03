# Parley — evidence базы и разведки интеграции

Дата: 2026-10-03. Этот файл фиксирует P00; результаты P01–P04 добавляются в своих исследованиях. Код и пользовательские настройки в P00 не менялись.

## P00: актуальная изолированная база

Проверка выполнена исполнителем отдельно от подготовки worktree ведущим. Окончательную приёмку и статус очереди ведёт ведущий после независимого ревью.

| Поле | Проверенное значение |
|---|---|
| Checkout реализации | `/Users/kalmbik61/.codex/worktrees/parley-upgrade/my_harnas` |
| Рабочая ветка | `codex/parley-upgrade` |
| Исходный master | `72a87361d8073c011e60f31e5d254f1045ff086b` |
| Стартовый документационный commit / HEAD перед P00 evidence | `1acc937857b2ea3e3242165546e888bb6a4c37a4` |
| Checkout документации | `/Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/parley-md` |
| Ветка / HEAD документации | `docs/parley-md` / `fecaea365254c3b83dbaedd039bb6f355e433042` |
| merge-base master и docs/parley-md | `661fbeb3ccc2cd36628bc81bcbe55914fe935a4a` |
| HEAD / merge-base master и feat/chat-view | `031c5c9e0775e04ac19a2260a77373101119a71f` |

`master` — merge commit chat-view с родителями `4e10701e1a886a4ba5a187f9ecfeae178e38e132` и `031c5c9e0775e04ac19a2260a77373101119a71f`. Стартовый `1acc937` непосредственно основан на указанном master. Разница содержит только девять перенесённых документов, новый журнал workflow и добавление раздела 19 в `TODOS.md`: 11 файлов, 4137 добавленных строк. Удалений и переноса старых исходников нет.

При первом осмотре worktree реализации содержал две ожидаемые незакоммиченные правки ведущего: очередь `docs/plans/2026-10-03-parley-agent-tasks.md` и журнал `docs/plans/2026-10-03-parley-execution.md`. Их текущая запись о P00 running не входит в commit исполнителя. Для точного сравнения документов используется `1acc937`, а не рабочий текст очереди. Установка зависимостей ведущим идёт отдельно; состояние `node_modules` не является результатом P00.

## Сохранение chat-view и capabilities.list

`git diff --exit-code` подтвердил равенство всего дерева `packages`, `package.json`, `pnpm-lock.yaml` и `pnpm-workspace.yaml` между исходным master и стартовым commit. Перед commit evidence эти пути также равны master в рабочем дереве.

Проверены существующие точки контракта:

- `packages/core/src/capabilities/scan.ts`: актуальный scanner Claude, пользовательские/проектные источники, предел 500 записей и глубина команд 4.
- `packages/host/src/methods/capabilities.ts`: `createCapabilitiesList`, абсолютный `projectPath`, вызов scanner для Claude и пустые массивы для других провайдеров.
- `packages/host/src/methods/index.ts`: зарегистрирован существующий `capabilities.list`.
- `packages/protocol/src/methods.ts`: аргументы `{ projectPath, provider }`, результат `Capabilities`.
- `packages/protocol/src/types.ts`: DTO подсказок поля ввода chat-view.
- `packages/desktop/src/renderer/chat/capabilities-store.ts`: существующий вызов `capabilities.list` с `projectPath`/`provider` и кэш подсказок.

Manifest проекта и core сохраняет версию `0.4.0`, `pnpm@9.12.3`, Node `>=20`; core сохраняет единственную runtime dependency `@modelcontextprotocol/sdk` `^1.30.0`. Новые YAML/TOML dependencies не добавлены: их проверка принадлежит P04/P05.

## Девять согласованных документов

Каждый файл из таблицы побайтно совпадает между исходным рабочим checkout документации и blob стартового commit. Это сохраняет и незакоммиченные согласования в исходном checkout, и новые untracked документы; копирование только HEAD `docs/parley-md` потеряло бы их.

| Файл относительно checkout | Байты | SHA-256 |
|---|---:|---|
| `docs/plans/2026-10-03-parley-agent-tasks.md` | 86760 | `ae1880eb9f4d8f9f418d57b3b5302c79d17a06a64a1a11a2255c7bdad1cd9f51` |
| `docs/plans/2026-10-03-parley-unified-implementation-plan.md` | 57576 | `fc13a384d0a4230d42c3df94deb6c469b8c2801b8c00a8d7ef753250326e146a` |
| `docs/specs/2026-10-02-agent-roles-design.md` | 30396 | `a37f4b449fc36eaea0094761eee81127dee0efb5c1698fefe4528c3ae9d16e4b` |
| `docs/specs/2026-10-02-capabilities-design.md` | 29172 | `274434ab0db4bd701e011e926880be1a835d846376da27707532aefd29e5be1a` |
| `docs/specs/2026-10-02-parley-md-design.md` | 30706 | `dec31949f8624ae60323604af2bee3ddc7ba989062e30cd2eb3257f81151bb45` |
| `docs/specs/2026-10-02-plans-backlog-design.md` | 38853 | `7471ae0a5a271da006bf4bf310289848d1bd62ddff1393ef105dec00b542397a` |
| `docs/specs/2026-10-02-room-recipes-design.md` | 18775 | `7fb4f054dc283f3ecb4a95cb7087484355563becfee5845aef9860cdbaf583a9` |
| `docs/specs/2026-10-03-memory-journal-design.md` | 20690 | `45e0830544698f3aec91f77d5159be76277b250e57280bf3feab409057f0779b` |
| `docs/specs/2026-10-03-skill-navigator-design.md` | 33158 | `cfce26876d718a13bf7fca805518d2c032098588d838874a6b4f39a9149b97af` |

Отдельная побайтная проверка `TODOS.md`: удаление добавленного раздела от `## 19. Parley вместо OMC:` до следующего `## Справка: спайк канала 2026-09-18` восстанавливает все 78361 байт исходного файла master. Это защищает прежние разделы очереди, а не переносит старый `TODOS.md` целиком.

## Сохранение исходных checkout

Состояние исходного master при осмотре: изменён `.omc/project-memory.json`; untracked — временный файл `.omc`, `.pnpm-store/`, `.superpowers/`, три документа `docs/specs` и `packages/desktop/prototype/`. В docs/parley-md изменены `.omc/project-memory.json`, `TODOS.md` и пять прежних спек; untracked — два плана и две новые спеки. Эти файлы не записывались исполнителем.

До и после записи P00 evidence совпали HEAD, SHA-256 `git diff --binary HEAD` и SHA-256 списка `[relativePath, fileSha256]` всех неигнорируемых untracked файлов. `.pnpm-store/` исключён из последнего списка: кеш пакетов не входит в исходные изменения и может меняться при установке зависимостей ведущим. Игнорируемые runtime/cache файлы не проверялись и не менялись исполнителем.

| Checkout | SHA-256 tracked diff | Untracked файлов | SHA-256 untracked manifest |
|---|---|---:|---|
| Исходный master | `42c3df12523b48b9af9d1bab97a4fa5318ebf85d7baca86313855084a8b14d6b` | 54 | `070d2977a2c63a9d53045c02e7d1224b876b7136244cd65ccfed869f33fd6d26` |
| Исходный docs/parley-md | `c2a06ed2c7c7081912c7b65b12efe879534ca36438ec87f374c61bc49955191f` | 4 | `f31a5551a603950f272e23a060971ec5c2fd93647b53a3fdfae8b227aba74f7f` |

## Воспроизводимые проверки

Из checkout реализации:

```sh
git status --short
git log -1 --oneline
git rev-parse master docs/parley-md
git merge-base master docs/parley-md
git merge-base master feat/chat-view
git rev-list --parents -n 1 1acc937
git diff --stat 72a87361 1acc937
git diff --exit-code 72a87361 1acc937 -- packages package.json pnpm-lock.yaml pnpm-workspace.yaml
git diff --exit-code 72a87361 -- packages package.json pnpm-lock.yaml pnpm-workspace.yaml
git diff --check
```

Все перечисленные проверки выполнены; проверки равенства и whitespace завершились с exit 0. Пустой `git status` всего worktree не ожидается, пока ведущий хранит свои правки очереди и журнала.

Документы и прежнее содержимое `TODOS.md`:

```python
from pathlib import Path
import hashlib, subprocess
source = Path('/Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/parley-md')
base, seed = '72a87361', '1acc937'
def git(*args):
    return subprocess.check_output(['git', *args])
files = [p.decode() for p in git('diff', '--name-only', base, seed).splitlines()
         if p.startswith(b'docs/') and not p.endswith(b'parley-execution.md')]
assert len(files) == 9
for path in sorted(files):
    blob = git('show', f'{seed}:{path}')
    assert blob == (source / path).read_bytes(), path
    print(path, len(blob), hashlib.sha256(blob).hexdigest())
old, new = git('show', f'{base}:TODOS.md'), git('show', f'{seed}:TODOS.md')
start = new.index('## 19. Parley вместо OMC:'.encode())
end = new.index('## Справка: спайк канала 2026-09-18'.encode(), start)
assert new[:start] + new[end:] == old
```

Для manifest исходного checkout `root`:

```python
import hashlib, json, subprocess
from pathlib import Path
def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])
def sha(data):
    return hashlib.sha256(data).hexdigest()
def snapshot(root):
    root = Path(root)
    files = []
    for name in git(root, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
        if not name or name.startswith(b'.pnpm-store/'):
            continue
        path = root / name.decode()
        data = path.readlink().as_posix().encode() if path.is_symlink() else path.read_bytes()
        files.append([name.decode(), sha(data)])
    manifest = json.dumps(files, ensure_ascii=False, separators=(',', ':')).encode()
    return (git(root, 'rev-parse', 'HEAD').decode().strip(),
            sha(git(root, 'diff', '--binary', 'HEAD')), len(files), sha(manifest))
for root in ['/Users/kalmbik61/Desktop/MY/my_harnas',
             '/Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/parley-md']:
    print(root, snapshot(root))
```

## Граница приёмки

P00 подготовлена к независимой приёмке: актуальные исходники сохранены, девять документов доступны, checkout/ветка/точные SHA и исходные изменения зафиксированы. Живые CLI launch/resume, budget/jev, scopes и действия Capabilities ещё не проверены в P00; это отдельные P01/P02/P03. Выбор YAML/TOML — P04. Тесты приложения не запускались для этой документальной проверки; побайтное равенство кода подтверждает отсутствие изменения поведения в P00, но не заявляет исправность исходного приложения.


## P04: закрытый контракт разведки для реализации

2026-10-03; входной HEAD `28b9187e19766304bd785c8885576c9857d2babb`. P01/P02/P03 приняты независимо ведущим. Новый [contracts.md](2026-10-03-parley-cli/contracts.md) фиксирует NativeSkill provider+canonical document identity, source/system/admin/extra, boolean availability с explicit unverified reason; native priority/rules/policy, production full-list fallback обоих CLI, provider-specific actions/scopes и точные предложения правок спек/плана для интеграции root. Предыдущие P00 snapshot/hash checks оставлены неизменными и относятся к стартовому commit.

Parser pins проверены по official tagged upstream и registry: **yaml 2.9.1 / ISC / Node >=14.6** и **smol-toml 1.9.0 / BSD-3-Clause / Node >=18**, оба без runtime dependencies. Official tarballs распакованы только в `/tmp` после SHA-512 integrity verification, без install/правок repo. На installed Node 20.15.1 прошли 12 isolated API cases полного multiline parsing, duplicate/invalid rejection, bounded YAML aliases, TOML options и escaping roundtrip. Product dependency edits и P05 tests ещё не выполнены.

Минимальная synthetic Node-проба macOS arm64/Node25.8.0 подтвердила 98304-byte serialized arg, точные UTF-8/escaped bytes, cumulative argv+env fit и E2BIG при overflow; getconf ARG_MAX=1048576. Контракт требует host guard после окончательного env merge и hook token, а не только core per-arg check. Linux execution/long native paths/custom providers остаются явными P32 gates; не заявлены выполненными.

Решения: весь SKILL.md ограничен 65536 bytes; body не идёт в metadata. Claude fraction0 invalid, env1 candidate gated, exact jev module id с сохранением hooks/statusLine. Codex selectors — полный SKILL.md, User/SessionFlags-only rules, duplicates по canonical path; include_instructions/budget candidate gated; native role TOML требует name. Codex plugin mutations add/remove, остальные toggles/details/update unavailable; Claude details installed-only; local MCP identity canonical main. Raw parser/CLI error и **success** output также не передаются с секретами.

P04 сдаётся на независимое ревью. Контракт пригоден для следующих реализаций при указанных fallback; это не live release acceptance и не включение сокращения списков.
