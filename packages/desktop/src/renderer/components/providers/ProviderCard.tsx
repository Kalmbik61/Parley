/** Общая карточка провайдера. Полный ключ живёт только в локальном поле этого открытия. */
import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { PROVIDER_CHECK_REASONS, type ProviderCheck, type ProviderCheckReason, type Result } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { cn } from '../../lib/cn.js';
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

/** Быстрый ответ не должен погасить спиннер проверки раньше первого заметного кадра. */
const MIN_CHECK_FEEDBACK_MS = 600;

/**
 * Время проверки — местное и короткое, как в тултипе лимитов строки статуса: «9:30 PM». Исход переживает
 * перезапуск хоста, поэтому не сегодняшняя проверка показывает и дату: «Oct 5, 9:30 PM».
 */
function clock(iso: string, now = new Date()): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Причина, которую знает это окно: незнакомая (хост новее окна) читается как «незнакомый ответ». */
const knownReason = (reason: string | undefined): ProviderCheckReason =>
  (PROVIDER_CHECK_REASONS as readonly (string | undefined)[]).includes(reason)
    ? (reason as ProviderCheckReason)
    : 'unsupported_response';

/** Из двух исходов — более поздний: ответ этой карточки или снимок списка (его могло обновить другое окно). */
function newerCheck(answer: ProviderCheck | null, snapshot: ProviderCheck | null): ProviderCheck | null {
  if (answer === null) return snapshot;
  if (snapshot === null) return answer;
  return Date.parse(snapshot.at) > Date.parse(answer.at) ? snapshot : answer;
}

/** Строка исхода проверки ключа: «проверено» или подсказка, что делать, и подробности ответа Z.ai. */
function CheckLine({ check, checking }: { check: ProviderCheck | null; checking: boolean }): JSX.Element | null {
  if (!checking && check === null) return null;
  return (
    <div role="status" aria-busy={checking} className="space-y-0.5 text-xs">
      {checking || check === null ? (
        <p className="text-muted-foreground">{S.providerCard.checkingLine}</p>
      ) : check.state === 'ok' ? (
        <p className="text-muted-foreground">{S.providerCard.checkedOk(clock(check.at))}</p>
      ) : (
        <>
          <p className="text-destructive">{S.providerCard.checkHint[knownReason(check.reason)]}</p>
          <p className="tabular-nums text-muted-foreground">
            {S.providerCard.checkDetails(check.httpStatus, check.code, clock(check.at))}
          </p>
        </>
      )}
    </div>
  );
}

export function ProviderCard({
  provider,
  onReload,
  onRestartHost,
  open = true,
}: ProviderCardProps): JSX.Element | null {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Ответ `providers.check` этого открытия: показывается сразу, не дожидаясь перечитанного списка. */
  const [answer, setAnswer] = useState<ProviderCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const inputId = useId();
  const hostStatus = useHostStore((state) => state.status);
  const connections = useHostStore((state) => state.connections);
  const methods = hostMethods(hostStatus);
  const supportsKeys = methods.has('providers.setKey') && methods.has('providers.clearKey');
  const isGlm = provider.id === 'glm';
  // Хост умеет проверить ключ тестовым сообщением; прежний — только перечитать список.
  const verifies = isGlm && methods.has('providers.check');
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
    setChecking(false);
    setAnswer(null);
    setError(null);
    setCopied(false);
    return () => {
      ++generation.current;
    };
  }, [open, provider.id, connections]);

  // Ответ карточки — о ключе, которым проверяли: новый ключ требует своей проверки.
  useEffect(() => {
    setAnswer(null);
  }, [provider.keyHint]);

  const run = async (
    action: string,
    operation: () => Promise<unknown>,
    clearField = false,
    refresh = false,
  ): Promise<boolean> => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    let failedAction = action;
    try {
      await operation();
      if (current !== generation.current) return false;
      if (clearField) setKey('');
      if (refresh) {
        failedAction = S.errors.actions.loadProviders;
        await onReload();
      }
      return current === generation.current;
    } catch (err: unknown) {
      // Только код: текст ошибки может содержать секрет или локальный путь.
      if (current === generation.current)
        setError(errorText(decodeIpcError(err).code, failedAction));
      return false;
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const openGuide = (url: string): void => {
    void run(S.errors.actions.openProviderGuide, () => window.parley.app.openExternal(url));
  };

  /**
   * Check again. У GLM — тестовое сообщение Z.ai сохранённым ключом (`providers.check`), затем перечитанный
   * список; у прочих провайдеров и у прежнего хоста — только перечитанный список, без сети. Спиннер не
   * короче минимального кадра: быстрый отказ не должен промелькнуть незамеченным.
   */
  const runCheck = async (): Promise<void> => {
    if (!verifies) {
      await run(S.errors.actions.loadProviders, onReload);
      return;
    }
    const current = generation.current;
    const startedAt = Date.now();
    setChecking(true);
    setError(null);
    try {
      let failure: { error: unknown; action: string } | null = null;
      try {
        const { check } = await window.parley.call('providers.check', { provider: provider.id });
        if (current === generation.current && check !== null) setAnswer(check);
      } catch (err: unknown) {
        failure = { error: err, action: S.errors.actions.checkProviderKey };
      }
      const rest = MIN_CHECK_FEEDBACK_MS - (Date.now() - startedAt);
      if (rest > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, rest);
        });
      }
      if (current !== generation.current) return;
      try {
        await onReload();
      } catch (err: unknown) {
        failure ??= { error: err, action: S.errors.actions.loadProviders };
      }
      // Только код: текст ошибки может содержать секрет или локальный путь.
      if (current === generation.current && failure !== null)
        setError(errorText(decodeIpcError(failure.error).code, failure.action));
    } finally {
      if (current === generation.current) setChecking(false);
    }
  };

  /** Save (и Check again с набранным ключом): сохранить ключ и сразу проверить его, как по Check again. */
  const saveAndCheck = async (): Promise<void> => {
    const saved = await run(
      S.errors.actions.saveProviderKey,
      () => window.parley.call('providers.setKey', { provider: 'glm', key }),
      true,
      true,
    );
    if (saved && verifies) await runCheck();
  };

  if (!open) return null;
  const fiveHour = provider.limits?.fiveHour?.usedPercent;
  const week = provider.limits?.week?.usedPercent;
  // Исход проверки ключа виден только у готового провайдера: без CLI или ключа шапка — Not connected.
  const check = verifies && provider.available ? newerCheck(answer, provider.check ?? null) : null;
  const rejected = !checking && check?.state === 'failed';
  const status = (() => {
    if (verifies && checking) return S.providerCard.checking;
    if (!provider.available) return S.providerCard.notConnected;
    if (!verifies) return S.providerCard.connected;
    if (check === null) return S.providerCard.notVerified;
    return check.state === 'ok'
      ? S.providerCard.connected
      : S.providerCard.checkLabel[knownReason(check.reason)];
  })();
  return (
    <div className="space-y-3 text-sm text-foreground" data-provider-card={provider.id}>
      <div className="flex items-center gap-2">
        <AgentIcon provider={provider.id} size={20} />
        <h3 className="font-heading">{name}</h3>
        <span className={cn('ml-auto text-xs', rejected ? 'text-destructive' : 'text-muted-foreground')}>
          {status}
        </span>
      </div>
      {provider.version == null ? null : (
        <p className="font-mono text-xs text-muted-foreground">{provider.version}</p>
      )}
      {provider.argsOverridden === true ? (
        // `args` из providers.json заменили встроенные: выбор модели и effort есть, только если в них `{model}`/`{effort}`.
        <div data-testid="provider-args" className="space-y-0.5 text-xs text-muted-foreground">
          <p>{S.providerCard.argsOverridden}</p>
          {(provider.models ?? []).length === 0 ? <p>{S.providerCard.noModelChoice}</p> : null}
          {provider.effort === true ? null : <p>{S.providerCard.noEffortChoice}</p>}
        </div>
      ) : null}
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
      {(!isGlm || provider.limits?.source === 'zai') && provider.available && (fiveHour !== undefined || week !== undefined) ? (
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
          ) : supportsKeys ? (
            // Без сохранённого ключа шапка говорит лишь Not connected — здесь сказано, чего не хватает.
            <p className="text-xs text-muted-foreground">{S.providerCard.noKey}</p>
          ) : null}
          {verifies ? <CheckLine check={check} checking={checking} /> : null}
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
                disabled={busy || checking}
                onChange={(event) => setKey(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || checking || key.trim() === ''}
                  onClick={() => {
                    void saveAndCheck();
                  }}
                >
                  {hasKey ? S.providerCard.replace : S.providerCard.save}
                </Button>
                {hasKey ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || checking}
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
        aria-busy={checking}
        disabled={busy || checking || hostStatus.state !== 'connected'}
        onClick={() => {
          // Набранный, но не сохранённый ключ человек и хочет проверить: сначала сохранить, как Save.
          if (isGlm && supportsKeys && key.trim() !== '') void saveAndCheck();
          else void runCheck();
        }}
      >
        {checking ? (
          <>
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {S.providerCard.checking}
          </>
        ) : (
          S.providerCard.checkAgain
        )}
      </Button>
    </div>
  );
}
