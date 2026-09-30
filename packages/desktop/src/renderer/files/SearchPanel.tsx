/**
 * Поиск в файлах ⌘⇧F (кусок 7.4, спека 10.3): режим вкладки «Файлы» — поле, «Aa», «Слово»,
 * «.*» и результаты, сгруппированные по файлам.
 *
 * Поиск не держит окно: запрос уходит через 250 мс тишины, новый ввод сразу отменяет идущий
 * (`files.cancel`), а ответ отменённого не показывается. Отменённый поиск main отвечает
 * найденным к этому моменту с `truncated` — сверка по своему `signalId`, а не по времени ответа.
 *
 * Регулярки git и JS различаются: у найденной git строки `ranges` может быть пустым — строка
 * показывается без подсветки. Git без PCRE ищет регулярку как POSIX ERE — тогда над результатами
 * подсказка «POSIX regex» (раунд fix-7.4, п. 3).
 */

import { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, Regex, WholeWord } from 'lucide-react';
import { toast } from 'sonner';
import type { HarnasBridge } from '../../shared/bridge.js';
import type { FileRoot, GrepHit, GrepResult } from '../../shared/files-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { tabId } from '../layout/ids.js';
import { cn } from '../lib/cn.js';
import { useFilesStore } from './store.js';
import { openFile } from './Tree.js';

/** Запрос — через 250 мс тишины (план). */
export const SEARCH_DEBOUNCE_MS = 250;
/**
 * «Searching…» — только если ответа нет дольше 300 мс после запроса (раунд fix-7.4, п. 5):
 * обычный ответ git grep приходит раньше, и признак на нём мигал бы.
 */
export const SEARCHING_DELAY_MS = 300;
/** Запрос — до 1000 символов: длиннее main отвечает `bad_request` (план). */
const MAX_QUERY = 1000;
/** Совпадение дальше от начала — строка показывается с него, иначе в узкой панели его не видно. */
const LEAD_CONTEXT = 30;

/** Уникален на окно: панель, смонтированная заново, не повторит id поиска, который ещё идёт. */
let searchSeq = 0;

function toggleClass(on: boolean): string {
  return cn(
    'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground',
    on && 'bg-accent text-accent-foreground',
  );
}

/** Текст строки с подсвеченными `ranges`; далёкое совпадение — с «…» и частью контекста перед ним. */
function HitText({ hit }: { hit: GrepHit }): JSX.Element {
  const first = hit.ranges[0];
  const shift = first !== undefined && first[0] > LEAD_CONTEXT * 2 ? first[0] - LEAD_CONTEXT : 0;
  const text = hit.text.slice(shift);
  const parts: JSX.Element[] = [];
  let at = 0;
  for (const [from, to] of hit.ranges) {
    const a = Math.max(from - shift, at);
    const b = to - shift;
    if (b <= a) continue;
    if (a > at) parts.push(<span key={`t${at}`}>{text.slice(at, a)}</span>);
    parts.push(
      <mark key={`m${a}`} className="rounded-sm bg-yellow-300/60 text-inherit dark:bg-yellow-500/40">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return (
    <>
      {shift > 0 ? '…' : null}
      {parts}
    </>
  );
}

function hitCount(result: GrepResult): number {
  return result.files.reduce((sum, file) => sum + file.hits.length, 0);
}

export interface SearchPanelProps {
  bridge: HarnasBridge;
  root: FileRoot;
}

export function SearchPanel({ bridge, root }: SearchPanelProps): JSX.Element {
  const [text, setText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<GrepResult | null>(null);
  const [invalid, setInvalid] = useState(false);
  /** Последний ответ на регулярку — POSIX ERE (git без PCRE, раунд fix-7.4, п. 3). */
  const [posix, setPosix] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const focusSearch = useFilesStore((state) => state.focusSearch === root.workKey);
  const input = useRef<HTMLInputElement>(null);
  /** `signalId` идущего поиска; ответ чужого id — отменённого — отбрасывается. */
  const running = useRef<string | null>(null);
  const rootRef = useRef(root);
  rootRef.current = root;

  // ⌘⇧F: фокус в поле, в том числе когда панель смонтировало то же действие.
  useEffect(() => {
    if (!focusSearch) return;
    input.current?.focus();
    input.current?.select();
    useFilesStore.setState({ focusSearch: null });
  }, [focusSearch]);

  const stopSearching = (): void => {
    if (searchingTimer.current !== null) clearTimeout(searchingTimer.current);
    searchingTimer.current = null;
    setSearching(false);
  };

  const cancelRunning = (): void => {
    stopSearching();
    const id = running.current;
    if (id === null) return;
    running.current = null;
    void bridge.files.cancel(id).catch((error: unknown) => console.warn('[harnas] files.cancel', error));
  };

  useEffect(() => {
    // Новый ввод отменяет идущий поиск сразу, а не через 250 мс: git и воркер main не работают впустую.
    cancelRunning();
    if (text === '') {
      setResult(null);
      setInvalid(false);
      // Подсказка «POSIX regex» — о последнем ответе; ответа на пустое поле нет (fix-lane-post, п. 5).
      setPosix(false);
      return undefined;
    }
    const query = { text, caseSensitive, wholeWord, regex };
    const timer = setTimeout(() => {
      searchSeq += 1;
      const id = `files-search-${searchSeq}`;
      running.current = id;
      searchingTimer.current = setTimeout(() => {
        searchingTimer.current = null;
        if (running.current === id) setSearching(true);
      }, SEARCHING_DELAY_MS);
      bridge.files
        .grep(rootRef.current, query, id)
        .then((next) => {
          if (running.current !== id) return;
          running.current = null;
          stopSearching();
          setResult(next);
          setInvalid(false);
          setPosix(next.posixRegex === true);
          setCollapsed(new Set());
        })
        .catch((error: unknown) => {
          if (running.current !== id) return;
          running.current = null;
          stopSearching();
          // Отказ — тоже ответ, и диалекта в нём нет: прежняя подсказка «POSIX regex» к нему не относится.
          setPosix(false);
          const { code } = decodeIpcError(error);
          // Неверная регулярка — в панели, а не тостом: человек её ещё печатает. Это ожидаемый
          // ввод, а не сбой — и в консоль не идёт (раунд fix-7.4, п. 4).
          if (code === 'bad_request' && query.regex) {
            setResult(null);
            setInvalid(true);
            return;
          }
          console.warn('[harnas] files.grep', error);
          toast(code === 'files:denied' ? S.files.denied : errorText(code, S.errors.actions.searchFiles));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Корень — тот же, пока жива панель: `FilesPanel` монтирует её заново на смену корня.
  }, [bridge, text, caseSensitive, wholeWord, regex]);

  // Панель ушла (сайдбар закрыт, режим дерева) — идущий поиск больше никому не нужен.
  useEffect(() => () => cancelRunning(), []);

  const toggleGroup = (path: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openHit = (path: string, hit: GrepHit, beside: boolean): void => {
    const current = rootRef.current;
    openFile(current, path, beside);
    // Колонка — из ответа main (раунд fix-7.4, п. 2): `text` лишь окно строки.
    useFilesStore.getState().revealAt(current.workKey, tabId.file(current.spec, path), hit.line, hit.column);
  };

  return (
    <div data-testid="files-search" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-1 py-1.5">
        <input
          ref={input}
          value={text}
          maxLength={MAX_QUERY}
          onChange={(event) => setText(event.target.value)}
          placeholder={S.files.searchPlaceholder}
          aria-label={S.files.searchPlaceholder}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          className={cn(
            'h-6 min-w-0 flex-1 rounded border bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground',
            invalid ? 'border-red-500' : 'border-border focus:border-ring',
          )}
        />
        <button type="button" aria-label={S.terminal.matchCase} title={S.terminal.matchCase} aria-pressed={caseSensitive} className={toggleClass(caseSensitive)} onClick={() => setCaseSensitive((v) => !v)}>
          <CaseSensitive className="size-4" />
        </button>
        <button type="button" aria-label={S.files.matchWholeWord} title={S.files.matchWholeWord} aria-pressed={wholeWord} className={toggleClass(wholeWord)} onClick={() => setWholeWord((v) => !v)}>
          <WholeWord className="size-4" />
        </button>
        <button type="button" aria-label={S.terminal.useRegex} title={S.terminal.useRegex} aria-pressed={regex} className={toggleClass(regex)} onClick={() => setRegex((v) => !v)}>
          <Regex className="size-4" />
        </button>
      </div>
      {regex && posix ? (
        <div title={S.files.posixRegexHint} className="shrink-0 truncate border-b border-border px-3 py-1 text-xs text-muted-foreground">
          {S.files.posixRegex}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 text-xs">
        {searching ? <div className="px-3 py-1.5 text-muted-foreground">{S.files.searching}</div> : null}
        {invalid ? <div className="px-3 py-1.5 text-red-500">{S.files.invalidRegex}</div> : null}
        {/* «No results» прежнего запроса рядом с «Searching…» противоречил бы ему. */}
        {!searching && result !== null && result.files.length === 0 ? <div className="px-3 py-1.5 text-muted-foreground">{S.files.noResults}</div> : null}
        {result?.files.map((file) => {
          const open = !collapsed.has(file.path);
          return (
            <div key={file.path}>
              <button
                type="button"
                title={file.path}
                aria-expanded={open}
                onClick={() => toggleGroup(file.path)}
                className="flex w-full min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-left hover:bg-foreground/6 hover:[--muted-foreground:var(--foreground)]"
              >
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{file.hits.length}</span>
              </button>
              {open
                ? file.hits.map((hit, index) => (
                    <div
                      key={`${hit.line}:${index}`}
                      role="button"
                      tabIndex={0}
                      title={hit.text}
                      onClick={(event) => openHit(file.path, hit, event.metaKey)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') openHit(file.path, hit, event.metaKey);
                      }}
                      className="flex min-w-0 cursor-default items-baseline gap-2 rounded-full py-0.5 pl-7 pr-2 hover:bg-foreground/6 hover:[--muted-foreground:var(--foreground)]"
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">{hit.line}</span>
                      <span className="min-w-0 flex-1 truncate font-mono">
                        <HitText hit={hit} />
                      </span>
                    </div>
                  ))
                : null}
            </div>
          );
        })}
        {/* Предел 2000/200 или время поиска без git (7.1b): человек должен знать, что показано не всё. */}
        {result?.truncated === true ? (
          <div className="px-3 py-1.5 text-muted-foreground">{S.files.truncated(hitCount(result))}</div>
        ) : null}
      </div>
    </div>
  );
}
