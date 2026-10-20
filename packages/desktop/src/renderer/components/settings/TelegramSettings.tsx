/**
 * Settings → Notifications → Telegram (план B, задача 12): токен бота, привязка кодом/QR, переключатели.
 * Состояние канала — `telegram.status` при монтировании и событие `telegram.changed`; сам токен наружу не
 * приходит, только хвост-подсказка. Раздела нет, если хост не знает `telegram.status`.
 */
import { useEffect, useState } from 'react';
import type { TelegramStatus } from '@parley/protocol';
import type { ParleyConfig } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { Switch } from '../../ui/switch.js';
import { qrSvg } from './qr.js';

export interface TelegramSettingsProps {
  bridge: ParleyBridge;
  config: ParleyConfig;
  locked: Record<string, string>;
  save: (key: keyof ParleyConfig, value: string) => Promise<void>;
  hostMethods: ReadonlySet<string>;
}

interface LinkState {
  code: string;
  deepLink: string;
  expiresAt: string;
  svg: string | null;
}

export function TelegramSettings({ bridge, config, locked, save, hostMethods }: TelegramSettingsProps): JSX.Element | null {
  const supported = hostMethods.has('telegram.status');
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);
  const [expired, setExpired] = useState(false);
  const text = S.settings.telegram;

  // Код живёт ограниченное время: по `expiresAt` прячем код, ссылку и QR.
  const expiresAt = link?.expiresAt ?? null;
  useEffect(() => {
    setExpired(false);
    if (expiresAt === null) return;
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    const off = bridge.on('telegram.changed', (next) => {
      if (!alive) return;
      setStatus(next);
      if (next.owner !== null) setLink(null);
    });
    bridge.call('telegram.status', {}).then(
      (next) => {
        if (alive) setStatus((current) => current ?? next);
      },
      (err: unknown) => {
        if (alive) setError(errorText(decodeIpcError(err).code, S.errors.actions.loadSettings));
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, [bridge, supported]);

  if (!supported) return null;

  /** Вызов метода хоста с общим «занято»/ошибкой; `bad_request` от `setToken` показывает текст хоста. */
  const run = async (action: string, operation: () => Promise<void>, showHostMessage = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (err: unknown) {
      const info = decodeIpcError(err);
      setError(showHostMessage && info.code === 'bad_request' ? info.message : errorText(info.code, action));
    } finally {
      setBusy(false);
    }
  };

  const check = (): Promise<void> =>
    run(
      text.actions.check,
      async () => {
        await bridge.call('telegram.setToken', { token: token.trim() });
        setToken('');
      },
      true,
    );
  const createLink = (): Promise<void> =>
    run(text.actions.link, async () => {
      const result = await bridge.call('telegram.link', {});
      setLink({ code: result.code, deepLink: result.deepLink, expiresAt: result.expiresAt, svg: null });
      void qrSvg(result.deepLink).then(
        (svg) => setLink((current) => (current?.code === result.code ? { ...current, svg } : current)),
        () => undefined,
      );
    });

  const enabled = config.telegramEnabled;
  const statusLine = (s: TelegramStatus | null): string => {
    if (!enabled || (s !== null && !s.enabled)) return text.statusOff;
    if (s === null || s.token === 'none') return text.statusNotSetUp;
    if (s.polling === 'conflict') return text.conflict;
    if (s.polling === 'error' || s.error !== null) return text.error(s.error ?? '');
    if (s.owner === null) return text.notLinked(s.botUsername ?? '', s.hint ?? '');
    const since = new Date(s.owner.linkedAt).toLocaleDateString('en-US', { dateStyle: 'medium' });
    return s.owner.username === null ? text.linkedNoName(since) : text.linked(`@${s.owner.username}`, since);
  };

  const toggle = (testId: string, label: string, key: keyof ParleyConfig): JSX.Element => (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <Switch
        data-testid={testId}
        checked={Boolean(config[key])}
        disabled={locked[key] !== undefined}
        onCheckedChange={(checked) => void save(key, String(checked))}
      />
    </label>
  );

  const hasToken = status !== null && status.token === 'set';
  const linked = status !== null && status.owner !== null;

  return (
    <section data-testid="telegram-section" className="flex flex-col gap-3 text-sm">
      <h3 className="text-sm font-medium">{text.title}</h3>
      <label className="flex items-center justify-between gap-2">
        <span>{text.enabled}</span>
        <Switch
          data-testid="telegram-enabled"
          checked={enabled}
          disabled={locked.telegramEnabled !== undefined}
          onCheckedChange={(checked) => void save('telegramEnabled', String(checked))}
        />
      </label>
      <p data-testid="telegram-status" className="text-xs text-muted-foreground">
        {statusLine(status)}
      </p>
      {enabled && status?.polling === 'conflict' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="telegram-take-over"
          disabled={busy}
          onClick={() => void run(text.actions.takeOver, async () => void (await bridge.call('telegram.takeOver', {})))}
        >
          {text.takeOver}
        </Button>
      ) : null}

      <div className={enabled ? 'flex flex-col gap-3' : 'flex flex-col gap-3 opacity-60'} data-testid="telegram-body">
      <div className="flex items-center gap-2">
        <Input
          type="password"
          data-testid="telegram-token"
          aria-label={text.tokenLabel}
          placeholder={text.tokenPlaceholder}
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button type="button" variant="outline" data-testid="telegram-check" disabled={busy || token.trim() === ''} onClick={() => void check()}>
          {text.check}
        </Button>
        {hasToken ? (
          <Button
            type="button"
            variant="outline"
            data-testid="telegram-remove"
            disabled={busy}
            onClick={() => void run(text.actions.remove, async () => void (await bridge.call('telegram.clearToken', {})))}
          >
            {text.remove}
          </Button>
        ) : null}
      </div>
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}

      {hasToken && !linked ? (
        <Button type="button" variant="outline" className="self-start" data-testid="telegram-link" disabled={busy} onClick={() => void createLink()}>
          {text.link}
        </Button>
      ) : null}
      {link !== null && !linked && expired ? (
        <p data-testid="telegram-code-expired" className="text-xs text-muted-foreground">
          {text.codeExpired}
        </p>
      ) : null}
      {link !== null && !linked && !expired ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {text.codeLabel} · {text.codeValid}
          </span>
          <code data-testid="telegram-code" className="select-all text-base">
            {link.code}
          </code>
          <span className="text-xs text-muted-foreground">{text.deepLinkLabel}</span>
          <span data-testid="telegram-deeplink" className="select-all break-all text-xs">
            {link.deepLink}
          </span>
          {link.svg !== null ? (
            <div
              data-testid="telegram-qr"
              role="img"
              aria-label={text.qrLabel}
              className="h-40 w-40 rounded bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
              // SVG строит наша же библиотека qrcode из ссылки хоста — внешнего HTML здесь нет.
              dangerouslySetInnerHTML={{ __html: link.svg }}
            />
          ) : null}
        </div>
      ) : null}
      {linked ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          data-testid="telegram-unlink"
          disabled={busy}
          onClick={() => void run(text.actions.unlink, async () => void (await bridge.call('telegram.unlink', {})))}
        >
          {text.unlink}
        </Button>
      ) : null}

      {linked && enabled ? (
        <>
          {toggle('telegram-needs-you', text.needsYou, 'telegramNeedsYou')}
          {toggle('telegram-finished', text.finished, 'telegramFinished')}
          {toggle('telegram-mail', text.mail, 'telegramMail')}
          {toggle('telegram-cards', text.cards, 'telegramCards')}
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">{text.hint}</p>
      </div>
    </section>
  );
}
