/**
 * Палитра ⌘J (кусок 6.2, спека 9.3–9.4): одна палитра на вкладки, работы, сессии, комнаты и
 * действия — вместо прежних ⌘K и выбора сессии для ⌘D. Вид — `ui/command` на cmdk со своим
 * ранжированием (`shouldFilter={false}`, список из `rankDocuments`).
 *
 * Содержимое монтируется только пока палитра открыта: подписки на работы, активность,
 * раскладки, историю и секции живут в нём, а оболочка (`AppShell`) на историю и поток
 * активности не подписана (решение по куску 3.3).
 *
 * Выбор (Enter, ⌘Enter, ⌘1–9, клик) сначала закрывает палитру, потом зовёт `run` документа:
 * действие может открыть палитру снова (разделение), и закрытие после него закрыло бы её. Enter
 * гасит сам cmdk, ⌘Enter — своё поле, ⌘1–9 — обработчик окна: `run` переводит фокус в
 * терминал, и непогашенный Enter достался бы агенту (спека 15.1).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command as CommandPrimitive } from 'cmdk';
import { Command as CommandIcon, File as FileIcon, Folder, GitCompare, Globe, Hash, Mail, Plus, SquareTerminal } from 'lucide-react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { ACTIONS, type ActionId } from '../../shared/keybindings.js';
import { S } from '../../shared/strings.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { isActionAvailable } from '../keys/handler.js';
import { ensureHydrated } from '../layout/persistence.js';
import { useLayoutStore } from '../layout/store.js';
import { hostMethods } from '../lib/capabilities.js';
import { cn } from '../lib/cn.js';
import { visibleWorkOrder } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from '../ui/command.js';
import { buildDocuments, rankDocuments, type PaletteDoc, type PaletteIcon, type PaletteSection } from './documents.js';
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

// Выделенная строка (спека 9.3): токены `--palette-selected*` (кусок 6.3) — в светлой теме тёмная
// строка, ≥ 3:1 к фону палитры (было 1.33:1, ревью 6.2-B), в тёмной — прежний `--accent`.
// Вторичный текст и значки строки (`text-muted-foreground`) на выделении берут свой светлый тон.
const ROW_CLASS = cn(
  'min-w-0 gap-3 rounded-lg px-3 py-2.5',
  'data-[selected=true]:bg-palette-selected data-[selected=true]:text-palette-selected-foreground',
  '[&[data-selected=true]_.text-muted-foreground]:text-palette-selected-muted',
);

interface BodyProps extends PaletteProps {
  onPick(): void;
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
      mode,
      activeWorkKey,
      run,
    });
  }, [works, activity, attention, branches, sections, layouts, history, hostStatus, wakePaused, providers, mode, activeWorkKey, run]);

  const ranked = useMemo(() => rankDocuments(query, docs, Date.now(), expanded), [query, docs, expanded]);
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
      <div className="p-2">
        <div className="rounded-lg border border-border/55 bg-muted/28">
          <CommandPrimitive.Input
            value={query}
            onValueChange={(next) => usePaletteStore.getState().setQuery(next)}
            placeholder={S.palette.placeholder}
            className="h-12 w-full bg-transparent px-3 text-[14px] outline-none placeholder:text-muted-foreground"
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
      <CommandList className="max-h-[min(60vh,480px)] px-2 pb-2">
        {trimmed !== '' && ranked.length === 0 ? (
          <CommandItem value={CREATE_VALUE} onSelect={createWorkspace} className={ROW_CLASS}>
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={S.palette.createWorkspace(trimmed)}>
              {S.palette.createWorkspace(trimmed)}
            </span>
          </CommandItem>
        ) : null}
        {ranked.map((section) => (
          <CommandGroup key={section.section} heading={S.palette.sections[section.section]}>
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
                  {number === null ? null : <CommandShortcut className="shrink-0">⌘{number}</CommandShortcut>}
                </CommandItem>
              );
            })}
            {section.more > 0 ? (
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
      </CommandList>
      <div className="border-t border-border/55 px-3 py-2 text-[11px] text-muted-foreground">{S.palette.footer}</div>
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          data-palette
          aria-describedby={undefined}
          className="fixed left-1/2 top-[min(10%,4rem)] z-50 flex w-[900px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border/70 bg-background/96 text-foreground shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl"
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
