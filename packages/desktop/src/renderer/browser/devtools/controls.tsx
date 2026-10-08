/**
 * Кнопки и поле фильтров панели Console | Network (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.4):
 * переключатель с `aria-pressed`, поле поиска и значок-кнопка. Цвета — те же токены, что у кнопок строки вкладки
 * (`BrowserChrome.tsx`).
 */
import type { ReactNode } from 'react';

export function FilterToggle({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="h-5 shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
    >
      {children}
    </button>
  );
}

export function FilterInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }): JSX.Element {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      spellCheck={false}
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-5 min-w-0 flex-1 basis-24 rounded border border-input bg-background px-1.5 text-[11px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

/** Значок-кнопка панели: подпись — для скринридера и подсказки. */
export function PanelIconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </button>
  );
}
