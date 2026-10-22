/**
 * Тесты куска 1.4 плана «облик Orca» (спека 4.10, четыре секции): поля
 * терминала/агентов сохраняются как раньше (`settings.set`), «Вид» зовёт
 * `app.setAppearance` напрямую без отдельного `saveUi`, «Уведомления» зовут
 * `app.saveUi` с полным объектом `notifications`, и поля темы TUI в диалоге
 * больше нет вовсе (спека 4.9).
 *
 * `ui/tabs` (Radix) переключает секцию по `mousedown`, а не по `click`
 * (`TabsPrimitive.Trigger`), поэтому смена вкладки в тестах — `fireEvent.mouseDown`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { S } from '../../../shared/strings.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { useUiStore } from '../../store/ui.js';
import { SettingsDialog } from './SettingsDialog.js';

const CONFIG = {
  silenceThresholdMs: 30_000,
  channelPush: true,
  messageRate: 20,
  resumeRate: 6,
  autoLaunch: true,
  agentSkills: true,
  // Как у хоста по умолчанию (с 2026-10-06).
  skillNavigator: true,
  codexWriteApprovals: 'auto',
  // Как у хоста по умолчанию.
  leanAgents: true,
  fontFamily: 'Menlo',
  fontSize: 13,
  worktreeRoot: '~/.harnas/worktrees',
};

// Тест 10 куска 9.1 проверяет вызов тоста, а не его разметку.
vi.mock('sonner', () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
});

/**
 * Стор `store/ui.ts` — общий на файл (кусок 2.3): «Вид»/«Уведомления» читают
 * его зеркало вместо своего `loadUi()`, поэтому `init(bridge)` — тут же, а не
 * в компоненте, и на своём зеркале сбрасывается перед каждым тестом, чтобы
 * прошлый тест не оставил, например, `appearance: 'dark'`.
 */
function openSettings(bridge: ReturnType<typeof createFakeBridge>, locked: Record<string, string> = {}): void {
  bridge.setHandler('settings.get', () => ({ config: CONFIG, locked }));
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
  useUiStore.getState().init(bridge);
  render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
}

function switchTo(section: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name: section }));
}

describe('SettingsDialog — тест 1 куска 1.4: секции спеки 4.10', () => {
  it('поля темы TUI нет ни на одной секции', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    // «Вид» — активная секция по умолчанию.
    await screen.findByText('System');
    expect(screen.queryByText('Theme')).toBeNull();

    switchTo('Terminal');
    await screen.findByDisplayValue('Menlo');
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();

    switchTo('Agents');
    await screen.findByText('Worktree root');
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();

    switchTo('Notifications');
    await screen.findByLabelText('Sound');
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();
  });

  it('«Тёмная» зовёт app.setAppearance(\'dark\'), отдельного saveUi для вида нет', async () => {
    const bridge = createFakeBridge();
    const setAppearanceSpy = vi.spyOn(bridge.app, 'setAppearance');
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    fireEvent.click(await screen.findByText('Dark'));

    await waitFor(() => expect(setAppearanceSpy).toHaveBeenCalledWith('dark'));
    expect(saveUiSpy).not.toHaveBeenCalled();
  });

  it('переключатель «звук» зовёт app.saveUi({ notifications: { …, sound: false } })', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Notifications');
    const soundToggle = await screen.findByLabelText('Sound');
    fireEvent.click(soundToggle);

    await waitFor(() =>
      expect(saveUiSpy).toHaveBeenCalledWith({
        notifications: { ...DEFAULT_UI.notifications, sound: false },
      }),
    );
  });

  it('переключатель почты называет и упоминания — «Mail and mentions to you» (Parley 0.3.0): уведомление о @human идёт под ним', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Notifications');
    expect(await screen.findByLabelText('Mail and mentions to you')).toBeTruthy();
    expect(screen.queryByLabelText('mail to you')).toBeNull();
    fireEvent.click(screen.getByLabelText('Mail and mentions to you'));

    await waitFor(() =>
      expect(saveUiSpy).toHaveBeenCalledWith({
        notifications: { ...DEFAULT_UI.notifications, mail: false },
      }),
    );
  });

  it('тест 5 куска 4.3: в секции «Notifications» всегда видна подсказка про системные настройки', async () => {
    openSettings(createFakeBridge());
    switchTo('Notifications');
    expect(await screen.findByText('Not getting notifications? System Settings → Notifications → Parley')).toBeTruthy();
  });

  it('«Размер шрифта» зовёт settings.set', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', ({ value }) => ({ config: { ...CONFIG, fontSize: Number(value) } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Terminal');
    const fontSize = await screen.findByDisplayValue('13');
    fireEvent.change(fontSize, { target: { value: '16' } });
    fireEvent.blur(fontSize);

    await waitFor(() =>
      expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'fontSize', value: '16' } }),
    );
  });
});

describe('SettingsDialog — скилл агентов (кусок 10 плана комнат)', () => {
  it('на вкладке Agents есть переключатель «Install agent skills into projects», включённый по умолчанию', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    switchTo('Agents');
    const toggle = await screen.findByRole('switch', { name: 'Install agent skills into projects' });

    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('клик выключает: settings.set agentSkills с текстом false, включение — true', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', ({ key, value }) => ({ config: { ...CONFIG, [key]: value === 'true' } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    fireEvent.click(await screen.findByRole('switch', { name: 'Install agent skills into projects' }));
    await waitFor(() =>
      expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'agentSkills', value: 'false' } }),
    );

    // Ответ хоста применён: переключатель выключен, и следующий клик включает обратно.
    const toggle = await screen.findByRole('switch', { name: 'Install agent skills into projects' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'agentSkills', value: 'true' } }),
    );
  });

  it('ошибка хоста при сохранении — под переключателем, а не в консоли одной', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', () => {
      throw { code: 'bad_request', message: 'agentSkills: ожидается 0 или 1' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    fireEvent.click(await screen.findByRole('switch', { name: 'Install agent skills into projects' }));

    await waitFor(() => expect(screen.getByText("Couldn't save settings: invalid request.")).toBeTruthy());
    warn.mockRestore();
  });

  it('задан переменной окружения: неактивен и подписан именем переменной', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge, { agentSkills: 'PARLEY_AGENT_SKILLS' });

    switchTo('Agents');
    await screen.findByText(/set by PARLEY_AGENT_SKILLS/);
    const toggle = screen.getByRole('switch', { name: /Install agent skills into projects/ });

    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост прежней версии не знает ключа agentSkills — переключателя нет', async () => {
    const bridge = createFakeBridge();
    // Так выглядит ответ хоста, оставшегося от прежней версии: ключа agentSkills в конфиге нет.
    const oldHost: Partial<typeof CONFIG> = { ...CONFIG };
    delete oldHost.agentSkills;
    bridge.setHandler('settings.get', () => ({ config: oldHost as typeof CONFIG, locked: {} }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    await screen.findByText('Worktree root');

    expect(screen.queryByText('Install agent skills into projects')).toBeNull();
  });
});

describe('SettingsDialog — тест 2: поле, заданное окружением', () => {
  it('неактивно и подписано именем переменной; незаблокированное поле рядом активно', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge, { fontFamily: 'PARLEY_FONT_FAMILY' });

    switchTo('Terminal');
    await screen.findByText(/set by PARLEY_FONT_FAMILY/);
    const fontFamily = screen.getByDisplayValue('Menlo') as HTMLInputElement;
    expect(fontFamily.disabled).toBe(true);

    const fontSize = screen.getByDisplayValue('13') as HTMLInputElement;
    expect(fontSize.disabled).toBe(false);
  });
});

describe('SettingsDialog — тест 3: ошибка хоста при сохранении', () => {
  // Кусок E.1: рендерер больше не показывает error.message хоста напрямую —
  // код ошибки идёт через decodeIpcError (подставной мост шлёт { code,
  // message } без Electron-обёртки, см. shared/ipc-error.ts) в errorText(code, action).
  it('видна под полем как errorText(code), успешное сохранение убирает прежнюю ошибку и обновляет конфиг', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    let attempt = 0;
    bridge.setHandler('settings.set', ({ value }) => {
      attempt += 1;
      if (attempt === 1) throw { code: 'bad_request', message: 'messageRate: ожидается целое больше нуля' };
      return { config: { ...CONFIG, messageRate: Number(value) } };
    });

    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');

    const messageRate = await screen.findByDisplayValue('20');
    fireEvent.change(messageRate, { target: { value: '0' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.getByText("Couldn't save settings: invalid request.")).toBeTruthy());

    fireEvent.change(messageRate, { target: { value: '7' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.queryByText("Couldn't save settings: invalid request.")).toBeNull());
  });
});

// V6 плана релиза 0.1.0: переключатель проверки новой версии. Своей секции «General» в окне нет — он стоит в
// «Notifications», под подсказкой про системные настройки.
describe('SettingsDialog — переключатель «Check for updates» (V6 плана релиза 0.1.0)', () => {
  it('в секции Notifications, включён по умолчанию, с пояснением о GitHub; на других секциях его нет', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    switchTo('Notifications');
    const toggle = await screen.findByRole('switch', { name: 'Check for updates' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Looks for a newer Parley release on GitHub/)).toBeTruthy();

    switchTo('Appearance');
    expect(screen.queryByRole('switch', { name: 'Check for updates' })).toBeNull();
    switchTo('Agents');
    await screen.findByText('Worktree root');
    expect(screen.queryByRole('switch', { name: 'Check for updates' })).toBeNull();
  });

  it('клик выключает: app.saveUi({ checkForUpdates: false }) и зеркало ui; повторный — включает', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Notifications');
    fireEvent.click(await screen.findByRole('switch', { name: 'Check for updates' }));

    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledWith({ checkForUpdates: false }));
    const toggle = screen.getByRole('switch', { name: 'Check for updates' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(useUiStore.getState().ui.checkForUpdates).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(saveUiSpy).toHaveBeenLastCalledWith({ checkForUpdates: true }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('сохранённое выключение читается при открытии диалога', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ checkForUpdates: false });
    openSettings(bridge);

    switchTo('Notifications');
    const toggle = await screen.findByRole('switch', { name: 'Check for updates' });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('переключатель не задевает остальное: уведомления и закрытая версия остаются как были', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ dismissedUpdate: '0.2.0', notifications: { ...DEFAULT_UI.notifications, sound: false } });
    openSettings(bridge);

    switchTo('Notifications');
    fireEvent.click(await screen.findByRole('switch', { name: 'Check for updates' }));

    await waitFor(() => expect(useUiStore.getState().ui.checkForUpdates).toBe(false));
    expect(useUiStore.getState().ui.dismissedUpdate).toBe('0.2.0');
    expect(useUiStore.getState().ui.notifications.sound).toBe(false);
  });

  it('пока ui.json не загружен, переключателя нет: он не соврал бы «включено» по умолчанию', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    // Загрузка ui.json не завершается: зеркало остаётся слепком по умолчанию (`uiLoaded: false`).
    vi.spyOn(bridge.app, 'loadUi').mockReturnValue(new Promise(() => {}));
    useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
    useUiStore.getState().init(bridge);
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Notifications');
    await screen.findByText('Not getting notifications? System Settings → Notifications → Parley');

    expect(screen.queryByRole('switch', { name: 'Check for updates' })).toBeNull();
  });
});

// Остров одобрений (спека 2026-10-12): переключатель стоит в «Notifications», под звуком.
describe('SettingsDialog — переключатель «Island»', () => {
  const ISLAND_SWITCH = 'Island with requests at the top of the screen';

  it('включён по умолчанию; клик пишет ui.island.enabled — патчем из одного ключа; повторный — включает', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Notifications');
    const toggle = await screen.findByRole('switch', { name: ISLAND_SWITCH });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledWith({ island: { enabled: false } }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(useUiStore.getState().ui.island.enabled).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(saveUiSpy).toHaveBeenLastCalledWith({ island: { enabled: true } }));
  });

  it('в патче нет displayId и anchor: их main пишет сам, а копия рендерера устарела', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ island: { enabled: true, displayId: 7, anchor: 'right' } });
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Notifications');
    fireEvent.click(await screen.findByRole('switch', { name: ISLAND_SWITCH }));

    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledTimes(1));
    expect(saveUiSpy.mock.calls[0]?.[0]).toStrictEqual({ island: { enabled: false } });
  });
});

describe('SettingsDialog — тест 10 куска 9.1: секция Browser', () => {
  it('«Clear browser data» зовёт browser.clearData', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    switchTo('Browser');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear browser data' }));

    await waitFor(() => expect(bridge.browserCalls).toEqual([{ method: 'clearData', args: [] }]));
    expect(toast).not.toHaveBeenCalled();
  });

  it('отказ — тост «Couldn\'t clear browser data: failed.»', async () => {
    const bridge = createFakeBridge();
    vi.spyOn(bridge.browser, 'clearData').mockRejectedValue({ code: 'failed', message: 'disk full' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openSettings(bridge);

    switchTo('Browser');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear browser data' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't clear browser data: failed."));
    warn.mockRestore();
  });
});

describe('SettingsDialog — skill navigator', () => {
  it('defaults on, saves both ways, and stays independent of agentSkills', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: { ...CONFIG, agentSkills: false }, locked: {} }));
    bridge.setHandler('settings.set', ({ key, value }) => ({ config: { ...CONFIG, agentSkills: false, [key]: value === 'true' } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');
    const toggle = await screen.findByRole('switch', { name: 'Skill navigator' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Applies to new and resumed sessions.')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'skillNavigator', value: 'false' } });
    expect(screen.getByRole('switch', { name: 'Install agent skills into projects' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'skillNavigator', value: 'true' } });
  });

  it.each(['PARLEY_SKILL_NAVIGATOR', 'HARNAS_SKILL_NAVIGATOR'])('shows the actual env lock %s', async variable => {
    const bridge = createFakeBridge();
    openSettings(bridge, { skillNavigator: variable });
    switchTo('Agents');
    await screen.findByText(new RegExp(`set by ${variable}`));
    expect((screen.getByRole('switch', { name: 'Skill navigator' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the field for an older host while keeping other agent settings', async () => {
    const bridge = createFakeBridge();
    const oldHost: Partial<typeof CONFIG> = { ...CONFIG };
    delete oldHost.skillNavigator;
    bridge.setHandler('settings.get', () => ({ config: oldHost as typeof CONFIG, locked: {} }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');
    await screen.findByText('Worktree root');
    expect(screen.queryByRole('switch', { name: 'Skill navigator' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Install agent skills into projects' })).toBeTruthy();
  });

  it.each(['bad_request', 'secret-code-token'])('shows a safe field error without applying failed save %s', async code => {
    const bridge = createFakeBridge();
    openSettings(bridge);
    bridge.setHandler('settings.set', () => { throw { code, message: 'secret-config-token' }; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      switchTo('Agents');
      const toggle = await screen.findByRole('switch', { name: 'Skill navigator' });
      fireEvent.click(toggle);
      await screen.findByText(code === 'bad_request' ? "Couldn't save settings: invalid request." : "Couldn't save settings: failed.");
      // Неудачное сохранение не меняет переключатель: он остался в значении по умолчанию — включён.
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(screen.queryByText(/secret-config-token/)).toBeNull();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-config-token');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-code-token');
      expect(warn).toHaveBeenCalledWith('[parley] settings.set', 'skillNavigator', 'failed');
    } finally { warn.mockRestore(); }
  });
});

describe('SettingsDialog — пороги бюджета работы (P37)', () => {
  const LIMITS = {
    workConcurrent: 10, roomConcurrent: 6, workNewSessions: 30, roomNewSessions: 12, spawnDepth: 3,
    workLaunches: 40, roomLaunches: 20, workMessages: 200, roomMessages: 100, fanout: 400,
  };
  const WITH_LIMITS = { ...CONFIG, ...LIMITS };

  it('подраздел показывает все десять порогов с границами, а подсказка называет, что это не токены и не деньги', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: WITH_LIMITS, locked: {} }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    const section = await screen.findByRole('region', { name: 'Work limits' });
    expect(section.querySelectorAll('input')).toHaveLength(9);
    expect(section.textContent).toContain('Running sessions, workspace (1…64)');
    expect(section.textContent).toContain('Agent-created sessions, room (0…1000)');
    expect(section.textContent).toContain('not tokens or money');
    expect(section.textContent).toContain('Subagents a CLI starts inside its own session are not counted');
    expect(screen.queryByLabelText(/Spawn depth/)).toBeNull();
  });

  it('человек меняет порог явно: blur зовёт settings.set с ключом и текстом', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: WITH_LIMITS, locked: {} }));
    bridge.setHandler('settings.set', ({ key, value }) => ({ config: { ...WITH_LIMITS, [key]: Number(value) } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    const input = await screen.findByLabelText(/Running sessions, room/);
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'roomConcurrent', value: '4' } }),
    );
  });

  it('отказ хоста по порогу — безопасный текст под полем; порог из окружения заперт', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: WITH_LIMITS, locked: { fanout: 'PARLEY_FANOUT' } }));
    bridge.setHandler('settings.set', () => {
      throw { code: 'bad_request', message: 'fanout: expected an integer from 1 to 100000 /private/path' };
    });
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    expect((await screen.findByLabelText(/Message deliveries per hour/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/set by PARLEY_FANOUT/)).toBeTruthy();

    const input = screen.getByLabelText(/Agent messages per hour, workspace/);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText(/Couldn't save settings/)).toBeTruthy());
    expect(document.body.textContent).not.toContain('/private/path');
  });

  it('хост прежней версии порогов не отдаёт: подраздела нет', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Agents');
    await screen.findByText('Worktree root');
    expect(screen.queryByRole('region', { name: 'Work limits' })).toBeNull();
  });
});

describe('SettingsDialog — вкладка Voice', () => {
  it('openSettingsDialog("voice") — диалог открывается на вкладке Voice', async () => {
    const bridge = createFakeBridge();
    useUiStore.getState().openSettingsDialog('voice');
    openSettings(bridge);
    expect(await screen.findByRole('switch', { name: S.voice.settings.enable })).toBeTruthy();
  });
});

describe('SettingsDialog — Codex approvals', () => {
  const OPTIONS = S.settings.codexWriteApprovalsOptions;

  const openAgents = async (
    bridge: ReturnType<typeof createFakeBridge>,
    config: Record<string, unknown> = CONFIG,
    locked: Record<string, string> = {},
  ): Promise<void> => {
    bridge.setHandler('settings.get', () => ({ config: config as typeof CONFIG, locked }));
    bridge.setHandler('settings.set', ({ key, value }) => ({ config: { ...config, [key]: value } as typeof CONFIG }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');
    await screen.findByText('Worktree root');
  };

  it('shows the three modes, marks the current one and saves the pick', async () => {
    const bridge = createFakeBridge();
    await openAgents(bridge);
    const group = await screen.findByRole('radiogroup', { name: S.settings.codexWriteApprovals });
    expect(within(group).getAllByRole('radio').map((option) => option.textContent)).toEqual([
      "Auto-review (Codex's reviewer decides; nothing to answer)",
      "Ask in Parley (cards on the island and in Telegram; Codex asks once to trust Parley's hooks)",
      'Ask in the terminal',
    ]);
    expect(within(group).getByRole('radio', { name: OPTIONS.auto }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(S.settings.codexWriteApprovalsHookHint)).toBeNull();

    const parley = within(group).getByRole('radio', { name: OPTIONS.parley });
    fireEvent.click(parley);
    await waitFor(() => expect(parley.getAttribute('aria-checked')).toBe('true'));
    expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'codexWriteApprovals', value: 'parley' } });
    // Подсказка про /hooks — только у «Ask in Parley».
    expect(screen.getByText(S.settings.codexWriteApprovalsHookHint)).toBeTruthy();

    fireEvent.click(within(group).getByRole('radio', { name: OPTIONS.terminal }));
    await waitFor(() => expect(parley.getAttribute('aria-checked')).toBe('false'));
    expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'codexWriteApprovals', value: 'terminal' } });
    expect(screen.queryByText(S.settings.codexWriteApprovalsHookHint)).toBeNull();
  });

  it('a repeated click on the chosen mode saves nothing', async () => {
    const bridge = createFakeBridge();
    await openAgents(bridge);
    const group = await screen.findByRole('radiogroup', { name: S.settings.codexWriteApprovals });
    fireEvent.click(within(group).getByRole('radio', { name: OPTIONS.auto }));
    expect(bridge.calls.filter((call) => call.method === 'settings.set')).toEqual([]);
  });

  it('shows the env lock and disables the modes', async () => {
    const bridge = createFakeBridge();
    await openAgents(bridge, CONFIG, { codexWriteApprovals: 'PARLEY_CODEX_WRITE_APPROVALS' });
    await screen.findByText(/set by PARLEY_CODEX_WRITE_APPROVALS/);
    const group = screen.getByRole('radiogroup', { name: S.settings.codexWriteApprovals });
    for (const option of within(group).getAllByRole('radio')) expect((option as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a save error under the group', async () => {
    const bridge = createFakeBridge();
    await openAgents(bridge);
    bridge.setHandler('settings.set', () => {
      throw new Error('boom');
    });
    const group = await screen.findByRole('radiogroup', { name: S.settings.codexWriteApprovals });
    fireEvent.click(within(group).getByRole('radio', { name: OPTIONS.terminal }));
    await screen.findByText(/Couldn't save settings/);
  });

  it('hides the group for an older host', async () => {
    const bridge = createFakeBridge();
    const oldHost: Record<string, unknown> = { ...CONFIG };
    delete oldHost.codexWriteApprovals;
    await openAgents(bridge, oldHost);
    expect(screen.queryByRole('radiogroup', { name: S.settings.codexWriteApprovals })).toBeNull();
  });
});

describe('SettingsDialog — Projects', () => {
  it('has a Projects tab after Agents that lists the trusted folders', async () => {
    const bridge = createFakeBridge();
    bridge.setTrustFolders([{ folder: '/Users/me/Desktop/alpha', grantedAt: '2026-10-21T10:00:00.000Z', by: 'window' }]);
    openSettings(bridge);

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs.indexOf('Projects')).toBe(tabs.indexOf('Agents') + 1);

    switchTo('Projects');
    expect(await screen.findByText('/Users/me/Desktop/alpha')).toBeTruthy();
  });
});

describe('SettingsDialog — Lean agent sessions', () => {
  it('defaults on, saves both ways and shows the hint', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', ({ key, value }) => ({ config: { ...CONFIG, [key]: value === 'true' } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');
    const toggle = await screen.findByRole('switch', { name: 'Lean agent sessions' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(S.settings.leanAgentsHint)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'leanAgents', value: 'false' } });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'leanAgents', value: 'true' } });
  });

  it('shows the env lock and disables the switch', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge, { leanAgents: 'PARLEY_LEAN_AGENTS' });
    switchTo('Agents');
    await screen.findByText(/set by PARLEY_LEAN_AGENTS/);
    expect((screen.getByRole('switch', { name: 'Lean agent sessions' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the field for an older host while keeping other agent settings', async () => {
    const bridge = createFakeBridge();
    const oldHost: Partial<typeof CONFIG> = { ...CONFIG };
    delete oldHost.leanAgents;
    bridge.setHandler('settings.get', () => ({ config: oldHost as typeof CONFIG, locked: {} }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');
    await screen.findByText('Worktree root');
    expect(screen.queryByRole('switch', { name: 'Lean agent sessions' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Skill navigator' })).toBeTruthy();
  });
});

describe('SettingsDialog — «Let agents use the browser» (спека браузера 4.8; этап B2)', () => {
  it('в секции Browser, включён по умолчанию; клик — app.saveUi с browser.agentsAllowed: false и зеркало ui', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Browser');
    const toggle = await screen.findByLabelText('Let agents use the browser');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(S.settings.letAgentsUseBrowserHint)).toBeTruthy();
    fireEvent.click(toggle);

    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledWith({ browser: { ...DEFAULT_UI.browser, agentsAllowed: false } }));
    expect(useUiStore.getState().ui.browser.agentsAllowed).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('выключенный выключатель из ui.json показан выключенным; высота панели в патче не теряется', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ browser: { devtoolsHeight: 320, agentsAllowed: false } });
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Browser');
    const toggle = await screen.findByLabelText('Let agents use the browser');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledWith({ browser: { devtoolsHeight: 320, agentsAllowed: true } }));
  });
});

describe('SettingsDialog — навигация слева (живая проверка 2026-10-17)', () => {
  it('секции — вертикальный список в прежнем порядке, содержимое — в панели с прокруткой', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    const list = screen.getByRole('tablist');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Appearance',
      'Terminal',
      'Agents',
      'Projects',
      'Providers',
      'Notifications',
      'Browser',
      'Voice',
      'Assistant',
    ]);

    const pane = screen.getByTestId('settings-pane');
    // Не «Assistant»: та секция зовёт getHostClient(), которого в этом окружении нет.
    switchTo('Browser');
    expect(await within(pane).findByRole('button', { name: S.settings.clearBrowserData })).toBeTruthy();
  });
});
