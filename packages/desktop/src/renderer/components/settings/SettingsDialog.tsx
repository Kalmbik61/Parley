/**
 * Настройки в окне (кусок 1.10 плана окна, `resumeRate` — кусок 3.6). Кусок
 * 1.4 плана «облик Orca», спека 4.10 — четыре секции вместо плоского списка:
 * «Вид» (`ui.json.appearance`, спека 4.7), «Терминал» и «Агенты» (прежние
 * поля `config.json` через `settings.set`, как раньше), «Уведомления»
 * (`ui.json.notifications`, а под ними — переключатель проверки новой версии
 * `ui.json.checkForUpdates`, V6 плана релиза 0.1.0). Поля «Тема» (палитры ушедшего TUI) нет: тему
 * окна задаёт «Вид» (спека 4.9).
 *
 * Заблокированное переменной окружения поле неактивно и подписано «задано
 * PARLEY_…» (или прежним HARNAS_…); поля терминала/агентов сохраняются по одному через
 * `settings.set`, ошибка — под полем — то же самое, что и раньше, только
 * разложено по вкладкам.
 *
 * «Вид» и «Уведомления» с куска 2.3 читают и пишут зеркало `store/ui.ts`
 * (`setAppearance`/`patchUi`), а не грузят `ui.json` сами: то же зеркало,
 * что и у заголовка окна и сайдбаров — без этого две копии в разных
 * компонентах могли бы разойтись (см. комментарий у `patchUi`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ParleyConfig } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import type { Appearance, UiFile } from '../../../shared/ui-types.js';
import { useUiStore, type SettingsSection } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Switch } from '../../ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group.js';
import { VoiceSettings } from '../../voice/VoiceSettings.js';

export interface SettingsDialogProps {
  open: boolean;
  bridge: ParleyBridge;
  onOpenChange: (open: boolean) => void;
  /** Зовётся после каждого удачного сохранения — окно применяет настройку сразу, без перезапуска. */
  onConfigChange?: (config: ParleyConfig) => void;
}

const SECTION_LABELS: Record<SettingsSection, string> = {
  appearance: S.settings.sections.appearance,
  terminal: S.settings.sections.terminal,
  agents: S.settings.sections.agents,
  notifications: S.settings.sections.notifications,
  browser: S.settings.sections.browser,
  voice: S.settings.sections.voice,
};

const SECTION_ORDER: readonly SettingsSection[] = ['appearance', 'terminal', 'agents', 'notifications', 'browser', 'voice'];

type FieldErrors = Partial<Record<keyof ParleyConfig, string>>;

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
        {lockedBy !== null ? <span className="text-muted-foreground"> {S.settings.lockedBy(lockedBy)}</span> : null}
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
  const [config, setConfig] = useState<ParleyConfig | null>(null);
  const [locked, setLocked] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const ui = useUiStore((state) => state.ui);
  const uiLoaded = useUiStore((state) => state.uiLoaded);
  const settingsSection = useUiStore((state) => state.settingsSection);
  const setAppearance = useUiStore((state) => state.setAppearance);
  const patchUi = useUiStore((state) => state.patchUi);

  useEffect(() => {
    if (open) setSection(settingsSection);
  }, [open, settingsSection]);

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
      .catch((err: unknown) => {
        console.warn('[parley] settings.get', err);
        setLoadError(errorText(decodeIpcError(err).code, S.errors.actions.loadSettings));
      });
  }, [open, bridge]);

  const save = async (key: keyof ParleyConfig, value: string): Promise<void> => {
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
      console.warn('[parley] settings.set', key, err);
      const message = errorText(decodeIpcError(err).code, S.errors.actions.saveSettings);
      setErrors((prev) => ({ ...prev, [key]: message }));
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

  // Куки, хранилища и кеш раздела встроенного браузера (кусок 9.1); сообщение main — только в консоль.
  const clearBrowserData = (): void => {
    bridge.browser.clearData().catch((err: unknown) => {
      console.warn('[parley] browser.clearData', err);
      toast(errorText(decodeIpcError(err).code, S.errors.actions.clearBrowserData));
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 32rem: шесть вкладок (пятая «Browser» — кусок 9.1, шестая «Voice») в 28rem выходили за край диалога. */}
      <DialogContent aria-describedby={undefined} className="w-[32rem] max-w-[32rem]">
        <DialogTitle>{S.settings.title}</DialogTitle>
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
                value={ui.appearance}
                onValueChange={(value) => {
                  if (value !== '') changeAppearance(value as Appearance);
                }}
              >
                <ToggleGroupItem value="system">{S.settings.appearanceSystem}</ToggleGroupItem>
                <ToggleGroupItem value="dark">{S.settings.appearanceDark}</ToggleGroupItem>
                <ToggleGroupItem value="light">{S.settings.appearanceLight}</ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </TabsContent>

          <TabsContent value="terminal" className="flex flex-col gap-3">
            {config !== null ? (
              <>
                <FieldRow label={S.settings.terminalFont} lockedBy={locked.fontFamily ?? null} error={errors.fontFamily}>
                  <Input
                    defaultValue={config.fontFamily}
                    disabled={locked.fontFamily !== undefined}
                    onBlur={(event) => void save('fontFamily', event.target.value)}
                  />
                </FieldRow>

                <FieldRow label={S.settings.terminalFontSize} lockedBy={locked.fontSize ?? null} error={errors.fontSize}>
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
                  label={S.settings.silenceThreshold}
                  lockedBy={locked.silenceThresholdMs ?? null}
                  error={errors.silenceThresholdMs}
                >
                  <Input
                    defaultValue={String(config.silenceThresholdMs)}
                    disabled={locked.silenceThresholdMs !== undefined}
                    onBlur={(event) => void save('silenceThresholdMs', event.target.value)}
                  />
                </FieldRow>

                <FieldRow label={S.settings.messageCap} lockedBy={locked.messageRate ?? null} error={errors.messageRate}>
                  <Input
                    defaultValue={String(config.messageRate)}
                    disabled={locked.messageRate !== undefined}
                    onBlur={(event) => void save('messageRate', event.target.value)}
                  />
                </FieldRow>

                <FieldRow
                  label={S.settings.resumeRate}
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
                    {S.settings.autoLaunchPending}
                    {locked.autoLaunch !== undefined ? (
                      <span className="text-muted-foreground"> {S.settings.lockedBy(locked.autoLaunch)}</span>
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

                {/* Ключа нет у хоста, оставшегося от прежней версии: переключатель врал бы — ни поставить, ни
                    отключить скилл такой хост не умеет. */}
                {config.agentSkills !== undefined ? (
                  <>
                    <label className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {S.settings.agentSkills}
                        {locked.agentSkills !== undefined ? (
                          <span className="text-muted-foreground"> {S.settings.lockedBy(locked.agentSkills)}</span>
                        ) : null}
                      </span>
                      <Switch
                        checked={config.agentSkills}
                        disabled={locked.agentSkills !== undefined}
                        onCheckedChange={(checked) => void save('agentSkills', checked ? 'true' : 'false')}
                      />
                    </label>
                    {errors.agentSkills !== undefined ? (
                      <span className="text-xs text-destructive">{errors.agentSkills}</span>
                    ) : null}
                  </>
                ) : null}

                <FieldRow label={S.settings.worktreeRoot} lockedBy={locked.worktreeRoot ?? null} error={errors.worktreeRoot}>
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
                  label={S.settings.notifyNeedsYou}
                  checked={ui.notifications.needsYou}
                  onCheckedChange={(checked) => toggleNotification('needsYou', checked)}
                />
                <NotificationRow
                  label={S.settings.notifyFinished}
                  checked={ui.notifications.finished}
                  onCheckedChange={(checked) => toggleNotification('finished', checked)}
                />
                <NotificationRow
                  label={S.settings.notifyMail}
                  checked={ui.notifications.mail}
                  onCheckedChange={(checked) => toggleNotification('mail', checked)}
                />
                <NotificationRow
                  label={S.settings.notifySound}
                  checked={ui.notifications.sound}
                  onCheckedChange={(checked) => toggleNotification('sound', checked)}
                />
              </>
            ) : null}
            {/* Electron на macOS не сообщает о запрете уведомлений — подсказка стоит всегда (спека 7.4). */}
            <p className="text-xs text-muted-foreground">{S.settings.notificationsHint}</p>
            {/* Проверка новой версии (V6 плана релиза 0.1.0): строка та же, что у уведомлений, а смысл свой — сеть. */}
            {uiLoaded ? (
              <>
                <NotificationRow
                  label={S.settings.checkForUpdates}
                  checked={ui.checkForUpdates}
                  onCheckedChange={(checked) => patchUi({ checkForUpdates: checked })}
                />
                <p className="text-xs text-muted-foreground">{S.settings.checkForUpdatesHint}</p>
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="browser" className="flex flex-col gap-3">
            <Button type="button" variant="outline" className="self-start" onClick={clearBrowserData}>
              {S.settings.clearBrowserData}
            </Button>
          </TabsContent>

          <TabsContent value="voice">{uiLoaded ? <VoiceSettings /> : null}</TabsContent>
        </Tabs>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">{S.common.done}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
