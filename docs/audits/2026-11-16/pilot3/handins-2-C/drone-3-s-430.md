<!-- drone 3 s-430 model=haiku addedAt=2026-11-16T17:40:46.485Z handedAt=2026-11-16T17:47:26.716Z result=done -->
Q09–Q12, исходник 9eabc014 (/Users/kalmbik61/parley/pilot3-subject). Все cited файлы прочитаны целиком.

Q09 — слияние ветки в базу. Точка входа: mergeWorktree, packages/core/src/work/worktree.ts:1301-1339; вызывает его host packages/host/src/worktrees/worktrees-service.ts:210-223.
Порядок проверок до git merge:
1. assertRevisions(base, branch) — пусто, ведущий «-» или check-ref-format не прошёл → InvalidRevisionError (брошено, не отказ): worktree.ts:1308, 424-432.
2. findBaseCheckout(base): база не выгружена ни в основном каталоге, ни в worktree → {ok:false, reason:'base_not_checked_out'}: worktree.ts:1309-1310, 841-845.
3. pinnedCheckout для базы и (если копия не убрана) для своей копии: подменённый .git → GitStateError 'worktree-corrupt' (брошено): worktree.ts:1314-1315, 691-699. Host переводит в gitFailure: worktrees-service.ts:218.
4. projectPrefix: worktree.ts:1316.
5. isDirty(база) → {ok:false, reason:'base_dirty'}: worktree.ts:1317, 863-873 (каталог состояния исключён через STATE_DIRS).
6. isDirty(своя копия), только если копия не убрана → {ok:false, reason:'uncommitted'}: worktree.ts:1319-1321.
7. git merge --no-ff -m message --end-of-options branch в копии базы: worktree.ts:1323-1325.
Конфликт: любой сбой merge (catch без различения, worktree.ts:1326) → список файлов `diff --diff-filter=U -z` (1330-1332) → `merge --abort` (1333) → {ok:false, reason:'conflict', files} (1334). База остаётся чистой. Замечание: в catch попадает любой ненулевой выход merge, не только конфликт; при пустом списке files пуст; сбой самого abort не перехвачен.
mergeCheck (worktree.ts:1059-1079, merge-tree --write-tree, read-only) в путь merge не входит: host merge (worktrees-service.ts:210-223) вызывает mergeWorktree напрямую; mergeCheck вызывается отдельным методом worktrees-service.ts:253-255.
Типы результата: worktree.ts:1288-1294.

Q10 — фильтры отбора игнорируемых путей. worktree-include.ts (listIncludePaths 85-136, resolveIncludePaths 139-158); worktree-seed.ts (seedWorktree 183-204).
Основная копия (sourceRoot):
- файл .worktreeinclude: обычный файл, не пустой, ≤256 KiB (worktree-include.ts:14-15, 87-89), иначе [].
- git ls-files --others --ignored --directory --exclude-from=<файл> (47-60, 91): пути из списка.
- пересечение с --exclude-standard (93-95) и check-ignore в sourceRoot (98-103, 66-74).
- safeEntry (77-82): не абсолютный, без пустых сегментов и «..», первый сегмент не «.git».
- дедуп и сортировка (105-111); вложенные в уже выбранный каталог отбрасываются (113-125); отсутствующие и симлинки отбрасываются (126-127); потолок INCLUDE_MAX_ENTRIES=1000 (16, 130).
- Любой сбой git → [] (code≠0 → null, 58, 92-94, 133-135).
Новая копия (targetRoot): каталоги подаются с «/» (147-150); check-ignore в targetRoot (152, 66-74) — в список попадают только пути, игнорируемые и в новой копии (154). Код 1 = ничего не игнорируется; иное — сбой → [] (72, 153).
Дополнительно в seedWorktree: realpath источника и копии совпадают → null (201-202); пустой список → null (203-204); не darwin → unavailable (206-207); иначе тот же том и APFS по df/diskutil (99-104, 210-211); для stage — тот же dev (221-225).

Q11 — клон по одному пути, лимиты, пропуски. worktree-seed.ts.
- Пропуск без клонирования и с отчётом: цель уже существует → continue БЕЗ записи в отчёт (253-254). Лимит записей: SEED_MAX_ENTRIES=300_000 (17), deps.maxEntries (191); countEntries (121-135) считает сам путь и всё внутри (каталоги обходятся, симлинки не раскрываются, обход встаёт при превышении лимита); если count > maxEntries−used → skipped reason 'entries' (261-265); used растёт только на клонированные (281). Срок: SEED_TIMEOUT_MS=120_000 (18), deadline=now+timeoutMs (241); до клона и после countEntries проверяется остаток; истёк → expired=true, skipped 'timeout' и все следующие тоже 'timeout' (256-260, 268-272). Таймер setTimeout (remaining ms, unref) вызывает abort и expired (273-277); clonePath получает signal (278); прерванный → throw → skipped 'timeout' (279, 283-284). Иной сбой (в т.ч. 'target appeared' из moveIntoPlace) → skipped 'failed' (283-284, 171-173).
- Отчёт: report.skipped (258, 263, 270, 284) → toWorktreeSeed: первые 5 (309, 316) → describeSeed: «Not cloned: `путь` (too many files | timed out | failed)» (322-338). Счётчик cloned — report.cloned (282).
- Путь к месту: stageRoot = <gitdir копии>/parley-seed (213-218, git rev-parse --absolute-git-dir), на выходе удаляется (293). Stage на каждый путь = stageRoot/<index> (249). defaultClonePath: каталог — mkdir(stage) затем /bin/cp -c -R source/. stage; файл — /bin/cp -c source stage (106-118; cp -c = клон APFS, комментарий 1-8). moveIntoPlace (171-180): mkdir родителя цели, проверка отсутствия цели, каталог — rename(stage, target) (175), файл — link(stage, target) затем rm(stage) (178-179). finally: rm stage (287).
- После цикла: lockMismatchOf (146-157, 297), isStalePnpm (160-165, 302).

Q12 — writable locations для Codex worktree. Условие: launch.ts:504: entry.id==='codex' && !workspace && !role.readOnly && role.sandboxMode==='workspace-write' && session.worktree && шаблон содержит {approvals}. Иначе доп. локаций нет.
Вызов: launch.ts:505-506: roots = prepareWorktreeGitWrites(...); в approvals добавляется -c sandbox_workspace_write.writable_roots=<JSON массив roots>. Ошибка проверки не перехвачена на месте вызова (inferred из 505, поведение выше не проверено).
Проверки prepareWorktreeGitWrites (worktree.ts:630-672) по порядку:
a. branch = parley/<workId>/<sessionId> или legacy harnas/<workId>/<sessionId>, иначе worktree-corrupt (638).
b. assertRevisions(branch) (639).
c. common dir = realpath(git rev-parse --git-common-dir) (640; 593-597).
d. checkoutGitDir(common, cwd) — .git копии — файл gitdir в <common>/worktrees/<имя>, back-ссылка ведёт на эту копию (642; 609-628); gitDir === common → отказ (643).
e. symbolic-ref HEAD в этом gitdir == refs/heads/<branch> (646-648).
f. mkdir по сегментам родителей refs/heads и logs/refs/heads внутри common; каждый сегмент должен быть каталогом (651-661).
g. файлы branchRef, branchRef.lock, branchLog, branchLog.lock, если есть — не каталоги (662-668).
h. <common>/objects — каталог (669-670).
Выдаваемые локации (671): [gitDir копии (<common>/worktrees/<имя>), <common>/objects, <common>/refs/heads/<branch>, <common>/refs/heads/<branch>.lock, <common>/logs/refs/heads/<branch>, <common>/logs/refs/heads/<branch>.lock]. Доступ к objects общий: worktree.ts:10-12 признаёт риск порчи объектов.
Инструкция: exclude_slash_tmp/exclude_tmpdir_env_var относятся только к workspace clone (launch.ts:497-498), не сюда.

Not verified (что не покрыто):
- Q09: откуда и когда UI вызывает mergeCheck перед слиянием (packages/desktop, DiffTab.tsx:476-487 — только по ссылке, не читался целиком); не проверено.
- Q10/Q11: host-место вызова seedWorktree (packages/host/src/worktrees/deps-seed.ts:31-87) только по сигнатуре, не читалось целиком; что делает host при skipped (уведомления) — вне слайса.
- Q12: как prepareSessionRole задаёт role.readOnly и role.sandboxMode (launch.ts:320) — вне слайса; поведение launch при броске из prepareWorktreeGitWrites не прослежено; что Codex workspace-write сам разрешает записать (cwd worktree) — не проверено, из кода не выводится.

Coverage: partial — open: Q09 (вызов mergeCheck в UI перед merge), Q10/Q11 (место вызова seed в host и реакция на skipped), Q12 (источник role.readOnly/sandboxMode и поведение при ошибке вне слайса; встроенный default Codex-песочницы).