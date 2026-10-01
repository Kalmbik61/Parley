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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
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
    await screen.findByLabelText('sound');
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
    const soundToggle = await screen.findByLabelText('sound');
    fireEvent.click(soundToggle);

    await waitFor(() =>
      expect(saveUiSpy).toHaveBeenCalledWith({
        notifications: { ...DEFAULT_UI.notifications, sound: false },
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
    bridge.setHandler('settings.get', () => ({ config: oldHost, locked: {} }));
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
