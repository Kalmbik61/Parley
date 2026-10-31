/**
 * Настройки в окне (кусок 1.10 плана окна, `resumeRate` — кусок 3.6). Кусок
 * 1.4 плана «облик Orca», спека 4.10 — четыре секции вместо плоского списка:
 * «Вид» (`ui.json.appearance`, спека 4.7), «Терминал» и «Агенты» (прежние
 * поля `config.json` через `settings.set`, как раньше), «Уведомления»
 * (`ui.json.notifications` и переключатель острова `ui.json.island.enabled`, блок «Island» — звук и движение острова
 * `ui.json.island.sound`/`motion`, #9 §5, — а под ними — переключатель проверки новой версии `ui.json.checkForUpdates`, V6 плана релиза 0.1.0). Поля «Тема» (палитры ушедшего TUI) нет: тему
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
 *
 * С 2026-10-17 секции — столбец слева, справа панель содержимого со своей
 * прокруткой, диалог 46rem × 34rem в пределах окна. Причина — живая проверка:
 * горизонтальная полоса из семи вкладок обрезалась («…pearance»), а
 * прокручивался весь диалог вместе с полосой, а не содержимое секции.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ParleyConfig } from '@parley/core';
import { RESOURCE_LIMIT_BOUNDS, RESOURCE_LIMIT_KEYS } from '@parley/core/resource-policy';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import type { Appearance, ChatFold, IslandSoundPalette, IslandSoundUi, UiFile } from '../../../shared/ui-types.js';
import type { AssistantShortcutStatus } from '../../../shared/island.js';
import { playCue } from '../../island/sound/synth.js';
import { useUiStore, type SettingsSection } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Switch } from '../../ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group.js';
import { VoiceSettings } from '../../voice/VoiceSettings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { AssistantSettings } from './AssistantSettings.js';
import { ProjectsSettings } from './ProjectsSettings.js';
import { ProvidersSettings } from './ProvidersSettings.js';
import { TelegramSettings } from './TelegramSettings.js';
import { ShortcutField } from './ShortcutField.js';

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
  assistant: S.settings.sections.assistant,
  providers: S.settings.sections.providers,
  projects: S.settings.sections.projects,
};

const SECTION_ORDER: readonly SettingsSection[] = ['appearance', 'terminal', 'agents', 'projects', 'providers', 'notifications', 'browser', 'voice', 'assistant'];

type FieldErrors = Partial<Record<keyof ParleyConfig, string>>;

/**
 * Режимы одобрений пишущих ролей Codex в порядке показа. Значения ядра (`CODEX_WRITE_APPROVALS_VALUES`) отсюда не
 * импортируются: индекс `@parley/core` тянет в рендерер код с `fs`, а тип берётся из `ParleyConfig`.
 */
const CODEX_WRITE_MODES: readonly ParleyConfig['codexWriteApprovals'][] = ['auto', 'parley', 'terminal'];

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

const ISLAND_PALETTES: readonly IslandSoundPalette[] = ['soft', 'crystal', 'warm'];

/**
 * Пример палитры острова (#9 §5, S5). Settings живёт в главном окне, а графа острова тут нет: пример играет синтез
 * острова (`island/sound/synth.ts`) в свой контекст окна — один на окно, как у `attention/chime.ts`, — через усиление
 * громкости острова (v²). Звучит `done`, как в прототипе. Сбой Web Audio — одно предупреждение в консоль на окно.
 */
let preview: { context: AudioContext; output: GainNode } | null = null;
let previewWarned = false;
function warnPreview(error: unknown): void {
  if (previewWarned) return;
  previewWarned = true;
  console.warn('[parley] palette preview failed', error);
}

function playPalettePreview(palette: IslandSoundPalette, volume: number): void {
  // 0 % — то же, что выключено: узлов не создаём (S4).
  if (volume === 0) return;
  try {
    if (preview === null) {
      const context = new AudioContext();
      const output = context.createGain();
      output.connect(context.destination);
      preview = { context, output };
    }
    const { context, output } = preview;
    if (context.state === 'suspended') void context.resume().catch(warnPreview);
    output.gain.value = volume ** 2;
    playCue(context, output, 'done', palette);
  } catch (error: unknown) {
    warnPreview(error);
  }
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
  const [islandShortcutStatus, setIslandShortcutStatus] = useState<AssistantShortcutStatus>({ accelerator: null, ok: true });

  const ui = useUiStore((state) => state.ui);
  const uiLoaded = useUiStore((state) => state.uiLoaded);
  const settingsSection = useUiStore((state) => state.settingsSection);
  const setAppearance = useUiStore((state) => state.setAppearance);
  const patchUi = useUiStore((state) => state.patchUi);
  const hostStatus = useHostStore((state) => state.status);
  const refreshIslandShortcut = (): void => {
    void bridge.app.islandShortcut?.().then(setIslandShortcutStatus).catch(() => {});
  };

  useEffect(() => {
    if (open) setSection(settingsSection);
  }, [open, settingsSection]);

  useEffect(() => {
    if (!open) return;
    void bridge.app.islandShortcut?.().then(setIslandShortcutStatus).catch(() => {});
  }, [open, bridge]);

  useEffect(() => {
    if (!open || !uiLoaded) return;
    void bridge.app.islandShortcut?.().then(setIslandShortcutStatus).catch(() => {});
  }, [open, uiLoaded, ui.island.pendingHotkey, ui.island.enabled, bridge]);

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
        console.warn('[parley] settings.get', 'failed');
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
      console.warn('[parley] settings.set', key, 'failed');
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

  // `sound` main сливает целиком (`mergeUiPatch` — один уровень вглубь `island`), поэтому патч несёт весь объект звука.
  // Его пишет только рендерер, копия в зеркале не устаревает — не то что `displayId` и `anchor`.
  const patchIslandSound = (patch: Partial<IslandSoundUi>): void => {
    patchUi({ island: { sound: { ...ui.island.sound, ...patch } } } as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>);
  };

  const chooseIslandPalette = (palette: IslandSoundPalette): void => {
    patchIslandSound({ palette });
    playPalettePreview(palette, ui.island.sound.volume);
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
      {/* Высота фиксирована (в пределах окна): секции разной высоты не дёргают размер диалога при переключении;
          в окне 800×500 диалог ограничен 100dvh-2rem. */}
      <DialogContent aria-describedby={undefined} className="h-[min(34rem,calc(100dvh-2rem))] w-[46rem] max-w-[calc(100vw-2rem)]">
        <DialogTitle>{S.settings.title}</DialogTitle>
        {loadError !== null ? <p className="text-xs text-destructive">{loadError}</p> : null}

        {/* min-h-0 flex-1: прокручивается только правая панель, а не вся секция вкладок. */}
        <Tabs
          value={section}
          onValueChange={(value) => setSection(value as SettingsSection)}
          orientation="vertical"
          className="flex min-h-0 flex-1 gap-5"
        >
          <TabsList
            aria-label={S.settings.title}
            className="flex h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-0.5 self-start rounded-none bg-transparent p-0"
          >
            {SECTION_ORDER.map((key) => (
              <TabsTrigger
                key={key}
                value={key}
                className="justify-start rounded-md px-3 py-1.5 text-sm data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                {SECTION_LABELS[key]}
              </TabsTrigger>
            ))}
          </TabsList>

          <div data-testid="settings-pane" className="min-h-0 flex-1 overflow-y-auto pr-1">
          <TabsContent value="appearance" className="mt-0 flex flex-col gap-4">
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
            {uiLoaded ? (
              <div className="flex flex-col gap-1 text-sm">
                <span id="finished-turns-label">{S.settings.finishedTurns}</span>
                <ToggleGroup
                  type="single"
                  aria-labelledby="finished-turns-label"
                  value={ui.chatFold}
                  onValueChange={(value) => {
                    if (value !== '') patchUi({ chatFold: value as ChatFold });
                  }}
                >
                  <ToggleGroupItem value="off">{S.settings.finishedTurnsExpanded}</ToggleGroupItem>
                  <ToggleGroupItem value="replies">{S.settings.finishedTurnsFold}</ToggleGroupItem>
                  <ToggleGroupItem value="final">{S.settings.finishedTurnsFinal}</ToggleGroupItem>
                </ToggleGroup>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="terminal" className="mt-0 flex flex-col gap-3">
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

          <TabsContent value="agents" className="mt-0 flex flex-col gap-3">
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

                {/* Ключа нет у хоста, оставшегося от прежней версии: поле показало бы «undefined», а `settings.set` такой
                    хост отклонил бы. */}
                {config.sleepAfterMinutes !== undefined ? (
                  <FieldRow
                    label={S.settings.sleepAfterMinutes}
                    lockedBy={locked.sleepAfterMinutes ?? null}
                    error={errors.sleepAfterMinutes}
                  >
                    <Input
                      defaultValue={String(config.sleepAfterMinutes)}
                      disabled={locked.sleepAfterMinutes !== undefined}
                      onBlur={(event) => void save('sleepAfterMinutes', event.target.value)}
                    />
                  </FieldRow>
                ) : null}

                {/* Потолок машины и порог сна под давлением (спека ёмкости 4.4). Ключей нет у хоста, оставшегося от прежней
                    версии: поля показали бы «undefined», а `settings.set` такой хост отклонил бы. */}
                {config.sleepUnderPressureMinutes !== undefined ? (
                  <FieldRow
                    label={S.settings.sleepUnderPressureMinutes}
                    lockedBy={locked.sleepUnderPressureMinutes ?? null}
                    error={errors.sleepUnderPressureMinutes}
                  >
                    <Input
                      defaultValue={String(config.sleepUnderPressureMinutes)}
                      disabled={locked.sleepUnderPressureMinutes !== undefined}
                      onBlur={(event) => void save('sleepUnderPressureMinutes', event.target.value)}
                    />
                  </FieldRow>
                ) : null}

                {config.machineConcurrent !== undefined ? (
                  <>
                    <FieldRow
                      label={S.settings.machineConcurrent}
                      lockedBy={locked.machineConcurrent ?? null}
                      error={errors.machineConcurrent}
                    >
                      <Input
                        defaultValue={String(config.machineConcurrent)}
                        disabled={locked.machineConcurrent !== undefined}
                        onBlur={(event) => void save('machineConcurrent', event.target.value)}
                      />
                    </FieldRow>
                    <span className="text-xs text-muted-foreground">{S.settings.machineConcurrentHint}</span>
                    {/* Потолок без сна опасен: простаивающие агенты слотов не отдают (спека 4.2, «Включение»). Внутри проверки
                        ключа, иначе у хоста прежней версии `undefined !== 'off'` показал бы предупреждение про потолок, которого нет. */}
                    {config.machineConcurrent !== 'off' && config.sleepAfterMinutes === 0 ? (
                      <span role="status" className="text-xs text-status-warning-text">
                        {S.settings.machineLimitWithoutSleep}
                      </span>
                    ) : null}
                  </>
                ) : null}

                {/* Ключа нет у хоста, оставшегося от прежней версии: он lean-запуск не знает, переключатель врал бы. */}
                {config.leanAgents !== undefined ? (
                  <>
                    <label className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {S.settings.leanAgents}
                        {locked.leanAgents !== undefined ? (
                          <span className="text-muted-foreground"> {S.settings.lockedBy(locked.leanAgents)}</span>
                        ) : null}
                      </span>
                      <Switch
                        aria-label={S.settings.leanAgents}
                        checked={config.leanAgents}
                        disabled={locked.leanAgents !== undefined}
                        onCheckedChange={(checked) => void save('leanAgents', checked ? 'true' : 'false')}
                      />
                    </label>
                    <span className="text-xs text-muted-foreground">{S.settings.leanAgentsHint}</span>
                    {errors.leanAgents !== undefined ? (
                      <span className="text-xs text-destructive">{errors.leanAgents}</span>
                    ) : null}
                  </>
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

                {config.skillNavigator !== undefined ? (
                  <>
                    <label className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {S.settings.skillNavigator}
                        {locked.skillNavigator !== undefined ? (
                          <span className="text-muted-foreground"> {S.settings.lockedBy(locked.skillNavigator)}</span>
                        ) : null}
                      </span>
                      <Switch
                        aria-label={S.settings.skillNavigator}
                        checked={config.skillNavigator}
                        disabled={locked.skillNavigator !== undefined}
                        onCheckedChange={checked => void save('skillNavigator', checked ? 'true' : 'false')}
                      />
                    </label>
                    <span className="text-xs text-muted-foreground">{S.settings.skillNavigatorHint}</span>
                    {errors.skillNavigator !== undefined ? (
                      <span className="text-xs text-destructive">{errors.skillNavigator}</span>
                    ) : null}
                  </>
                ) : null}

                {/* Ключа нет у хоста, оставшегося от прежней версии (там булев `codexApprovals`): `settings.set` его бы
                    отклонил, группа врала бы. */}
                {config.codexWriteApprovals !== undefined ? (
                  <>
                    <span className="text-sm">
                      {S.settings.codexWriteApprovals}
                      {locked.codexWriteApprovals !== undefined ? (
                        <span className="text-muted-foreground"> {S.settings.lockedBy(locked.codexWriteApprovals)}</span>
                      ) : null}
                    </span>
                    {/* Подписи длинные (спека 5.2): варианты столбцом на всю ширину, а не пилюлей в одну строку. */}
                    <ToggleGroup
                      type="single"
                      aria-label={S.settings.codexWriteApprovals}
                      value={config.codexWriteApprovals}
                      disabled={locked.codexWriteApprovals !== undefined}
                      className="w-full flex-col items-stretch rounded-[18px]"
                      onValueChange={(value) => {
                        // Повторный клик по выбранному варианту Radix сообщает пустой строкой — режим не снимается.
                        if (value !== '') void save('codexWriteApprovals', value);
                      }}
                    >
                      {CODEX_WRITE_MODES.map((mode) => (
                        <ToggleGroupItem
                          key={mode}
                          value={mode}
                          className="h-auto justify-start whitespace-normal border-l-0 border-t text-left first:border-t-0"
                        >
                          {S.settings.codexWriteApprovalsOptions[mode]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    {config.codexWriteApprovals === 'parley' ? (
                      <span className="text-xs text-muted-foreground">{S.settings.codexWriteApprovalsHookHint}</span>
                    ) : null}
                    {errors.codexWriteApprovals !== undefined ? (
                      <span className="text-xs text-destructive">{errors.codexWriteApprovals}</span>
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

                {/* Хост прежней версии порогов не знает: подраздел показывает только то, что хост отдал. */}
                {RESOURCE_LIMIT_KEYS.every((key) => typeof config[key] === 'number') ? (
                  <section aria-label={S.settings.limits.heading} className="flex flex-col gap-2 border-t pt-3">
                    <h3 className="m-0 text-sm font-medium">{S.settings.limits.heading}</h3>
                    <p className="m-0 text-xs text-muted-foreground">{S.settings.limits.hint}</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                      {RESOURCE_LIMIT_KEYS.filter((key) => String(key) !== 'spawnDepth').map((key) => (
                        <FieldRow
                          key={key}
                          label={`${S.settings.limits[key]} (${S.settings.limits.range(RESOURCE_LIMIT_BOUNDS[key].min, RESOURCE_LIMIT_BOUNDS[key].max)})`}
                          lockedBy={locked[key] ?? null}
                          error={errors[key]}
                        >
                          <Input
                            inputMode="numeric"
                            defaultValue={String(config[key])}
                            disabled={locked[key] !== undefined}
                            onBlur={(event) => void save(key, event.target.value)}
                          />
                        </FieldRow>
                      ))}
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="notifications" className="mt-0 flex flex-col gap-3">
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
                <NotificationRow
                  label={S.settings.notifyFinishedSound}
                  checked={ui.notifications.finishedSound}
                  onCheckedChange={(checked) => toggleNotification('finishedSound', checked)}
                />
                {/*
                  Патч — только `enabled`, не `{ ...ui.island, enabled }`: `displayId` и `anchor` main пишет в
                  ui.json сам, мимо рендерера, так что копия `ui.island` здесь устарела, а целый объект перезаписал бы их.
                  Main сливает `island` на один уровень вглубь (`mergeUiPatch`), частичного патча хватает.
                */}
                <NotificationRow
                  label={S.settings.notifyIsland}
                  checked={ui.island.enabled}
                  onCheckedChange={(checked) =>
                    patchUi({ island: { enabled: checked } } as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>)
                  }
                />
                <div className="flex flex-col gap-2 rounded-md border p-3">
                  <span className="text-sm font-medium">{S.assistant.settings.islandShortcut}</span>
                  {ui.island.pendingHotkey === null ? (
                    <Button type="button" variant="outline" onClick={() => patchUi({ island: { pendingHotkey: 'Control+Alt+I' } } as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>)}>
                      {S.assistant.settings.islandShortcutEnable}
                    </Button>
                  ) : <ShortcutField
                    value={ui.island.pendingHotkey}
                    label={S.assistant.settings.islandShortcut}
                    onChange={(pendingHotkey) => {
                      patchUi({ island: { pendingHotkey } } as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>);
                      refreshIslandShortcut();
                    }}
                    onRecording={(recording) => bridge.app.islandShortcutSuspend?.(recording)}
                  />}
                  {ui.island.pendingHotkey !== null ? <Button type="button" variant="ghost" className="self-start" onClick={() => {
                    patchUi({ island: { pendingHotkey: null } } as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>);
                    refreshIslandShortcut();
                  }}>{S.assistant.settings.islandShortcutOff}</Button> : null}
                  {!islandShortcutStatus.ok ? <p role="status" className="text-xs text-destructive">{islandShortcutStatus.accelerator === ui.assistant.hotkey ? S.assistant.settings.shortcutConflictAssistant : S.assistant.settings.shortcutTaken}</p> : null}
                </div>
                {/* Звук и движение острова (#9 §5). Звук запросов и Done острова включают два переключателя звука выше. */}
                <section aria-label={S.settings.island.heading} className="flex flex-col gap-2 rounded-md border p-3">
                  <h3 className="m-0 text-sm font-medium">{S.settings.island.heading}</h3>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{S.settings.island.palette}</span>
                    <ToggleGroup
                      type="single"
                      aria-label={S.settings.island.palette}
                      value={ui.island.sound.palette}
                      onValueChange={(value) => {
                        if (value !== '') chooseIslandPalette(value as IslandSoundPalette);
                      }}
                    >
                      {ISLAND_PALETTES.map((palette) => (
                        <ToggleGroupItem key={palette} value={palette}>
                          {S.settings.island.palettes[palette]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{S.settings.island.volume}</span>
                    <span className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        aria-label={S.settings.island.volume}
                        value={Math.round(ui.island.sound.volume * 100)}
                        onChange={(event) => patchIslandSound({ volume: Number(event.target.value) / 100 })}
                        className="w-32"
                      />
                      <span className="w-10 text-right tabular-nums text-muted-foreground">
                        {S.settings.island.volumeValue(Math.round(ui.island.sound.volume * 100))}
                      </span>
                    </span>
                  </div>
                  <NotificationRow
                    label={S.settings.island.interfaceSounds}
                    checked={ui.island.sound.ui}
                    onCheckedChange={(checked) => patchIslandSound({ ui: checked })}
                  />
                  <NotificationRow
                    label={S.settings.island.reduceMotion}
                    checked={ui.island.motion === 'reduce'}
                    onCheckedChange={(checked) =>
                      patchUi({ island: { motion: checked ? 'reduce' : 'system' } } as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>)
                    }
                  />
                </section>
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
            {config !== null ? (
              <TelegramSettings bridge={bridge} config={config} locked={locked} save={save} hostMethods={hostMethods(hostStatus)} />
            ) : null}
          </TabsContent>

          <TabsContent value="browser" className="mt-0 flex flex-col gap-3">
            <Button type="button" variant="outline" className="self-start" onClick={clearBrowserData}>
              {S.settings.clearBrowserData}
            </Button>
            {/* Общий выключатель агентов (спека браузера 4.8): строка та же, что у уведомлений, а смысл свой — доступ агента. */}
            {uiLoaded ? (
              <>
                <NotificationRow
                  label={S.settings.letAgentsUseBrowser}
                  checked={ui.browser.agentsAllowed}
                  onCheckedChange={(checked) => patchUi({ browser: { ...ui.browser, agentsAllowed: checked } })}
                />
                <p className="text-xs text-muted-foreground">{S.settings.letAgentsUseBrowserHint}</p>
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="voice" className="mt-0">{uiLoaded ? <VoiceSettings /> : null}</TabsContent>

          <TabsContent value="projects" className="mt-0"><ProjectsSettings bridge={bridge} /></TabsContent>

          <TabsContent value="providers" className="mt-0"><ProvidersSettings /></TabsContent>

          <TabsContent value="assistant" className="mt-0">{uiLoaded ? <AssistantSettings /> : null}</TabsContent>
          </div>
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
