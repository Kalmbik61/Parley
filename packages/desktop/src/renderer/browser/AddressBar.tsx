/**
 * Адресная строка вкладки браузера (кусок 9.2a, спека 12.1): ввод — `normalizeUrl` (9.1), поиска
 * нет. Ошибка — код, слова к нему — `S.browser`; стоит под полем поверх страницы, строка хрома
 * остаётся 36px.
 *
 * Пока поле не правят, оно показывает адрес страницы из раскладки: переходы страницы (SPA, «назад»)
 * меняют его сами. Правка держится до Enter, Esc или ухода фокуса без ошибки.
 */

import { useEffect, useRef, useState } from 'react';
import { S } from '../../shared/strings.js';
import { paletteGone } from '../palette/documents.js';
import { normalizeUrl } from './url.js';

export interface AddressBarProps {
  /** Адрес страницы; '' — новая вкладка. */
  url: string;
  /** Уже нормализованный адрес http(s). */
  onNavigate(url: string): void;
  /** Фокус в поле при монтировании — у новой вкладки без страницы (спека 12.1). */
  autoFocus?: boolean;
}

const ERROR_TEXT = {
  'not-an-address': S.browser.notAnAddress,
  'local-file': S.browser.localFile,
} as const;

export function AddressBar({ url, onNavigate, autoFocus = false }: AddressBarProps): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<keyof typeof ERROR_TEXT | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const value = draft ?? url;

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    // Вкладку открыла палитра: пока она в DOM, её ловушка фокуса вернёт фокус себе. Ждём её ухода и
    // берём фокус, только если его никто не увёл сам.
    let stale = false;
    void paletteGone().then(() => {
      const current = document.activeElement;
      if (!stale && (current === null || current === document.body)) inputRef.current?.focus();
    });
    return () => {
      stale = true;
    };
  }, [autoFocus]);

  const submit = (): void => {
    const result = normalizeUrl(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft(null);
    setError(null);
    onNavigate(result.url);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        type="text"
        aria-label={S.browser.address}
        aria-invalid={error !== null}
        spellCheck={false}
        autoComplete="off"
        value={value}
        title={value}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            setDraft(null);
            setError(null);
          }
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          if (error === null) setDraft(null);
        }}
        className="h-6 w-full min-w-0 truncate rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
      />
      {error === null ? null : (
        <div
          role="alert"
          className="absolute left-0 top-full z-20 mt-1 max-w-full rounded-md border border-destructive/40 bg-popover px-2 py-1 text-xs text-destructive shadow-md"
        >
          {ERROR_TEXT[error]}
        </div>
      )}
    </div>
  );
}
