/** Общая карточка провайдера. Полный ключ живёт только в локальном поле этого открытия. */
import { useEffect, useId, useRef, useState } from 'react';
import type { Result } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { AgentIcon } from '../AgentIcon.js';
import { GLM_KEY_URL, PROVIDER_INSTALL } from './provider-install.js';

export interface ProviderCardProps {
  /** Структурный тип позволяет передать снимок стора или список этого открытия диалога. */
  provider: Result<'providers.list'>['providers'][number];
  onReload: () => Promise<void>;
  /** Открывает существующее подтверждение перезапуска хоста. */
  onRestartHost: () => void;
  /** Для родителя, который при закрытии оставляет карточку смонтированной. */
  open?: boolean;
}

/** Даже неполный/чужой ответ хоста не должен отразить немаскированную строку. */
function maskedHint(hint: string): string {
  return /^[•*]+[^•*]{0,4}$/u.test(hint) ? `••••${hint.replace(/^[•*]+/u, '')}` : '••••';
}

export function ProviderCard({
  provider,
  onReload,
  onRestartHost,
  open = true,
}: ProviderCardProps): JSX.Element | null {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const inputId = useId();
  const status = useHostStore((state) => state.status);
  const connections = useHostStore((state) => state.connections);
  const methods = hostMethods(status);
  const supportsKeys = methods.has('providers.setKey') && methods.has('providers.clearKey');
  const isGlm = provider.id === 'glm';
  const hasKey = provider.keyHint != null;
  const name = providerName(provider.id, provider.label);
  const install =
    provider.id === 'codex'
      ? PROVIDER_INSTALL.codex
      : provider.id === 'claude' || isGlm
        ? PROVIDER_INSTALL.claude
        : null;
  const showInstall =
    install !== null &&
    (isGlm ? provider.needs === 'cli' || provider.version == null : !provider.available);

  useEffect(() => {
    ++generation.current;
    setKey('');
    setBusy(false);
    setError(null);
    setCopied(false);
    return () => {
      ++generation.current;
    };
  }, [open, provider.id, connections]);

  const run = async (
    action: string,
    operation: () => Promise<unknown>,
    clearField = false,
    refresh = false,
  ): Promise<void> => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    let failedAction = action;
    try {
      await operation();
      if (current !== generation.current) return;
      if (clearField) setKey('');
      if (refresh) {
        failedAction = S.errors.actions.loadProviders;
        await onReload();
      }
    } catch (err: unknown) {
      // Только код: текст ошибки может содержать секрет или локальный путь.
      if (current === generation.current)
        setError(errorText(decodeIpcError(err).code, failedAction));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const openGuide = (url: string): void => {
    void run(S.errors.actions.openProviderGuide, () => window.parley.app.openExternal(url));
  };

  if (!open) return null;
  const fiveHour = provider.limits?.fiveHour?.usedPercent;
  const week = provider.limits?.week?.usedPercent;
  return (
    <div className="space-y-3 text-sm text-foreground" data-provider-card={provider.id}>
      <div className="flex items-center gap-2">
        <AgentIcon provider={provider.id} size={20} />
        <h3 className="font-heading">{name}</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {provider.available ? S.providerCard.connected : S.providerCard.notConnected}
        </span>
      </div>
      {provider.version == null ? null : (
        <p className="font-mono text-xs text-muted-foreground">{provider.version}</p>
      )}
      {isGlm ? (
        <>
          <p>{S.providerCard.glmDescription}</p>
          <p className="font-medium">{S.providerCard.glmPlan}</p>
          <p className="text-xs text-muted-foreground">{S.providerCard.glmCli}</p>
          {!provider.available && provider.needs === null ? (
            <p className="text-xs text-muted-foreground">{S.providerCard.glmUnavailable}</p>
          ) : null}
        </>
      ) : null}
      {showInstall && install !== null ? (
        <div className="space-y-2">
          <code className="block break-all rounded-lg bg-muted p-2 text-xs">{install.command}</code>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                const current = generation.current;
                void run(S.errors.actions.copyInstallCommand, async () => {
                  await navigator.clipboard.writeText(install.command);
                  if (current === generation.current) setCopied(true);
                });
              }}
            >
              {copied ? S.providerCard.copied : S.providerCard.copy}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="link"
              disabled={busy}
              onClick={() => openGuide(install.docs)}
            >
              {S.providerCard.installationGuide}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{S.providerCard.path}</p>
        </div>
      ) : null}
      {!isGlm && install !== null ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{S.providerCard.signIn}</p>
          {provider.available ? (
            <p className="text-xs text-muted-foreground">{S.providerCard.account(install.login)}</p>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="link"
            disabled={busy}
            onClick={() => openGuide(install.loginDocs)}
          >
            {S.providerCard.signInGuide}
          </Button>
        </div>
      ) : null}
      {!isGlm && provider.available && (fiveHour !== undefined || week !== undefined) ? (
        <p className="text-xs tabular-nums text-muted-foreground">
          {S.statusBar.limitsText(
            fiveHour === undefined ? null : Math.floor(fiveHour),
            week === undefined ? null : Math.floor(week),
          )}
        </p>
      ) : null}
      {isGlm ? (
        <div className="space-y-2">
          {hasKey ? (
            <p className="text-xs text-muted-foreground">
              {S.providerCard.keyHint(maskedHint(provider.keyHint!))}
            </p>
          ) : null}
          {supportsKeys ? (
            <>
              <label className="block text-xs" htmlFor={inputId}>
                {S.providerCard.keyLabel}
              </label>
              <Input
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                disabled={busy}
                onChange={(event) => setKey(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || key.trim() === ''}
                  onClick={() => {
                    void run(
                      S.errors.actions.saveProviderKey,
                      () => window.parley.call('providers.setKey', { provider: 'glm', key }),
                      true,
                      true,
                    );
                  }}
                >
                  {hasKey ? S.providerCard.replace : S.providerCard.save}
                </Button>
                {hasKey ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      void run(
                        S.errors.actions.removeProviderKey,
                        () => window.parley.call('providers.clearKey', { provider: 'glm' }),
                        true,
                        true,
                      );
                    }}
                  >
                    {S.providerCard.remove}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  disabled={busy}
                  onClick={() => openGuide(GLM_KEY_URL)}
                >
                  {S.providerCard.getKey}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{S.providerCard.restartRequired}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRestartHost}>
                {S.providerCard.restartHost}
              </Button>
            </>
          )}
          <p className="text-xs text-muted-foreground">{S.providerCard.glmLogout}</p>
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || status.state !== 'connected'}
        onClick={() => {
          void run(S.errors.actions.loadProviders, onReload);
        }}
      >
        {S.providerCard.checkAgain}
      </Button>
    </div>
  );
}
