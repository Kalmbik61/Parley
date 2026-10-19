/**
 * Выбор вендора и форма своего провайдера (спека своих провайдеров, 4.3): шаг 1 — плитки пресетов, шаг 2 — поля.
 * Полный ключ живёт только в локальном поле этой формы; в параметры `providers.saveCustom` и в тексты ошибок он не
 * попадает (ошибки — по коду, как в `ProviderCard`).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ProviderCheck } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Input } from '../../ui/input.js';
import { AgentIcon } from '../AgentIcon.js';
import { CheckLine, maskedHint, newerCheck } from './check-line.js';
import { CUSTOM_PRESETS, type CustomPreset } from './custom-presets.js';
import {
  draftError,
  draftFromPreset,
  draftFromProvider,
  isLoopbackAddress,
  saveParams,
  type CustomProviderDraft,
} from './custom-provider-draft.js';

export interface CustomProviderPanelProps {
  /** Id своего провайдера или `'new'` — шаг выбора вендора. */
  providerId: string | 'new';
  onSaved: (id: string) => void;
  onDeleted: () => void;
}

const SELECT =
  'h-9 w-full rounded-full border border-input bg-background px-[14px] text-sm hover:border-foreground/45 focus-visible:border-ring focus-visible:outline-offset-0 disabled:opacity-50';

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function CustomProviderPanel({ providerId, onSaved, onDeleted }: CustomProviderPanelProps): JSX.Element {
  const providers = useProvidersStore((state) => state.providers);
  const reload = useProvidersStore((state) => state.reload);
  const hostStatus = useHostStore((state) => state.status);
  const methods = hostMethods(hostStatus);
  const item = providerId === 'new' ? undefined : providers.find((provider) => provider.id === providerId);
  const custom = item?.custom ?? null;

  const [draft, setDraft] = useState<CustomProviderDraft | null>(() =>
    item !== undefined && custom != null ? draftFromProvider({ id: item.id, label: item.label, custom }) : null,
  );
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<ProviderCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeFolder, setRemoveFolder] = useState(false);
  const generation = useRef(0);
  const uid = useId();
  const fid = (name: string): string => `${uid}-${name}`;

  // Смена выбранного провайдера начинает форму заново; поздний ответ прежнего не должен её тронуть.
  useEffect(() => {
    ++generation.current;
    setDraft(item !== undefined && custom != null ? draftFromProvider({ id: item.id, label: item.label, custom }) : null);
    setReplacing(false);
    setBusy(false);
    setChecking(false);
    setAnswer(null);
    setError(null);
    setConfirmDelete(false);
    setRemoveFolder(false);
    return () => {
      ++generation.current;
    };
    // Форма сбрасывается только сменой провайдера: правки человека не затираются перечитанным списком.
  }, [providerId]);

  // «Хост слишком старый» — только у подключённого хоста без метода; пока хост не подключён, методов просто не видно.
  if (hostStatus.state !== 'connected') {
    return <p className="text-xs text-muted-foreground">{S.customProviders.hostNotConnected}</p>;
  }
  if (!methods.has('providers.saveCustom')) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">{S.customProviders.restartRequired}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => useUiStore.getState().confirmRestartHost()}>
          {S.customProviders.restartHost}
        </Button>
      </div>
    );
  }

  if (providerId === 'new' && draft === null) {
    return (
      <div className="space-y-3" data-custom-provider-step="vendor">
        <div>
          <h3 className="font-heading text-sm">{S.customProviders.pickVendor}</h3>
          <p className="text-xs text-muted-foreground">{S.customProviders.pickVendorHint}</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[...CUSTOM_PRESETS, null].map((preset: CustomPreset | null) => (
            <button
              key={preset?.id ?? 'own'}
              type="button"
              data-vendor-tile={preset?.id ?? 'own'}
              onClick={() => setDraft(draftFromPreset(preset, preset?.endpoints[0] ?? null))}
              className="flex flex-col items-start gap-0.5 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:bg-foreground/7"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {/* Значок Parley на всех плитках: вендорские значки — следующая работа (спека 3.7). */}
                <span aria-hidden="true" className="inline-flex">
                  <AgentIcon provider="custom-x" size={14} />
                </span>
                {preset?.label ?? S.customProviders.ownAddress}
              </span>
              <span className="text-xs text-muted-foreground">{preset?.billing ?? S.customProviders.ownAddressBilling}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (draft === null) return <div data-custom-provider-missing={providerId} />;

  const preset = CUSTOM_PRESETS.find((candidate) => candidate.id === draft.preset) ?? null;
  const keySaved = item?.keyHint != null;
  const problem = draftError(draft, keySaved);
  const patch = (next: Partial<CustomProviderDraft>): void => setDraft((current) => (current === null ? current : { ...current, ...next }));
  const patchModel = (slot: 'opus' | 'sonnet' | 'haiku' | 'subagent', value: string): void =>
    setDraft((current) => (current === null ? current : { ...current, models: { ...current.models, [slot]: value } }));
  const locked = busy || checking;
  const showKeyInput = !keySaved || replacing;

  /** Только код ошибки: текст хоста может содержать секрет или локальный путь. */
  const fail = (err: unknown, action: string, current: number): void => {
    if (current === generation.current) setError(errorText(decodeIpcError(err).code, action));
  };

  const save = async (): Promise<void> => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    let action: string = S.customProviders.saveFailed;
    try {
      const { id } = await window.parley.call('providers.saveCustom', saveParams(draft));
      // Дальше сбой ключа не должен породить дубль: форма уже знает id.
      if (current === generation.current) patch({ id });
      if (draft.key.trim() !== '') {
        action = S.customProviders.keyFailed;
        await window.parley.call('providers.setKey', { provider: id, key: draft.key });
      }
      await reload();
      if (current !== generation.current) return;
      patch({ key: '' });
      setReplacing(false);
      onSaved(id);
    } catch (err: unknown) {
      fail(err, action, current);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const removeKey = async (): Promise<void> => {
    if (draft.id === null) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await window.parley.call('providers.clearKey', { provider: draft.id });
      await reload();
    } catch (err: unknown) {
      fail(err, S.errors.actions.removeProviderKey, current);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const runCheck = async (): Promise<void> => {
    if (draft.id === null) return;
    const current = generation.current;
    setChecking(true);
    setError(null);
    try {
      const { check } = await window.parley.call('providers.check', { provider: draft.id });
      if (current === generation.current && check !== null) setAnswer(check);
      await reload();
    } catch (err: unknown) {
      fail(err, S.customProviders.checkFailed, current);
    } finally {
      if (current === generation.current) setChecking(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (draft.id === null) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await window.parley.call('providers.deleteCustom', { id: draft.id, removeFolder });
      await reload();
      if (current === generation.current) onDeleted();
    } catch (err: unknown) {
      fail(err, S.customProviders.deleteFailed, current);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  // Адрес на этом же компьютере можно сохранить и проверить без ключа (спека 4.1, 8; хост принимает `key === null`).
  const keyless = isLoopbackAddress(draft.baseUrl);
  const check = keySaved || keyless ? newerCheck(answer, item?.check ?? null) : null;
  const canCheck = draft.id !== null && methods.has('providers.check') && (keySaved || keyless);
  const folderText = S.customProviders.folderLine(custom?.folder ?? S.customProviders.folderFallback);
  const slots = [
    ['opus', S.customProviders.slotOpus],
    ['sonnet', S.customProviders.slotSonnet],
    ['haiku', S.customProviders.slotHaiku],
    ['subagent', S.customProviders.slotSubagent],
  ] as const;

  return (
    <div className="space-y-3 text-sm text-foreground" data-custom-provider-form={draft.id ?? 'new'}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label={S.customProviders.nameField} id={fid('name')}>
          <Input id={fid('name')} value={draft.label} disabled={locked} maxLength={40} onChange={(e) => patch({ label: e.target.value })} />
        </Field>
        {preset !== null && preset.endpoints.length > 1 && draft.id === null ? (
          <Field label={S.customProviders.endpointField} id={fid('endpoint')}>
            <select
              id={fid('endpoint')}
              className={SELECT}
              value={draft.endpointId ?? ''}
              disabled={locked}
              onChange={(e) => {
                const endpoint = preset.endpoints.find((candidate) => candidate.id === e.target.value);
                if (endpoint === undefined) return;
                patch({
                  endpointId: endpoint.id,
                  baseUrl: endpoint.baseUrl,
                  auth: endpoint.auth,
                  models: { ...endpoint.models },
                  contextWindow: endpoint.contextWindow,
                });
              }}
            >
              {preset.endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.label}
                </option>
              ))}
            </select>
          </Field>
        ) : draft.preset === null ? (
          <Field label={S.customProviders.authField} id={fid('auth')}>
            <select
              id={fid('auth')}
              className={SELECT}
              value={draft.auth}
              disabled={locked}
              onChange={(e) => patch({ auth: e.target.value === 'api-key' ? 'api-key' : 'bearer' })}
            >
              <option value="bearer">{S.customProviders.authBearer}</option>
              <option value="api-key">{S.customProviders.authApiKey}</option>
            </select>
          </Field>
        ) : (
          <div />
        )}
        <div className="col-span-2">
          <Field label={S.customProviders.addressField} id={fid('address')}>
            <Input
              id={fid('address')}
              value={draft.baseUrl}
              disabled={locked}
              spellCheck={false}
              placeholder="https://api.example.com/anthropic"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </Field>
        </div>
        <div className="col-span-2 space-y-1">
          {keySaved && item?.keyHint != null ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{S.customProviders.keyHint(maskedHint(item.keyHint))}</span>
              <Button type="button" size="xs" variant="outline" disabled={locked} onClick={() => setReplacing((on) => !on)}>
                {S.customProviders.replace}
              </Button>
              <Button type="button" size="xs" variant="outline" disabled={locked} onClick={() => void removeKey()}>
                {S.customProviders.remove}
              </Button>
            </div>
          ) : null}
          {showKeyInput ? (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label={S.customProviders.keyField} id={fid('key')}>
                  <Input
                    id={fid('key')}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.key}
                    disabled={locked}
                    placeholder={S.customProviders.keyPlaceholder}
                    onChange={(e) => patch({ key: e.target.value })}
                  />
                </Field>
              </div>
              {preset !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  disabled={busy}
                  onClick={() => void window.parley.app.openExternal(preset.keyUrl).catch(() => undefined)}
                >
                  {S.customProviders.getKey}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <h4 className="text-xs text-muted-foreground">{S.customProviders.modelsTitle}</h4>
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              aria-label={S.customProviders.oneModel}
              checked={draft.oneModel}
              disabled={locked}
              onCheckedChange={(on) => patch({ oneModel: on === true })}
            />
            {S.customProviders.oneModel}
          </label>
        </div>
        {draft.oneModel ? (
          <Field label={S.customProviders.oneModelField} id={fid('one')}>
            <Input id={fid('one')} value={draft.models.sonnet} disabled={locked} spellCheck={false} onChange={(e) => patchModel('sonnet', e.target.value)} />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {slots.map(([slot, label]) => (
              <Field key={slot} label={label} id={fid(slot)}>
                <Input id={fid(slot)} value={draft.models[slot]} disabled={locked} spellCheck={false} onChange={(e) => patchModel(slot, e.target.value)} />
              </Field>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox
            aria-label={S.customProviders.linkClaude}
            checked={draft.linkClaude}
            disabled={locked}
            onCheckedChange={(on) => patch({ linkClaude: on === true })}
          />
          {S.customProviders.linkClaude}
        </label>
        {draft.linkClaude ? <p className="text-xs text-muted-foreground">{S.customProviders.linkClaudeNote}</p> : null}
        <p className="break-all text-xs text-muted-foreground">{folderText}</p>
      </div>

      {check !== null || checking ? <CheckLine custom check={check} checking={checking} /> : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {problem !== null && draft.label !== '' && draft.baseUrl !== '' ? <p className="text-xs text-muted-foreground">{problem}</p> : null}

      {confirmDelete ? (
        <div className="space-y-2 rounded-xl border border-destructive/40 p-3" role="group" aria-label={S.customProviders.deleteProvider}>
          <p className="text-xs">{S.customProviders.deleteConfirm(draft.label)}</p>
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              aria-label={S.customProviders.deleteFolder}
              checked={removeFolder}
              disabled={busy}
              onCheckedChange={(on) => setRemoveFolder(on === true)}
            />
            {S.customProviders.deleteFolder}
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {S.customProviders.deleteConfirmButton}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>
              {S.customProviders.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={locked || problem !== null} onClick={() => void save()}>
            {busy ? S.customProviders.saving : S.customProviders.save}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-busy={checking}
            disabled={locked || !canCheck}
            onClick={() => void runCheck()}
          >
            {checking ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
            {S.customProviders.check}
          </Button>
          {draft.id !== null ? (
            <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={locked} onClick={() => setConfirmDelete(true)}>
              {S.customProviders.deleteProvider}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
