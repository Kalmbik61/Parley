/**
 * Форма аккаунта подписки (спека подписок 4.1, 5.5, 10) — вид `account` панели `CustomProviderPanel`: имя, «Bring from
 * Claude Code», строка про папку, состояние входа, Save / Sign in / Cancel / Sign out / Delete и маленький терминал
 * входа под кнопками. У аккаунта нет ни адреса, ни ключа, ни моделей: вход — команда самого CLI (`providers.signIn`),
 * ключа в окне нет вовсе. Этап 2 — аккаунты Claude Code; Codex добавит этап 3.
 *
 * Вход, начатый до закрытия Settings, живёт на хосте (спека 10): при открытии `custom.signingIn` показывает терминал
 * сразу, а напечатанное до этого берётся из буфера стора (`store/providers.ts`, хост вывод не повторяет).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { useProvidersStore, type ProviderInfo } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Input } from '../../ui/input.js';
import { accountOf, kindOf } from './custom-provider-draft.js';
import { SignInTerminal } from './SignInTerminal.js';

export interface AccountPanelProps {
  /** Сохранённый аккаунт; `null` — новый, форма до первого Save (вход возможен только у сохранённого). */
  provider: ProviderInfo | null;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}

export function AccountPanel({ provider, onSaved, onDeleted }: AccountPanelProps): JSX.Element {
  const account = accountOf(provider?.custom);
  const providers = useProvidersStore((state) => state.providers);
  const reload = useProvidersStore((state) => state.reload);
  const beginSignIn = useProvidersStore((state) => state.beginSignIn);
  const result = useProvidersStore((state) => (provider === null ? undefined : state.signInResult[provider.id]));
  const [name, setName] = useState(provider?.label ?? '');
  const [link, setLink] = useState(account?.link ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeFolder, setRemoveFolder] = useState(false);
  /** Сколько раз за жизнь формы нажали Sign in; больше нуля — терминал показан, а ключ пересоздаёт его на каждый вход. */
  const [runs, setRuns] = useState(account?.signingIn === true ? 1 : 0);
  /** Хост ответил на `providers.signIn`: процесс поднят и размер терминала дойдёт до него (начатый не отсюда — поднят уже). */
  const [started, setStarted] = useState(account?.signingIn === true);
  const [detail, setDetail] = useState<string | null>(null);
  const generation = useRef(0);
  const nameId = useId();

  const signedIn = account?.signedIn ?? null;
  const signingIn = account?.signingIn === true;
  const showTerminal = provider !== null && (runs > 0 || signingIn);

  useEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );

  // Почта и план рядом с «Signed in» (`claude auth status`, спека подписок 4.1): запрашиваются, когда аккаунт вошёл.
  useEffect(() => {
    setDetail(null);
    if (provider === null || signedIn !== true) return;
    let live = true;
    window.parley
      .call('providers.authStatus', { provider: provider.id })
      .then((answer) => {
        if (live) setDetail(answer.detail);
      })
      .catch(() => {
        // Подпись — дополнение: без неё состояние «Signed in» остаётся верным.
      });
    return () => {
      live = false;
    };
  }, [provider?.id, signedIn]);

  /** Только код ошибки: текст хоста может содержать локальный путь. */
  const fail = (err: unknown, action: string, current: number): void => {
    if (current === generation.current) setError(errorText(decodeIpcError(err).code, action));
  };

  const save = async (): Promise<void> => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const { id } = await window.parley.call('providers.saveCustom', {
        kind: 'claude-account',
        id: provider?.id ?? null,
        label: name.trim(),
        link,
      });
      await reload();
      if (current === generation.current) onSaved(id);
    } catch (err: unknown) {
      fail(err, S.accounts.saveFailed, current);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const signIn = async (): Promise<void> => {
    if (provider === null) return;
    const current = generation.current;
    setError(null);
    setStarted(false);
    setRuns((count) => count + 1);
    beginSignIn(provider.id);
    try {
      await window.parley.call('providers.signIn', { provider: provider.id });
      if (current === generation.current) setStarted(true);
    } catch (err: unknown) {
      fail(err, S.accounts.signInStartFailed, current);
      if (current === generation.current) setRuns(0);
      // Строка списка помечена входом по ожиданию (`beginSignIn`): правду о ней знает хост.
      await reload().catch(() => {});
    }
  };

  const cancelSignIn = async (): Promise<void> => {
    if (provider === null) return;
    const current = generation.current;
    setError(null);
    try {
      await window.parley.call('providers.cancelSignIn', { provider: provider.id });
    } catch (err: unknown) {
      fail(err, S.accounts.cancelFailed, current);
    }
  };

  const signOut = async (): Promise<void> => {
    if (provider === null) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await window.parley.call('providers.signOut', { provider: provider.id });
      await reload();
    } catch (err: unknown) {
      fail(err, S.accounts.signOutFailed, current);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (provider === null) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await window.parley.call('providers.deleteCustom', { id: provider.id, removeFolder });
      await reload();
      if (current === generation.current) onDeleted();
    } catch (err: unknown) {
      fail(err, S.accounts.deleteFailed, current);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  // «Sign in» карточки аккаунта (строка статуса, спека 4.2) просит начать вход сразу. Флаг читается из стора внутри
  // эффекта и снимается тут же: повторный запуск эффекта (StrictMode) вход второй раз не начнёт.
  const signInRequested = useUiStore((state) => state.settingsSignIn);
  useEffect(() => {
    if (provider === null) return;
    const ui = useUiStore.getState();
    if (!ui.settingsSignIn || ui.settingsProvider !== provider.id) return;
    useUiStore.setState({ settingsSignIn: false });
    if (signedIn !== true && !signingIn) void signIn();
  }, [provider?.id, signInRequested]);

  // Стандартное имя нового аккаунта — только подсказка в поле: настоящее имя выдаёт хост при сохранении (спека 5.9).
  const defaultName = S.accounts.defaultName(providers.filter((row) => kindOf(row.custom) === 'claude-account').length + 2);
  const folder = account?.folder ?? S.customProviders.folderFallback;
  const state =
    signingIn
      ? { key: 'signing-in', text: S.accounts.signingIn }
      : signedIn === true
        ? { key: 'signed-in', text: S.accounts.signedIn }
        : signedIn === false
          ? { key: 'not-signed-in', text: S.accounts.notSignedIn }
          : { key: 'unknown', text: S.accounts.checking };

  return (
    <div className="space-y-3 text-sm text-foreground" data-account-form={provider?.id ?? 'new'}>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={nameId} className="text-xs text-muted-foreground">
          {S.accounts.nameField}
        </label>
        <Input
          id={nameId}
          value={name}
          disabled={busy}
          maxLength={40}
          placeholder={provider === null ? defaultName : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox
            aria-label={S.accounts.bringFromClaude}
            checked={link}
            disabled={busy}
            onCheckedChange={(on) => setLink(on === true)}
          />
          {S.accounts.bringFromClaude}
        </label>
        {link ? <p className="text-xs text-muted-foreground">{S.customProviders.linkClaudeNote}</p> : null}
        <p className="break-all text-xs text-muted-foreground">{S.accounts.folderLine(folder)}</p>
      </div>

      {provider === null ? null : (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span data-account-state={state.key} className="font-medium">
            {state.text}
          </span>
          {signedIn === true && !signingIn && detail !== null ? (
            <span data-account-detail="" className="text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </p>
      )}

      {confirmDelete && provider !== null ? (
        <div className="space-y-2 rounded-xl border border-destructive/40 p-3" role="group" aria-label={S.accounts.delete}>
          <p className="text-xs">{S.customProviders.deleteConfirm(provider.label)}</p>
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              aria-label={S.accounts.deleteFolder}
              checked={removeFolder}
              disabled={busy}
              onCheckedChange={(on) => setRemoveFolder(on === true)}
            />
            {S.accounts.deleteFolder}
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {S.customProviders.deleteConfirmButton}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>
              {S.accounts.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? S.accounts.saving : S.accounts.save}
          </Button>
          {provider === null ? null : signingIn ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void cancelSignIn()}>
              {S.accounts.cancel}
            </Button>
          ) : signedIn === true ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void signOut()}>
              {S.accounts.signOut}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void signIn()}>
              {S.accounts.signIn}
            </Button>
          )}
          {provider === null ? null : (
            <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={busy || signingIn} onClick={() => setConfirmDelete(true)}>
              {S.accounts.delete}
            </Button>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{S.accounts.signInCaption}</p>

      {showTerminal && provider !== null ? (
        <div className="space-y-1.5">
          <SignInTerminal key={runs} provider={provider.id} running={signingIn && (started || runs === 0)} />
          {!signingIn && result !== undefined ? (
            <p role="status" data-sign-in-result="" className="text-xs text-muted-foreground">
              {result.signedIn ? S.accounts.signInDone : S.accounts.signInFailed}
            </p>
          ) : null}
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
