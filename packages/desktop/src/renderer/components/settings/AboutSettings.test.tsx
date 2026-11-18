import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AboutInfo, UpdateCheckResult } from '../../../shared/bridge.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { aboutText } from './about-text.js';
import { AboutSettings } from './AboutSettings.js';

const INFO: AboutInfo = {
  version: '0.37.0',
  commit: '2b52d262',
  commitDate: '2026-11-17',
  dirty: false,
  arch: 'arm64',
  electron: '44.4.5',
  chrome: '140.0.1',
  node: '24.1.0',
  os: 'macOS 27.2',
  appPath: '/Applications/Parley.app',
  dataDir: '~/.parley',
  updateChecks: true,
  lastCheck: null,
};

function setup(info: Partial<AboutInfo> = {}) {
  const bridge = createFakeBridge();
  vi.spyOn(bridge.app, 'aboutInfo').mockResolvedValue({ ...INFO, ...info });
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true });
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.37.0', methods: null } });
  render(<AboutSettings bridge={bridge} />);
  return bridge;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('AboutSettings', () => {
  it('заголовок, строка сборки и список из моста', async () => {
    setup();
    expect(await screen.findByText('Parley 0.37.0')).toBeTruthy();
    expect(screen.getByText('Build 2b52d262 · 2026-11-17 · arm64')).toBeTruthy();
    expect(screen.getByText('44.4.5')).toBeTruthy();
    expect(screen.getByText('/Applications/Parley.app')).toBeTruthy();
    expect(screen.getByText('~/.parley')).toBeTruthy();
  });

  it('dirty — «modified»; без сборки версии — development build, кнопки Release notes нет', async () => {
    setup({ version: null, dirty: true, appPath: null });
    expect(await screen.findByText('Parley (development build)')).toBeTruthy();
    expect(screen.getByText('Build 2b52d262 · 2026-11-17 · arm64 · modified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull();
  });

  it.each<[UpdateCheckResult, string]>([
    [{ kind: 'current', latest: '0.37.0', checkedAt: 1 }, 'Parley 0.37.0 is the latest version'],
    [{ kind: 'available', latest: '0.38.0', checkedAt: 1 }, 'Parley 0.38.0 is available'],
    [{ kind: 'failed', reason: 'network', checkedAt: 1 }, "Couldn't reach GitHub. Check your connection."],
    [{ kind: 'failed', reason: 'rate_limited', checkedAt: 1 }, "GitHub's rate limit was reached. Try again later."],
    [{ kind: 'failed', reason: 'bad_response', checkedAt: 1 }, 'GitHub sent an unexpected answer. Try again later.'],
    [{ kind: 'unavailable' }, 'Update checks are off in this build'],
  ])('Check now: %j → строка итога; кнопка неактивна, пока промис не решён', async (result, text) => {
    const bridge = setup();
    let resolve: (value: UpdateCheckResult) => void = () => {};
    vi.spyOn(bridge.app, 'checkForUpdates').mockReturnValue(new Promise((r) => (resolve = r)));
    const button = (await screen.findByRole('button', { name: 'Check now' })) as HTMLButtonElement;
    fireEvent.click(button);
    expect(await screen.findByText('Checking…')).toBeTruthy();
    expect(button.disabled).toBe(true);
    resolve(result);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(button.disabled).toBe(false);
  });

  it('updateChecks: false — Check now неактивна сразу', async () => {
    setup({ updateChecks: false });
    const button = (await screen.findByRole('button', { name: 'Check now' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('Release notes открывает адрес с v<version>', async () => {
    const bridge = setup();
    const open = vi.spyOn(bridge.app, 'openExternal');
    fireEvent.click(await screen.findByRole('button', { name: 'Release notes' }));
    expect(open).toHaveBeenCalledWith('https://github.com/Kalmbik61/Parley/releases/tag/v0.37.0');
  });

  it('Copy info пишет текст aboutText', async () => {
    setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Copy info' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(aboutText(INFO, '0.37.0')));
  });

  it('Last checked при lastCheck', async () => {
    setup({ lastCheck: { kind: 'current', latest: '0.37.0', checkedAt: Date.UTC(2026, 10, 18, 7, 0, 0) } });
    expect(await screen.findByText(/^Last checked /)).toBeTruthy();
  });

  it('переключатель автопроверки пишет patchUi, строка самообновления видна и при выключенной проверке', async () => {
    const bridge = setup();
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: false } });
    bridge.setUpdateState({ phase: 'ready', version: '0.38.0', url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.38.0' });
    expect(await screen.findByText('0.38.0 is ready to install')).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    useUiStore.getState().init(bridge);
    fireEvent.click(toggle);
    await waitFor(() => expect(saveUi).toHaveBeenCalledWith({ checkForUpdates: true }));
  });
});
