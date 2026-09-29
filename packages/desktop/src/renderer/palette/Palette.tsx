/**
 * Палитра ⌘J (кусок 6.2, спека 9.3–9.4): одна палитра на вкладки, работы, сессии, комнаты и
 * действия — вместо прежних ⌘K и выбора сессии для ⌘D. Вид — `ui/command` на cmdk со своим
 * ранжированием (`shouldFilter={false}`, список из `rankDocuments`).
 *
 * Содержимое монтируется только пока палитра открыта: подписки на работы, активность,
 * раскладки, историю и секции живут в нём, а оболочка (`AppShell`) на историю и поток
 * активности не подписана (решение по куску 3.3).
 *
 * Облик Organic (спека окна 2026-09-29, 1.9): затемнение `neutral-900` 45 % (в тёмной — `--scrim`) с blur 2px; панель
 * 720px, радиус 28, фон `neutral-100`, `shadow-lg`; поле — пилюля 48px на фоне окна; секции — 11px капсом
 * (без запроса вкладки — «Open tabs»); пункт — радиус 16, отступ `9 12`, ⌘1…⌘9 пилюлей; подвал на `bg`.
 *
 * Выбор (Enter, ⌘Enter, ⌘1–9, клик) сначала закрывает палитру, потом зовёт `run` документа:
 * действие может открыть палитру снова (разделение), и закрытие после него закрыло бы её. Enter
 * гасит сам cmdk, ⌘Enter — своё поле, ⌘1–9 — обработчик окна: `run` переводит фокус в
 * терминал, и непогашенный Enter достался бы агенту (спека 15.1).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command as CommandPrimitive } from 'cmdk';
import { toast } from 'sonner';
import { Command as CommandIcon, File as FileIcon, Folder, GitCompare, Globe, Hash, Mail, Plus, Search, SquareTerminal } from 'lucide-react';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { FileList, FileRoot } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { ACTIONS, type ActionId } from '../../shared/keybindings.js';
import { errorText, S } from '../../shared/strings.js';
import { rootKey as rootKeyOf } from '../../shared/work-keys.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { fileDocuments } from '../files/quick-open.js';
import { filesRootSpec, useFilesStore } from '../files/store.js';
import { openFile } from '../files/Tree.js';
import { isActionAvailable } from '../keys/handler.js';
import { ensureHydrated } from '../layout/persistence.js';
import { focusedSessionOf, useLayoutStore } from '../layout/store.js';
import { hostMethods } from '../lib/capabilities.js';
import { cn } from '../lib/cn.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { visibleWorkOrder } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from '../ui/command.js';
import { buildDocuments, filesQuery, rankDocuments, type PaletteDoc, type PaletteIcon, type PaletteSection } from './documents.js';
import { registerRowPicker, usePaletteStore } from './store.js';

export interface PaletteProps {
  bridge: HarnasBridge;
  run(id: ActionId): void;
}

/** Строк с подсказкой ⌘1…⌘9 — первые девять видимых. */
const NUMBERED_ROWS = 9;
const CREATE_VALUE = 'create-workspace';
const MORE_PREFIX = 'more:';

const ICONS: Record<Exclude<PaletteIcon, 'terminal'>, typeof Folder> = {
  mail: Mail,
  room: Hash,
  diff: GitCompare,
  file: FileIcon,
  browser: Globe,
  work: Folder,
  action: CommandIcon,
};

function RowIcon({ doc }: { doc: PaletteDoc }): JSX.Element {
  if (doc.state !== undefined) return <AgentStateDot state={doc.state} />;
  const Icon = doc.icon === 'terminal' ? SquareTerminal : ICONS[doc.icon];
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

// Выделенная строка (спека 9.3): токены `--palette-selected*` (кусок 6.3, раунд main-r2) — в
// светлой теме светлая заливка как у сайдбара и край 1px ≥ 3:1 к фону палитры (заливка сама
// почти не отличается от фона), в тёмной — прежний `--accent`, край того же цвета.
// Вторичный текст и значки строки (`text-muted-foreground`) на выделении берут свой тон.
const ROW_CLASS = cn(
  'min-w-0 gap-3 rounded-md px-3 py-[9px]',
  'data-[selected=true]:bg-palette-selected data-[selected=true]:text-palette-selected-foreground',
  'data-[selected=true]:ring-1 data-[selected=true]:ring-inset data-[selected=true]:ring-palette-selected-edge',
  '[&[data-selected=true]_.text-muted-foreground]:text-palette-selected-muted',
);

interface BodyProps extends PaletteProps {
  onPick(): void;
}

/** Секция (1.9): заголовок 11px капсом с отступом `10 12 4 12`, пункты колонкой с зазором 2. */
const GROUP_CLASS = cn(
  'p-0 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5',
  '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.06em]',
  '[&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-0.5',
);

/** Подсказка ⌘1…⌘9 — пилюля 10px на `neutral-200`, текст `neutral-800`; без прозрачности `CommandShortcut`. */
const SHORTCUT_CLASS = 'shrink-0 rounded-full bg-neutral-200 px-[7px] py-0.5 tracking-normal text-neutral-800 opacity-100';

/** Строка-пояснение палитры: не выбирается, ⌘1–9 её не считают. */
const NOTE_CLASS = 'px-3 py-1.5 text-[12px] text-muted-foreground';

/**
 * Список файлов для ⌘P и запроса с `/` (кусок 7.4, спека 10.2): корень — корень «Файлов» активной
 * работы (`filesRootSpec`, 7.2). `lsFiles` зовётся раз на корень за открытие палитры, когда файлы
 * впервые понадобились: обычный запрос без `/` main не трогает. `docs: null` — ответа ещё нет.
 */
function useQuickOpenFiles(
  bridge: HarnasBridge,
  wanted: boolean,
  activeWorkKey: string | null,
): { docs: PaletteDoc[] | null; list: FileList | null } {
  const works = useWorksStore((state) => state.entries);
  const rootByWork = useFilesStore((state) => state.rootByWork);
  const focused = useLayoutStore((state) => (activeWorkKey === null ? null : focusedSessionOf(state, activeWorkKey)));
  const entry = activeWorkKey === null ? undefined : works.find((item) => workKeyOf(item.projectPath, item.map.work.id) === activeWorkKey);
  const spec = entry === undefined ? null : filesRootSpec(rootByWork, entry, focused);
  const specKey = spec === null ? null : spec.kind === 'project' ? 'project' : spec.sessionId;
  // Одна ссылка на корень, пока тот же ключ: от неё зависят запрос и документы.
  const root = useMemo<FileRoot | null>(
    () => (activeWorkKey === null || spec === null ? null : { workKey: activeWorkKey, spec }),
    [activeWorkKey, specKey],
  );
  const key = root === null ? null : rootKeyOf(root);
  const [loaded, setLoaded] = useState<{ key: string; list: FileList } | null>(null);
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (!wanted || root === null || key === null || requested.current === key) return;
    requested.current = key;
    // Ответ пишется со своим ключом: ответ прежнего корня показан не будет — его ключ не совпадёт.
    bridge.files
      .lsFiles(root)
      .then((list) => setLoaded({ key, list }))
      .catch((error: unknown) => {
        console.warn('[harnas] files.lsFiles', error);
        const { code } = decodeIpcError(error);
        toast(code === 'files:denied' ? S.files.denied : errorText(code, S.errors.actions.readFolder));
        setLoaded({ key, list: { paths: [], truncated: false } });
      });
  }, [bridge, wanted, root, key]);

  const list = loaded !== null && loaded.key === key ? loaded.list : null;
  const docs = useMemo(() => {
    if (root === null) return [];
    if (list === null) return null;
    return fileDocuments(root, list.paths, (path, split) => openFile(root, path, split));
  }, [root, list]);
  return { docs, list };
}

/** Содержимое открытой палитры: подписки и документы живут, только пока она открыта. */
function PaletteBody({ bridge, run, onPick }: BodyProps): JSX.Element {
  const mode = usePaletteStore((state) => state.mode);
  const query = usePaletteStore((state) => state.query);
  const works = useWorksStore((state) => state.entries);
  const branches = useWorksStore((state) => state.branches);
  const activity = useActivityStore((state) => state.byRef);
  const layouts = useLayoutStore((state) => state.layouts);
  const history = useLayoutStore((state) => state.history);
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  const sections = useSidebarSectionsStore((state) => state.sections);
  const attention = useSidebarSectionsStore((state) => state.attention);
  const wakePaused = useUiStore((state) => state.wakePaused);
  const hostStatus = useHostStore((state) => state.status);
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<PaletteSection>>(new Set());
  const [value, setValue] = useState('');

  // Вкладки работ, ещё не показанных за запуск: их раскладок нет в `layouts`, пока не прочитаны.
  useEffect(() => {
    const live = useWorksStore.getState().entries.filter((entry) => entry.map.work.status !== 'archived');
    void ensureHydrated({ bridge, works: live });
  }, [bridge]);

  // Имя агента — поле поиска сессий; без ответа хоста ищется по id провайдера.
  useEffect(() => {
    let stale = false;
    bridge
      .call('providers.list', {})
      .then((result) => {
        if (!stale) setProviders(result.providers.map((provider) => ({ id: provider.id, label: provider.label })));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [bridge]);

  // Раскрытые «ещё N» — до следующего запроса.
  useEffect(() => setExpanded(new Set()), [query]);

  // ⌘P и префикс `/` (спека 9.1): только секция файлов, запрос — без `/`.
  const fileQuery = filesQuery(mode, query);
  const files = useQuickOpenFiles(bridge, fileQuery !== null, activeWorkKey);

  const docs = useMemo(() => {
    const methods = hostMethods(hostStatus);
    return buildDocuments({
      works,
      activity,
      attention,
      branches,
      order: visibleWorkOrder(sections),
      layouts,
      history: history.entries,
      actions: ACTIONS,
      available: (id) => isActionAvailable(id, methods),
      wakePaused,
      providers,
      mode: fileQuery === null ? mode : 'files',
      activeWorkKey,
      files: files.docs,
      run,
    });
  }, [works, activity, attention, branches, sections, layouts, history, hostStatus, wakePaused, providers, mode, activeWorkKey, run, fileQuery === null, files.docs]);

  const rankQuery = fileQuery ?? query;
  const ranked = useMemo(() => rankDocuments(rankQuery, docs, Date.now(), expanded), [rankQuery, docs, expanded]);
  const rows = ranked.flatMap((section) => section.docs);
  const byId = new Map(rows.map((doc) => [doc.id, doc]));
  const trimmed = query.trim();

  const pick = (doc: PaletteDoc, runMode: 'default' | 'split'): void => {
    onPick();
    usePaletteStore.getState().close();
    doc.run(runMode);
  };

  // ⌘1–9 из обработчика окна: номер — среди видимых строк документов.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    registerRowPicker((index) => {
      const doc = rowsRef.current[index];
      if (doc !== undefined) pickRef.current(doc, 'default');
    });
    return () => registerRowPicker(null);
  }, []);

  const createWorkspace = (): void => {
    onPick();
    usePaletteStore.getState().close();
    // Палитра работу не создаёт: форма с названием, создаёт человек (спека 9.4, 15.1).
    useUiStore.getState().openNewWorkDialog(null, trimmed);
  };

  let rowNumber = 0;

  return (
    <Command shouldFilter={false} loop value={value} onValueChange={setValue} className="rounded-none bg-transparent">
      {mode === 'splitRight' || mode === 'splitDown' ? (
        <div className="px-4 pt-3 text-xs font-medium text-muted-foreground">{S.palette.splitTitle}</div>
      ) : null}
      <div className="px-3.5 pb-1.5 pt-3.5">
        <div className="flex h-12 items-center gap-2.5 rounded-full bg-background px-[18px]">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <CommandPrimitive.Input
            value={query}
            onValueChange={(next) => usePaletteStore.getState().setQuery(next)}
            placeholder={mode === 'files' ? S.actions.goToFile : S.palette.placeholder}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            onKeyDown={(event) => {
              // cmdk 1.1.1 разбирает Enter в корне без модификаторов: ⌘Enter ушёл бы в обычный выбор.
              if (event.key !== 'Enter' || !event.metaKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const doc = byId.get(value);
              if (doc !== undefined) pick(doc, 'split');
            }}
          />
        </div>
      </div>
      <CommandList className="max-h-[min(60vh,480px)] px-2.5 pb-2.5 pt-1">
        {fileQuery === null && trimmed !== '' && ranked.length === 0 ? (
          <CommandItem value={CREATE_VALUE} onSelect={createWorkspace} className={ROW_CLASS}>
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={S.palette.createWorkspace(trimmed)}>
              {S.palette.createWorkspace(trimmed)}
            </span>
          </CommandItem>
        ) : null}
        {ranked.map((section) => (
          <CommandGroup
            key={section.section}
            heading={section.section === 'tabs' && trimmed === '' && fileQuery === null ? S.palette.openTabs : S.palette.sections[section.section]}
            className={GROUP_CLASS}
          >
            {section.docs.map((doc) => {
              const number = rowNumber < NUMBERED_ROWS ? rowNumber + 1 : null;
              rowNumber += 1;
              return (
                <CommandItem key={doc.id} value={doc.id} onSelect={() => pick(doc, 'default')} className={ROW_CLASS}>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <RowIcon doc={doc} />
                  </span>
                  {/* Обрезанное многоточием — целиком в тултипе, как у строк боковой панели. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14px] font-semibold" title={doc.title}>
                      {doc.title}
                    </span>
                    {doc.subtitle === '' ? null : (
                      <span className="truncate text-[12px] text-muted-foreground" title={doc.subtitle}>
                        {doc.subtitle}
                      </span>
                    )}
                  </span>
                  {number === null ? null : <CommandShortcut className={SHORTCUT_CLASS}>⌘{number}</CommandShortcut>}
                </CommandItem>
              );
            })}
            {/* Секция файлов не раскрывается: 50 000 путей встали бы в cmdk (спека 10.2). */}
            {section.more > 0 && section.section === 'files' ? <div className={NOTE_CLASS}>{S.files.refineQuery}</div> : null}
            {section.more > 0 && section.section !== 'files' ? (
              <CommandItem
                value={`${MORE_PREFIX}${section.section}`}
                onSelect={() => setExpanded((current) => new Set([...current, section.section]))}
                className={cn(ROW_CLASS, 'py-1.5 text-[12px] text-muted-foreground')}
              >
                {S.palette.more(section.more)}
              </CommandItem>
            ) : null}
          </CommandGroup>
        ))}
        {fileQuery !== null && files.docs === null ? <div className={NOTE_CLASS}>{S.files.loadingFiles}</div> : null}
        {fileQuery !== null && files.docs !== null && ranked.length === 0 ? <div className={NOTE_CLASS}>{S.files.noFiles}</div> : null}
        {/* Обход не-git корня упёрся в предел или время (спека 10.7): файла за пределом в списке нет. */}
        {fileQuery !== null && files.list?.truncated === true ? (
          <div className={NOTE_CLASS}>{S.files.filesTruncated(files.list.paths.length)}</div>
        ) : null}
      </CommandList>
      <div className="flex gap-[18px] bg-(--color-bg) px-6 py-2.5 text-[11px] text-muted-foreground">
        {S.palette.footerHints.map((hint) => (
          <span key={hint}>{hint}</span>
        ))}
      </div>
    </Command>
  );
}

export function Palette({ bridge, run }: PaletteProps): JSX.Element {
  const open = usePaletteStore((state) => state.open);
  /** Где был фокус до открытия: кнопка Search, терминал… */
  const opener = useRef<HTMLElement | null>(null);
  /** Строку выбрали: фокус ведёт действие (терминал, диалог), назад его не возвращаем. */
  const picked = useRef(false);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) usePaletteStore.getState().close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--color-neutral-900)_45%,transparent)] backdrop-blur-[2px] dark:bg-scrim" />
        <DialogPrimitive.Content
          data-palette
          aria-describedby={undefined}
          className="fixed left-1/2 top-[min(10%,4rem)] z-50 flex w-[720px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg"
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            picked.current = false;
          }}
          // Radix возвращает фокус только своему `Dialog.Trigger`, а его у палитры нет: без выбора —
          // туда, откуда открыли; после выбора фокус уже у действия.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const back = opener.current;
            opener.current = null;
            if (picked.current || back === null || !back.isConnected) return;
            back.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">{S.actions.commandPalette}</DialogPrimitive.Title>
          <PaletteBody
            bridge={bridge}
            run={run}
            onPick={() => {
              picked.current = true;
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
