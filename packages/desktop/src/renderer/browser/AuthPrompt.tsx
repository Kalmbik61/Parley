/**
 * Запрос HTTP basic-auth над вкладкой браузера (`browser:auth-request`): не нативный диалог и не alert, а слой поверх поля
 * страницы, как заглушки «Page crashed» и «Couldn't load page». Enter отправляет, Esc отменяет; повтор (`retry`) — строка
 * ошибки. Пароль уходит только мостом в main этой вкладки (`bridge.browser.authResponse`) и в состоянии живёт до отправки.
 * Карточка в 800×500 помещается и с длинным именем хоста: оно переносится, а сама карточка прокручивается внутри слоя.
 */

import { useEffect, useRef, useState } from 'react';
import type { BrowserAuthRequest } from '../../shared/basic-auth.js';
import { S } from '../../shared/strings.js';

/** Предел поля логина и пароля — тот же, что у `browser:auth-response` в main (`main/ipc.ts`, MAX_AUTH_FIELD): длиннее main отвергает ответ. */
export const AUTH_FIELD_LIMIT = 1024;

export interface AuthPromptProps {
  request: BrowserAuthRequest;
  /** Ответ не дошёл до main (мост отказал): запрос остаётся на экране, под заголовком — строка ошибки. */
  failed?: boolean;
  /** Логин и пароль или `null` — отмена. */
  onSubmit(credentials: { username: string; password: string } | null): void;
}

const INPUT =
  'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function AuthPrompt({ request, failed = false, onSubmit }: AuthPromptProps): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const title = request.isProxy ? S.browser.auth.proxyTitle : S.browser.auth.title;

  // Новый запрос (повтор после неверного пароля) — пароль не остаётся в поле, фокус на логине.
  useEffect(() => {
    setPassword('');
    usernameRef.current?.focus();
    usernameRef.current?.select();
  }, [request.requestId]);

  return (
    <div data-testid="browser-auth" className="absolute inset-0 z-30 flex items-start justify-center overflow-auto bg-background/90 p-4">
      <form
        role="dialog"
        aria-label={title}
        className="my-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-sm text-card-foreground shadow-lg"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ username, password });
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onSubmit(null);
        }}
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 font-medium">
            <span>{title}</span>
            {request.isProxy ? <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">{S.browser.auth.proxy}</span> : null}
          </div>
          <div data-testid="browser-auth-host" className="break-all text-muted-foreground">
            {S.browser.auth.requiredBy(request.host)}
          </div>
          {request.realm === '' ? null : <div className="break-words text-xs text-muted-foreground">{S.browser.auth.realm(request.realm)}</div>}
        </div>
        {failed ? (
          <div role="alert" className="text-xs text-destructive">
            {S.browser.auth.sendFailed}
          </div>
        ) : null}
        {request.retry && !failed ? (
          <div role="alert" className="text-xs text-destructive">
            {S.browser.auth.wrong}
          </div>
        ) : null}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {S.browser.auth.username}
          <input
            ref={usernameRef}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={username}
            maxLength={AUTH_FIELD_LIMIT}
            onChange={(event) => setUsername(event.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {S.browser.auth.password}
          <input type="password" autoComplete="off" maxLength={AUTH_FIELD_LIMIT} value={password} onChange={(event) => setPassword(event.target.value)} className={INPUT} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onSubmit(null)} className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent">
            {S.browser.auth.cancel}
          </button>
          <button type="submit" className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90">
            {S.browser.auth.signIn}
          </button>
        </div>
      </form>
    </div>
  );
}
