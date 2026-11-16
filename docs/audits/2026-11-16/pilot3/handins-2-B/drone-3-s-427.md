<!-- drone 3 s-427 model=haiku addedAt=2026-11-16T17:40:42.245Z handedAt=2026-11-16T17:44:36.556Z result=done -->
Drone C (s-427), slice «worktrees и launch», Parley @ 9eabc014, read-only copy /Users/kalmbik61/parley/pilot3-subject. Прочитаны целиком: packages/core/src/work/worktree.ts (1–1457), worktree-include.ts, worktree-seed.ts, worktree-owner.ts, launch.ts (1–920; 921–1095 не читал). Дополнительно прочитан packages/host/src/worktrees/worktrees-service.ts:180–269 (вызов mergeWorktree), grep по callers. Тесты не смотрел.

Q09 — слияние ветки в базу.
Атомарные утверждения:
- Вход: host merge(ref) вызывает requirePresentWorktree, затем mergeWorktree; сообщение коммита формируется до него — packages/host/src/worktrees/worktrees-service.ts:210–214. requirePresentWorktree проверяет наличие каталога (stat, ENOENT/ENOTDIR = отсутствует, прочие ошибки пробрасываются) — worktrees-service.ts:121–135; хвост функции (после строки 135) не читал.
- Порядок проверок в mergeWorktree (packages/core/src/work/worktree.ts:1301–1339):
  1) assertRevisions(base, branch): пустое имя, префикс «-», check-ref-format → InvalidRevisionError — worktree.ts:1308; 424–432.
  2) findBaseCheckout: база ищется по ветке или HEAD среди worktree list; не найдена → reason `base_not_checked_out` — worktree.ts:1309–1310; 840–845.
  3) pinnedCheckout для своей копии (если не removedAt) и для базы: проверка .git (checkoutGitDir), при подмене GitStateError `worktree-corrupt`; отсутствующий каталог — ошибка stat как есть — worktree.ts:1314–1315; 691–699.
  4) projectPrefix (worktree.ts:1316; 852–854).
  5) isDirty(база) → `base_dirty` — worktree.ts:1317; isDirty: status --porcelain без каталогов состояния (STATE_DIRS) — 863–873.
  6) isDirty(своя копия) → `uncommitted` — worktree.ts:1319–1321.
  7) только затем git merge --no-ff -m <message> --end-of-options <branch> в базе — worktree.ts:1323–1325.
- mergeCheck (merge-tree --write-tree, worktree.ts:1059–1079) НЕ вызывается из mergeWorktree; его вызывают только host mergeCheck (worktrees-service.ts:253–255) и десктоп (packages/desktop/src/renderer/review/use-changes.ts:132). Поэтому предварительной проверки конфликтов перед слиянием нет.
- Конфликт: merge упал → список файлов `git diff --diff-filter=U --name-only -z` (worktree.ts:1330–1332), затем `merge --abort` (1333), результат reason `conflict` с files (1334). Замечание: catch ловит любой сбой merge, не только конфликт; при не-конфликтном сбое files может быть пустым, а результат всё равно `conflict` (1326–1334).
- Успех: rev-parse HEAD базы, `ok: true` — worktree.ts:1337–1338.
- Ошибки: InvalidRevisionError и GitStateError в host переводятся в gitFailure — worktrees-service.ts:218.
- Не проверяется: isBranchMerged не вызывается в mergeWorktree (worktree.ts:1383 — только в removeWorktreeCopy:1449).

Q10 — фильтры отбора путей .worktreeinclude.
- Файл списка: только обычный файл, размер > 0 и ≤ 256 KiB (INCLUDE_MAX_FILE_BYTES) — worktree-include.ts:14–15, 88–89; иначе [].
- Кандидаты: `git ls-files -z --others --ignored --directory --exclude-from=<файл>` в основной копии — worktree-include.ts:91, 47–60.
- Пересечение с игнором по стандартным правилам `--exclude-standard` (второй ls-files) — worktree-include.ts:93–99.
- safeEntry: без пустого, абсолютного пути, сегментов `..`/пустых и без первого сегмента `.git` — worktree-include.ts:77–82, 100.
- Игнор в основной копии: check-ignore --stdin с ключами (каталог с «/») — worktree-include.ts:103, 66–74.
- Дедуп, сортировка, отбрасывание «/» на конце — worktree-include.ts:105–111.
- Вложенные записи внутри уже выбранного каталога пропускаются — worktree-include.ts:113–125.
- lstat в основной копии: отсутствующий и симлинк пропускаются — worktree-include.ts:126–127.
- Потолок 1000 записей (INCLUDE_MAX_ENTRIES) — worktree-include.ts:16, 130.
- В новой копии (resolveIncludePaths): каталоги подаются с «/», check-ignore выполняется в targetRoot, остаются только пути, игнорируемые и там — worktree-include.ts:139–158 (ключ каталога — 147–151; фильтр — 152–154).
- Любой сбой git или exception даёт пустой список без отчёта — worktree-include.ts:58, 68–72, 133–135, 155–157.
- Вызов из seed: sourceRoot из `rev-parse --show-toplevel`, одинаковые realpath дают null — worktree-seed.ts:199–203.

Q11 — клон по одному пути.
- Платформа: не darwin → unavailable (отчёт пустой) — worktree-seed.ts:206–207, 239; тот же том и APFS через df/diskutil — worktree-seed.ts:84–104, 210; исключение = false — worktree-seed.ts:210.
- Временный каталог: gitDir/`parley-seed` (`rev-parse --absolute-git-dir`), сброс и mkdir — worktree-seed.ts:213–218; dev временного каталога должен совпасть с dev источника, иначе unavailable — worktree-seed.ts:221–225.
- Любой сбой до цикла → null, без отчёта — worktree-seed.ts:227–229.
- Лимиты: SEED_MAX_ENTRIES = 300 000, SEED_TIMEOUT_MS = 120 000 — worktree-seed.ts:17–18; deadline = now + timeoutMs — worktree-seed.ts:241.
- Для каждого пути по порядку: если цель уже есть — пропуск без отчёта — worktree-seed.ts:253–254.
- Срок: если истёк (или флаг expired) — skip `timeout`, и флаг expired блокирует все следующие клоны — worktree-seed.ts:255–260; повторная проверка после countEntries — worktree-seed.ts:267–272.
- Счёт записей: countEntries(source, maxEntries − used): сам путь + вложенные, симлинки не раскрываются, обход встаёт, когда count > limit — worktree-seed.ts:120–135, 261. Превышение — skip `entries`, цикл продолжается (не expired) — worktree-seed.ts:262–264. used растёт только на клонированные — worktree-seed.ts:281. countEntries не имеет собственного таймера (его время не ограничено deadline) — наблюдение по коду.
- Таймер: setTimeout до deadline, aborts controller — worktree-seed.ts:273–277. clonePath: cp -c -R (каталог: mkdir stage, затем cp source/. stage) или cp -c (файл), таймаут команды SEED_TIMEOUT_MS = 120 000 плюс signal — worktree-seed.ts:106–118, 73–82, 18. Итог: клон ограничен меньшим из (остаток deadline, 120 s).
- Сбой клона или abort: reason `timeout`, если expired или aborted, иначе `failed` — worktree-seed.ts:283–284. Через `throw` после abort — worktree-seed.ts:279.
- Путь на место: stage = stageRoot/<index> (249); moveIntoPlace: mkdir родителя, проверка «цель появилась» → throw (даёт reason `failed`), каталог — rename(stage, target), файл — link(stage, target) и rm stage — worktree-seed.ts:171–180, 280. stage удаляется в finally пути и в конце — worktree-seed.ts:285–288, 292–294.
- Отчёт: skipped и cloned → toWorktreeSeed: первые 5 пропусков, lockMismatch до 3 — worktree-seed.ts:309–320; описание пропусков (too many files / timed out / failed) — worktree-seed.ts:322–338, 335–357. Ошибка самого обхода (catch 290–292) — молча; непройденные пути в отчёт не попадают — worktree-seed.ts:290–292.
- После клонов: lockMismatchOf (сравнение байтов tracked lock-файлов) — worktree-seed.ts:145–157, 297–300; isStalePnpm — worktree-seed.ts:159–165, 301–305.
- Вызов host: packages/host/src/worktrees/deps-seed.ts:31, 87 (не читал полностью).

Q12 — writable roots Codex в worktree.
- Условия (launch.ts:504): runner === codex, НЕ workspace (автономная сессия), НЕ role.readOnly, role.sandboxMode === 'workspace-write', есть session.worktree, в шаблоне запуска есть {approvals}. Выполняется в plan() для всех режимов (launch/resume/new), т.к. plan общая — launch.ts:286–292, 504.
- Валидация prepareWorktreeGitWrites (worktree.ts:631–672), по порядку: имя ветки = parley/<work>/<session> или legacy harnas/<work>/<session> — 638; assertRevisions — 639; common = git-common-dir — 640; checkoutGitDir(common, cwd) должен быть не null и не равен common — 642–643; symbolic-ref HEAD в gitDir должен быть refs/heads/<branch> — 646–648; создание родительских каталогов refs/heads и logs/refs/heads внутри common, каждый должен быть каталогом — 649–661; файлы branchRef, branchRef.lock, branchLog, branchLog.lock, если существуют, — обычные файлы — 662–668; objects — каталог — 669–670. Любой отказ — GitStateError `worktree-corrupt` — 643, 647, 659, 667, 670. Не перехвачено в plan(): launch.ts:505 без catch.
- Точные локации (worktree.ts:671 и launch.ts:506): gitDir рабочей копии сессии (common/worktrees/<имя>), <common>/objects, <common>/refs/heads/<branch>, <…>.lock, <common>/logs/refs/heads/<branch>, <…>.lock — всего 6 путей. Передаются как `-c sandbox_workspace_write.writable_roots=<JSON-массив>` — launch.ts:506.
- Для workspace-клонов иначе: sandbox_workspace_write.exclude_slash_tmp/exclude_tmpdir_env_var (launch.ts:497–498), это не writable roots.

Answered: Q09 (порядок, отказы, конфликт), Q10 (фильтры в обоих корнях), Q11 (пропуски, лимиты, финальное размещение), Q12 (условия, валидация, 6 путей).
Open: откуда role.sandboxMode и role.readOnly (agents.ts, не читал); codexPolicyArgs (codex-policy.ts) — прочие флаги одобрений; caller seedWorktree в deps-seed.ts (не читал целиком); launch.ts 921–1095 не читал; поведение Codex по умолчанию (cwd как writable по умолчанию) не проверено по исходникам этого репо — только писать явно через writable_roots.
Not verified: поведение git и cp -c на реальном APFS (не запускалось, только чтение); сборка и тесты не запускались.

Coverage: partial — не читал launch.ts 921–1095, полный хвост requirePresentWorktree (worktrees-service.ts 136+), deps-seed.ts целиком, agents.ts и codex-policy.ts (нужны для источника role.sandboxMode и флагов одобрений).