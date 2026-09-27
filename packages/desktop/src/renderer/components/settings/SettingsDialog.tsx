/**
 * Настройки в окне (кусок 1.10 плана окна, `resumeRate` — кусок 3.6). Кусок
 * 1.4 плана «облик Orca», спека 4.10 — четыре секции вместо плоского списка:
 * «Вид» (`ui.json.appearance`, спека 4.7), «Терминал» и «Агенты» (прежние
 * поля `config.json` через `settings.set`, как раньше), «Уведомления»
 * (`ui.json.notifications`). Поле «Тема» (палитра TUI, `config.theme`) окно
 * больше не читает и не показывает (спека 4.9 — её меняет только сам TUI).
 *
 * Заблокированное переменной окружения поле неактивно и подписано «задано
 * HARNAS_…»; поля терминала/агентов сохраняются по одному через
 * `settings.set`, ошибка — под полем — то же самое, что и раньше, только
 * разложено по вкладкам.
 *
 * «Вид» и «Уведомления» с куска 2.3 читают и пишут зеркало `store/ui.ts`
 * (`setAppearance`/`patchUi`), а не грузят `ui.json` сами: то же зеркало,
 * что и у заголовка окна и сайдбаров — без этого две копии в разных
 * компонентах могли бы разойтись (см. комментарий у `patchUi`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { HarnasConfig } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import type { Appearance, UiFile } from '../../../shared/ui-types.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Switch } from '../../ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group.js';

export interface SettingsDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  onOpenChange: (open: boolean) => void;
  /** Зовётся после каждого удачного сохранения — окно применяет настройку сразу, без перезапуска. */
  onConfigChange?: (config: HarnasConfig) => void;
}

/** Четыре секции спеки 4.10, в порядке таблицы. */
type SettingsSection = 'appearance' | 'terminal' | 'agents' | 'notifications';

const SECTION_LABELS: Record<SettingsSection, string> = {
  appearance: 'Вид',
  terminal: 'Терминал',
  agents: 'Агенты',
  notifications: 'Уведомления',
};

const SECTION_ORDER: readonly SettingsSection[] = ['appearance', 'terminal', 'agents', 'notifications'];

type FieldErrors = Partial<Record<keyof HarnasConfig, string>>;

function FieldRow({
  label,
  lockedBy,
  error,
  children,
}: {
  label: string;
  lockedBy: string | null;
  error: string | undefined;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>
        {label}
        {lockedBy !== null ? <span className="text-muted-foreground"> (задано {lockedBy})</span> : null}
      </span>
      {children}
      {error !== undefined ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  );
}

/** Строка-переключатель секции «Уведомления»: подпись слева, `ui/switch` справа. */
function NotificationRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export function SettingsDialog({ open, bridge, onOpenChange, onConfigChange }: SettingsDialogProps): JSX.Element {
  const [section, setSection] = useState<SettingsSection>('appearance');
  const [config, setConfig] = useState<HarnasConfig | null>(null);
  const [locked, setLocked] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const ui = useUiStore((state) => state.ui);
  const uiLoaded = useUiStore((state) => state.uiLoaded);
  const setAppearance = useUiStore((state) => state.setAppearance);
  const patchUi = useUiStore((state) => state.patchUi);

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

  // Стор сам пишет `ui.json` (`setAppearance` → `app.setAppearance`, кусок
  // 2.3) — отдельного `saveUi` для вида нет (тест 1 куска 1.4/тест 11 куска
  // 2.3: «Тёмная» зовёт только `setAppearance('dark')»).
  const changeAppearance = (mode: Appearance): void => {
    setAppearance(mode);
  };

  const toggleNotification = (key: keyof UiFile['notifications'], value: boolean): void => {
    patchUi({ notifications: { ...ui.notifications, [key]: value } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-[26rem] max-w-[26rem]">
        <DialogTitle>Настройки</DialogTitle>
        {loadError !== null ? <p className="text-xs text-destructive">{loadError}</p> : null}

        <Tabs value={section} onValueChange={(value) => setSection(value as SettingsSection)}>
          <TabsList>
            {SECTION_ORDER.map((key) => (
              <TabsTrigger key={key} value={key}>
                {SECTION_LABELS[key]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="appearance">
            {uiLoaded ? (
              <ToggleGroup
                type="single"
                variant="outline"
                value={ui.appearance}
                onValueChange={(value) => {
                  if (value !== '') changeAppearance(value as Appearance);
                }}
              >
                <ToggleGroupItem value="system">Система</ToggleGroupItem>
                <ToggleGroupItem value="dark">Тёмная</ToggleGroupItem>
                <ToggleGroupItem value="light">Светлая</ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </TabsContent>

          <TabsContent value="terminal" className="flex flex-col gap-3">
            {config !== null ? (
              <>
                <FieldRow label="Шрифт терминала" lockedBy={locked.fontFamily ?? null} error={errors.fontFamily}>
                  <Input
                    defaultValue={config.fontFamily}
                    disabled={locked.fontFamily !== undefined}
                    onBlur={(event) => void save('fontFamily', event.target.value)}
                  />
                </FieldRow>

                <FieldRow label="Кегль терминала (8…32)" lockedBy={locked.fontSize ?? null} error={errors.fontSize}>
                  <Input
                    defaultValue={String(config.fontSize)}
                    disabled={locked.fontSize !== undefined}
                    onBlur={(event) => void save('fontSize', event.target.value)}
                  />
                </FieldRow>
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="agents" className="flex flex-col gap-3">
            {config !== null ? (
              <>
                <FieldRow
                  label="Порог молчания, мс"
                  lockedBy={locked.silenceThresholdMs ?? null}
                  error={errors.silenceThresholdMs}
                >
                  <Input
                    defaultValue={String(config.silenceThresholdMs)}
                    disabled={locked.silenceThresholdMs !== undefined}
                    onBlur={(event) => void save('silenceThresholdMs', event.target.value)}
                  />
                </FieldRow>

                <FieldRow label="Потолок писем в час" lockedBy={locked.messageRate ?? null} error={errors.messageRate}>
                  <Input
                    defaultValue={String(config.messageRate)}
                    disabled={locked.messageRate !== undefined}
                    onBlur={(event) => void save('messageRate', event.target.value)}
                  />
                </FieldRow>

                <FieldRow
                  label="Подъёмов сессии в час (0…60)"
                  lockedBy={locked.resumeRate ?? null}
                  error={errors.resumeRate}
                >
                  <Input
                    defaultValue={String(config.resumeRate)}
                    disabled={locked.resumeRate !== undefined}
                    onBlur={(event) => void save('resumeRate', event.target.value)}
                  />
                </FieldRow>

                <label className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    Автозапуск pending-сессий
                    {locked.autoLaunch !== undefined ? (
                      <span className="text-muted-foreground"> (задано {locked.autoLaunch})</span>
                    ) : null}
                  </span>
                  <Switch
                    checked={config.autoLaunch}
                    disabled={locked.autoLaunch !== undefined}
                    onCheckedChange={(checked) => void save('autoLaunch', checked ? 'true' : 'false')}
                  />
                </label>
                {errors.autoLaunch !== undefined ? (
                  <span className="text-xs text-destructive">{errors.autoLaunch}</span>
                ) : null}

                <FieldRow label="Корень worktree" lockedBy={locked.worktreeRoot ?? null} error={errors.worktreeRoot}>
                  <Input
                    defaultValue={config.worktreeRoot}
                    disabled={locked.worktreeRoot !== undefined}
                    onBlur={(event) => void save('worktreeRoot', event.target.value)}
                  />
                </FieldRow>
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="notifications" className="flex flex-col gap-3">
            {uiLoaded ? (
              <>
                <NotificationRow
                  label="нужен ты"
                  checked={ui.notifications.needsYou}
                  onCheckedChange={(checked) => toggleNotification('needsYou', checked)}
                />
                <NotificationRow
                  label="закончил ход"
                  checked={ui.notifications.finished}
                  onCheckedChange={(checked) => toggleNotification('finished', checked)}
                />
                <NotificationRow
                  label="письмо тебе"
                  checked={ui.notifications.mail}
                  onCheckedChange={(checked) => toggleNotification('mail', checked)}
                />
                <NotificationRow
                  label="звук"
                  checked={ui.notifications.sound}
                  onCheckedChange={(checked) => toggleNotification('sound', checked)}
                />
              </>
            ) : null}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Готово</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
