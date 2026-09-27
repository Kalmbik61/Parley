/**
 * ⌘K (кусок 2.3 плана окна, спека 5.2): свой список поверх Radix Dialog — без
 * компонента комбобокса из отдельного пакета, как в плане куска («без новых
 * зависимостей: Radix Dialog и свой список»). Устроена как `SessionPicker.tsx`
 * из куска 2.1, только со строкой поиска и общими командами, а не только
 * сессиями одной работы. Команды собирает `AppShell.tsx` (`lib/commands.ts`):
 * «открыть» с куска 2.7 идёт в `layout/store.ts` — работа становится активной,
 * вкладка открывается в её раскладке.
 *
 * Esc обрабатывается явно, тем же способом, что и строка поиска терминала
 * (`terminal/TerminalSurface.tsx`) — не полагаемся на то, что `DismissableLayer` Radix
 * сам не вызовет заодно и запуск команды: так поведение видно в одном месте
 * и не зависит от деталей чужой библиотеки.
 */

import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { S } from '../../../shared/strings.js';
import { fuzzyScore } from '../../lib/fuzzy.js';
import type { Command } from '../../lib/commands.js';

export interface CommandPaletteProps {
  open: boolean;
  commands: readonly Command[];
  onOpenChange: (open: boolean) => void;
}

/** Пустой запрос — порядок как в `commands` (там уже недавние сессии первыми, см. `buildCommands`). */
function filterCommands(commands: readonly Command[], query: string): Command[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...commands];

  const scored: Array<{ command: Command; score: number }> = [];
  for (const command of commands) {
    const candidates = [command.title, ...command.keywords];
    let best: number | null = null;
    for (const candidate of candidates) {
      const score = fuzzyScore(trimmed, candidate);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) scored.push({ command, score: best });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.command);
}

export function CommandPalette({ open, commands, onOpenChange }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Заново открыли палитру — прошлый запрос не должен пережить закрытие.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const runAt = (index: number): void => {
    const command = results[index];
    if (command === undefined) return;
    onOpenChange(false);
    void command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-[20%] w-[32rem] -translate-x-1/2 rounded-lg bg-card p-2 text-foreground shadow-lg">
          <Dialog.Title className="px-2 py-1 text-sm font-medium">{S.menu.commandPalette}</Dialog.Title>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runAt(activeIndex);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onOpenChange(false);
              }
            }}
            placeholder={S.palette.searchPlaceholder}
            className="w-full rounded bg-muted px-2 py-1.5 text-sm text-foreground outline-none"
          />
          <ul className="mt-2 max-h-80 overflow-y-auto">
            {results.length === 0 ? (
              <li className="px-2 py-2 text-sm text-muted-foreground">{S.palette.empty}</li>
            ) : (
              results.map((command, index) => (
                <li key={command.id}>
                  <button
                    type="button"
                    className={`flex w-full cursor-default items-center justify-between rounded px-2 py-1 text-left text-sm ${
                      index === activeIndex ? 'bg-accent text-accent-foreground' : ''
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runAt(index)}
                  >
                    <span>{command.title}</span>
                    {command.hint !== undefined ? (
                      // На подсвеченной строке (`bg-accent`) обычный `muted-foreground`
                      // не наследует смену фона и даёт 4.01:1 в тёмной теме вместо
                      // нужных 4.5 (раунд исправлений 1 куска 1.4, ревью B) —
                      // `text-accent-foreground/80` держит подсказку тусклее
                      // заголовка строки, но читаемой на самом `--accent`.
                      <span
                        className={
                          index === activeIndex ? 'text-xs text-accent-foreground/80' : 'text-xs text-muted-foreground'
                        }
                      >
                        {command.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
