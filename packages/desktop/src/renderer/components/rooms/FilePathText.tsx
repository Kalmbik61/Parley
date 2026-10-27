/**
 * Путь к файлу в тексте чата, комнаты и почты — ссылка по ⌘ (macOS) или Ctrl (Windows, Linux), как ⌘-клик в
 * терминале (`terminal/TerminalSurface.tsx`). Кандидатов в тексте находит `remarkFilePaths` (`room-remark.ts`) регуляркой
 * терминала, а ссылкой кандидат становится, только пока модификатор зажат и только если main нашёл путь в корне работы
 * (`files.locate` через кэш `createStatCache`, как в `terminal/links.ts`): произвольный путь с диска окно не откроет.
 * Без модификатора — обычный текст. Клик с модификатором: файл — вкладка редактора на строке и колонке, каталог —
 * приложение по умолчанию (`terminal/LinkMenu.tsx`).
 *
 * Работу и папку для относительных путей даёт `FilePathLinksContext`: его ставят вид «Chat» (папка сессии), комната и
 * почта (папка проекта). Нет контекста — путь всегда текст.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { Located } from '../../../shared/files-types.js';
import { isFileLink, openLinkInEditor, openLinkPath } from '../../terminal/LinkMenu.js';
import {
  createStatCache,
  resolveCandidatePath,
  type StatCache,
  type TerminalLink,
} from '../../terminal/links.js';

export interface FilePathLinks {
  bridge: ParleyBridge;
  /** Работа, в корнях которой ищется путь. */
  workKey: string;
  /** Папка для относительных путей. */
  cwd: string;
}

export const FilePathLinksContext = createContext<FilePathLinks | null>(null);

const MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

/** Модификатор ссылки в событии: ⌘ на macOS, Ctrl на прочих. */
export function hasLinkModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return MAC ? event.metaKey : event.ctrlKey;
}

// Зажат ли модификатор — одно состояние на окно: слушатели `window` ставятся с первым подписчиком.
let held = false;
const listeners = new Set<() => void>();

function setHeld(next: boolean): void {
  if (held === next) return;
  held = next;
  for (const listener of listeners) listener();
}

const onKey = (event: KeyboardEvent): void => setHeld(hasLinkModifier(event));
// ⌘-Tab в другое приложение: отпускание клавиши окно уже не увидит.
const onBlur = (): void => setHeld(false);

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('blur', onBlur);
    held = false;
  };
}

export function useLinkModifierHeld(): boolean {
  return useSyncExternalStore(subscribe, () => held);
}

/** Кэш `files.locate` на мост: тот же, что у ссылок терминала (500 записей, 10 с). */
const caches = new WeakMap<ParleyBridge, StatCache>();

function statCache(bridge: ParleyBridge): StatCache {
  let cache = caches.get(bridge);
  if (cache === undefined) {
    cache = createStatCache((workKey, absPaths) => bridge.files.locate(workKey, absPaths));
    caches.set(bridge, cache);
  }
  return cache;
}

export interface FilePathTextProps {
  /** Путь как написан, без хвоста `:строка:колонка`. */
  path: string;
  line?: number;
  col?: number;
  children: ReactNode;
}

export function FilePathText({ path, line, col, children }: FilePathTextProps): JSX.Element {
  const env = useContext(FilePathLinksContext);
  const active = useLinkModifierHeld();
  const bridge = env?.bridge ?? null;
  const workKey = env?.workKey ?? null;
  const absPath =
    env === null ? null : resolveCandidatePath({ start: 0, end: 0, kind: 'path', path }, env.cwd);
  // Ответ main — с ключом запроса: смена работы или папки не оставит ссылку на чужой файл.
  const [found, setFound] = useState<{ key: string; located: Located } | null>(null);
  const key = `${workKey ?? ''}\n${absPath ?? ''}`;

  useEffect(() => {
    if (!active || bridge === null || workKey === null || absPath === null) return undefined;
    let live = true;
    statCache(bridge)
      .lookup(workKey, [absPath])
      .then(
        ([hit]) => {
          // Страховка, как в терминале: корень чужой работы — не ссылка.
          if (live && hit !== null && hit !== undefined && hit.root.workKey === workKey)
            setFound({ key, located: hit });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [active, bridge, workKey, absPath, key]);

  const link: Extract<TerminalLink, { kind: 'path' }> | null =
    active && absPath !== null && found !== null && found.key === key
      ? {
          kind: 'path',
          absPath,
          located: found.located,
          ...(line === undefined ? {} : { line }),
          ...(col === undefined ? {} : { col }),
        }
      : null;

  if (link === null || bridge === null) return <span>{children}</span>;
  return (
    <span
      data-file-link=""
      title={link.absPath}
      onClick={(event) => {
        if (!hasLinkModifier(event)) return;
        event.preventDefault();
        if (isFileLink(link)) openLinkInEditor(link);
        else void openLinkPath(bridge, link.absPath);
      }}
      className="cursor-pointer underline"
    >
      {children}
    </span>
  );
}
