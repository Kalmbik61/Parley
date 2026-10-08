/**
 * Вид Console панели вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3).
 * - Шапка: уровни и фильтр по тексту.
 * - Строка: значок уровня, текст моноширинным, `×N` повторов, источник `файл:строка`; у ошибки со стеком — раскрытие.
 *   Объекты приходят из main кратким предпросмотром CDP — текстом.
 * - По наведению — «Copy»; «Add to chat» — слот этапа B (`onAddToChat`): без колбэка кнопки нет.
 * - С «Preserve log» между страницами — разделитель «Navigated to …».
 * - Новые записи прокручивают список, пока человек не ушёл выше.
 */
import { ChevronDown, ChevronRight, CircleX, Copy, Info, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleEntry, ConsoleLevel } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { FilterInput, FilterToggle, PanelIconButton } from './controls.js';
import { consoleCopyText, frameText, sourceLabel } from './format.js';
import { documentUrl, EMPTY_DEVTOOLS, useDevtoolsStore, visibleConsole } from './store.js';

const LEVELS: readonly ConsoleLevel[] = ['error', 'warning', 'info', 'debug'];
/** Ближе этого к низу список прижат: новые записи его прокручивают. */
const STICK_PX = 16;

const ROW_TONE: Readonly<Record<ConsoleLevel, string>> = {
  error: 'bg-destructive/5 text-destructive',
  warning: 'bg-status-warning-background text-status-warning-text',
  info: 'text-foreground',
  debug: 'text-muted-foreground',
};

function LevelIcon({ level }: { level: ConsoleLevel }): JSX.Element {
  if (level === 'error') return <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden="true" />;
  if (level === 'warning') return <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />;
  if (level === 'info') return <Info className="mt-0.5 size-3 shrink-0 opacity-40" aria-hidden="true" />;
  return <span className="w-3 shrink-0" aria-hidden="true" />;
}

function ConsoleRow({ entry, onAddToChat }: { entry: ConsoleEntry; onAddToChat: ((entry: ConsoleEntry) => void) | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [first = '', ...rest] = entry.text.split('\n');
  // Раскрытие: остальные строки сообщения любого уровня, а у ошибки со стеком (спека 4.3) без них — кадры стека.
  const expandable = rest.length > 0 || (entry.level === 'error' && entry.stack.length > 1);
  const copy = (): void => {
    navigator.clipboard.writeText(consoleCopyText(entry)).catch((error: unknown) => console.warn('[parley] clipboard', error));
  };
  return (
    <div
      data-console-row={entry.id}
      data-level={entry.level}
      className={cn('group relative flex items-start gap-1.5 border-b border-border/60 px-2 py-0.5', ROW_TONE[entry.level])}
    >
      {expandable ? (
        <button
          type="button"
          aria-label={open ? S.browser.devtools.collapse : S.browser.devtools.expand}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-0.5 shrink-0 rounded hover:bg-accent"
        >
          {open ? <ChevronDown className="size-3" aria-hidden="true" /> : <ChevronRight className="size-3" aria-hidden="true" />}
        </button>
      ) : (
        <span className="w-3 shrink-0" aria-hidden="true" />
      )}
      <LevelIcon level={entry.level} />
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words">{first}</div>
        {open ? (
          <pre data-testid="console-stack" className="whitespace-pre-wrap break-words opacity-80">
            {rest.length > 0 ? rest.join('\n') : entry.stack.map(frameText).join('\n')}
          </pre>
        ) : null}
      </div>
      {entry.count > 1 ? (
        <span data-testid="console-count" className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
          {S.browser.devtools.repeated(entry.count)}
        </span>
      ) : null}
      {entry.location === null ? null : (
        <span className="max-w-[40%] shrink-0 truncate text-muted-foreground" title={entry.location.url}>
          {sourceLabel(entry.location)}
        </span>
      )}
      <div className="absolute right-1 top-0 hidden items-center gap-1 rounded bg-card px-1 shadow-sm group-focus-within:flex group-hover:flex">
        {onAddToChat === undefined ? null : (
          <button type="button" onClick={() => onAddToChat(entry)} className="h-5 shrink-0 rounded px-1.5 text-[11px] text-foreground hover:bg-accent">
            {S.browser.devtools.addToChat}
          </button>
        )}
        <PanelIconButton label={S.common.copy} onClick={copy}>
          <Copy className="size-3" aria-hidden="true" />
        </PanelIconButton>
      </div>
    </div>
  );
}

export interface ConsoleViewProps {
  tabId: string;
  /** «Add to chat» строки — этап B (спека 4.3, 4.5); нет колбэка — нет кнопки. */
  onAddToChat?: ((entry: ConsoleEntry) => void) | undefined;
}

type ConsoleItem = { kind: 'entry'; entry: ConsoleEntry } | { kind: 'nav'; epoch: number; url: string | null };

export function ConsoleView({ tabId, onAddToChat }: ConsoleViewProps): JSX.Element {
  const tab = useDevtoolsStore((state) => state.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const patch = useDevtoolsStore.getState().patch;
  const items = useMemo((): ConsoleItem[] => {
    const result: ConsoleItem[] = [];
    let epoch: number | null = null;
    for (const entry of visibleConsole(tab)) {
      // Прежние страницы видны только с «Preserve log»: между ними — разделитель (спека 4.3).
      if (epoch !== null && entry.epoch !== epoch) result.push({ kind: 'nav', epoch: entry.epoch, url: documentUrl(tab, entry.epoch) });
      epoch = entry.epoch;
      result.push({ kind: 'entry', entry });
    }
    return result;
  }, [tab]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node !== null && stick.current) node.scrollTop = node.scrollHeight;
  }, [items]);

  return (
    <div data-testid="console-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-1.5 py-1">
        {LEVELS.map((level) => (
          <FilterToggle
            key={level}
            pressed={tab.levels[level]}
            onClick={() => patch(tabId, { levels: { ...tab.levels, [level]: !tab.levels[level] } })}
          >
            {S.browser.devtools.levels[level]}
          </FilterToggle>
        ))}
        <FilterInput label={S.browser.devtools.filterConsole} value={tab.consoleText} onChange={(value) => patch(tabId, { consoleText: value })} />
      </div>
      <div
        ref={scrollRef}
        role="log"
        onScroll={() => {
          const node = scrollRef.current;
          if (node !== null) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-4"
      >
        {items.length === 0 ? (
          <div className="p-2 text-muted-foreground">{S.browser.devtools.empty}</div>
        ) : (
          items.map((item) =>
            item.kind === 'nav' ? (
              <div key={`nav-${item.epoch}`} data-console-nav className="border-b border-border bg-muted/50 px-2 py-0.5 text-muted-foreground [overflow-wrap:anywhere]">
                {item.url === null ? S.browser.devtools.navigated : S.browser.devtools.navigatedTo(item.url)}
              </div>
            ) : (
              <ConsoleRow key={item.entry.id} entry={item.entry} onAddToChat={onAddToChat} />
            ),
          )
        )}
      </div>
    </div>
  );
}
