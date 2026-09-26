/**
 * Настройки в окне (кусок 1.10 плана окна, `resumeRate` — кусок 3.6):
 * `silenceThresholdMs`, `messageRate`, `resumeRate`, `autoLaunch`, `theme`,
 * `fontFamily`, `fontSize`. Заблокированное переменной окружения поле
 * неактивно и подписано «задано HARNAS_…»; сохранение — по одному полю через
 * `settings.set`, ошибка — под полем.
 */

import { useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { HarnasConfig } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { THEME_NAMES } from '../../theme/apply-theme.js';

export interface SettingsDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  onOpenChange: (open: boolean) => void;
  /** Зовётся после каждого удачного сохранения — окно применяет тему сразу, без перезапуска. */
  onConfigChange?: (config: HarnasConfig) => void;
}

type FieldErrors = Partial<Record<keyof HarnasConfig, string>>;

function FieldRow({ label, lockedBy, error, children }: { label: string; lockedBy: string | null; error: string | undefined; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>
        {label}
        {lockedBy !== null ? <span className="text-[var(--h-muted)]"> (задано {lockedBy})</span> : null}
      </span>
      {children}
      {error !== undefined ? <span className="text-xs text-[var(--h-red)]">{error}</span> : null}
    </label>
  );
}

export function SettingsDialog({ open, bridge, onOpenChange, onConfigChange }: SettingsDialogProps): JSX.Element {
  const [config, setConfig] = useState<HarnasConfig | null>(null);
  const [locked, setLocked] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    bridge
      .call('settings.get', {})
      .then((result) => {
        setConfig(result.config);
        setLocked(result.locked);
        setErrors({});
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [open, bridge]);

  const save = async (key: keyof HarnasConfig, value: string): Promise<void> => {
    try {
      const result = await bridge.call('settings.set', { key, value });
      setConfig(result.config);
      onConfigChange?.(result.config);
      // Не `{ [key]: undefined }` — под `exactOptionalPropertyTypes` это другое
      // значение, чем отсутствие ключа; убираем ключ явно.
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      setErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--h-base)] p-4 text-[var(--h-text)] shadow-lg">
          <Dialog.Title className="text-sm font-medium">Настройки</Dialog.Title>
          {loadError !== null ? <p className="mt-2 text-xs text-[var(--h-red)]">{loadError}</p> : null}
          {config !== null ? (
            <div className="mt-3 flex flex-col gap-3">
              <FieldRow label="Порог молчания, мс" lockedBy={locked.silenceThresholdMs ?? null} error={errors.silenceThresholdMs}>
                <input
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={String(config.silenceThresholdMs)}
                  disabled={locked.silenceThresholdMs !== undefined}
                  onBlur={(event) => void save('silenceThresholdMs', event.target.value)}
                />
              </FieldRow>

              <FieldRow label="Потолок писем в час" lockedBy={locked.messageRate ?? null} error={errors.messageRate}>
                <input
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={String(config.messageRate)}
                  disabled={locked.messageRate !== undefined}
                  onBlur={(event) => void save('messageRate', event.target.value)}
                />
              </FieldRow>

              <FieldRow label="Подъёмов сессии в час (0…60)" lockedBy={locked.resumeRate ?? null} error={errors.resumeRate}>
                <input
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={String(config.resumeRate)}
                  disabled={locked.resumeRate !== undefined}
                  onBlur={(event) => void save('resumeRate', event.target.value)}
                />
              </FieldRow>

              <FieldRow label="Автозапуск pending-сессий" lockedBy={locked.autoLaunch ?? null} error={errors.autoLaunch}>
                <input
                  type="checkbox"
                  defaultChecked={config.autoLaunch}
                  disabled={locked.autoLaunch !== undefined}
                  onChange={(event) => void save('autoLaunch', event.target.checked ? 'true' : 'false')}
                />
              </FieldRow>

              <FieldRow label="Тема" lockedBy={locked.theme ?? null} error={errors.theme}>
                <select
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={config.theme}
                  disabled={locked.theme !== undefined}
                  onChange={(event) => void save('theme', event.target.value)}
                >
                  {THEME_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </FieldRow>

              <FieldRow label="Корень worktree" lockedBy={locked.worktreeRoot ?? null} error={errors.worktreeRoot}>
                <input
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={config.worktreeRoot}
                  disabled={locked.worktreeRoot !== undefined}
                  onBlur={(event) => void save('worktreeRoot', event.target.value)}
                />
              </FieldRow>

              <FieldRow label="Шрифт терминала" lockedBy={locked.fontFamily ?? null} error={errors.fontFamily}>
                <input
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={config.fontFamily}
                  disabled={locked.fontFamily !== undefined}
                  onBlur={(event) => void save('fontFamily', event.target.value)}
                />
              </FieldRow>

              <FieldRow label="Кегль терминала (8…32)" lockedBy={locked.fontSize ?? null} error={errors.fontSize}>
                <input
                  className="rounded border border-[var(--h-overlay)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                  defaultValue={String(config.fontSize)}
                  disabled={locked.fontSize !== undefined}
                  onBlur={(event) => void save('fontSize', event.target.value)}
                />
              </FieldRow>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <button type="button" className="rounded bg-[var(--h-blue)] px-3 py-1 text-sm text-[var(--h-base)]">
                Готово
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
