import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDevice, RemotePairRequest, RemoteState } from '../../../shared/remote-types.js';
import { S } from '../../../shared/strings.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { RemoteSettings } from './RemoteSettings.js';
import { SettingsDialog } from './SettingsDialog.js';

const T = S.settings.remote;
const RUNNING: RemoteState = {
  enabled: true,
  process: 'running',
  error: null,
  status: { running: true, host: 'online', relay: 'connected', relayUrl: 'wss://relay.example.com', devices: 1, version: '1' },
};
const request = (id: string, sas = '123456'): RemotePairRequest => ({ requestId: id, name: 'Anna’s iPhone', platform: 'ios', sas, fingerprint: 'fp', expiresAt: Date.now() + 60_000 });
const DEVICE: RemoteDevice = { deviceId: 'd1', name: 'Anna’s iPhone', platform: 'ios', pairedAt: Date.UTC(2026, 9, 30), lastSeen: null };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(state: RemoteState = RUNNING, extra: (bridge: FakeBridge) => void = () => undefined) {
  const bridge = createFakeBridge();
  let offers = 0;
  bridge.setRemoteHandler('state', () => state);
  bridge.setRemoteHandler('pair.start', () => ({ qr: `data:image/png;base64,Q${++offers}`, expiresAt: Date.now() + 120_000 }));
  bridge.setRemoteHandler('pair.cancel', () => null);
  bridge.setRemoteHandler('pair.answer', () => null);
  bridge.setRemoteHandler('devices.list', () => [DEVICE]);
  bridge.setRemoteHandler('devices.revoke', () => null);
  bridge.setRemoteHandler('reset', () => null);
  bridge.setRemoteHandler('audit.tail', () => []);
  bridge.setRemoteHandler('setEnabled', ({ enabled }) => ({ ...state, enabled, process: enabled ? 'running' : 'off' }));
  extra(bridge);
  const save = vi.fn(async () => undefined);
  render(<RemoteSettings bridge={bridge} config={{ remoteCreate: true } as never} locked={{}} save={save} />);
  return { bridge, save };
}

async function startPairing(bridge: FakeBridge): Promise<void> {
  fireEvent.click(await screen.findByTestId('remote-pair-start'));
  await screen.findByTestId('remote-qr');
  expect(bridge.remoteCalls.filter((c) => c.name === 'pair.start')).toHaveLength(1);
}

describe('RemoteSettings', () => {
  it('off: only the switch and the status line', async () => {
    mount({ enabled: false, process: 'off', error: null, status: null });
    expect(await screen.findByText(T.status.off)).toBeTruthy();
    expect(screen.queryByTestId('remote-pair')).toBeNull();
  });

  it('on: status of the bridge, host and relay, the relay field, the devices', async () => {
    mount();
    expect(await screen.findByText(T.status.host.online)).toBeTruthy();
    expect(screen.getByText(T.status.relay.connected)).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId('remote-relay') as HTMLInputElement).value).toBe('wss://relay.example.com'));
    expect(await screen.findByText(/Anna’s iPhone/)).toBeTruthy();
  });

  it('the pairing dialog shows «(unverified)» and the SAS, and Allow answers with the dialog’s requestId', async () => {
    const { bridge } = mount();
    await startPairing(bridge);
    act(() => bridge.emitRemote({ event: 'pair.request', data: request('req-A') }));
    expect((await screen.findByTestId('remote-pair-name')).textContent).toBe(T.dialog.unverified('Anna’s iPhone'));
    expect(screen.getByTestId('remote-pair-sas').textContent).toBe('123456');
    fireEvent.click(screen.getByText(T.dialog.allow));
    await waitFor(() => expect(bridge.remoteCalls.at(-1)).toEqual({ name: 'pair.answer', params: { requestId: 'req-A', allow: true } }));
    expect(screen.queryByTestId('remote-pair-sas')).toBeNull();
  });

  it('a dialog opened before a reissue is closed and never sends «Allow» for the new request', async () => {
    const { bridge } = mount();
    await startPairing(bridge);
    act(() => bridge.emitRemote({ event: 'pair.request', data: request('req-A', '111111') }));
    await screen.findByTestId('remote-pair-sas');
    // Cancel and start again: a new offer; the old dialog goes away with the old pairing.
    fireEvent.click(screen.getByTestId('remote-pair-stop'));
    fireEvent.click(await screen.findByTestId('remote-pair-start'));
    await screen.findByTestId('remote-qr');
    expect(screen.queryByTestId('remote-pair-sas')).toBeNull();
    // The new request has its own dialog and its own id.
    act(() => bridge.emitRemote({ event: 'pair.request', data: request('req-B', '222222') }));
    expect((await screen.findByTestId('remote-pair-sas')).textContent).toBe('222222');
    fireEvent.click(screen.getByTestId('remote-pair-allow'));
    await waitFor(() => expect(bridge.remoteCalls.filter((c) => c.name === 'pair.answer')).toEqual([{ name: 'pair.answer', params: { requestId: 'req-B', allow: true } }]));
  });

  it('a reissue while the dialog is open drops the dialog', async () => {
    const { bridge } = mount();
    await startPairing(bridge);
    act(() => bridge.emitRemote({ event: 'pair.request', data: request('req-A') }));
    await screen.findByTestId('remote-pair-sas');
    // The bridge burns the offer for a wrong code → a new QR at once; the old dialog (no longer current) is closed.
    act(() => bridge.emitRemote({ event: 'pair.offerClosed', data: { reason: 'bad-psk' } }));
    await waitFor(() => expect(bridge.remoteCalls.filter((c) => c.name === 'pair.start')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('remote-pair-sas')).toBeNull());
    expect(bridge.remoteCalls.filter((c) => c.name === 'pair.answer')).toHaveLength(0);
  });

  it('pair.offerClosed with a wrong code issues a new QR at once and says so', async () => {
    const { bridge } = mount();
    await startPairing(bridge);
    act(() => bridge.emitRemote({ event: 'pair.offerClosed', data: { reason: 'bad-psk' } }));
    await waitFor(() => expect(bridge.remoteCalls.filter((c) => c.name === 'pair.start')).toHaveLength(2));
    expect((await screen.findByTestId('remote-wrong-code')).textContent).toBe(T.pair.wrongCode);
    expect((screen.getByTestId('remote-qr') as HTMLImageElement).src).toContain('Q2');
  });

  it('a stale answer is explained and closes the dialog', async () => {
    const { bridge } = mount(RUNNING, (b) =>
      b.setRemoteHandler('pair.answer', () => {
        throw Object.assign(new Error('x'), { message: JSON.stringify({ code: 'stale_request', message: 'stale_request' }) });
      }),
    );
    await startPairing(bridge);
    act(() => bridge.emitRemote({ event: 'pair.request', data: request('req-A') }));
    fireEvent.click(await screen.findByTestId('remote-pair-allow'));
    await waitFor(() => expect(screen.queryByTestId('remote-pair-sas')).toBeNull());
  });

  it('shows «Phone connected ✓» after pair.done and reloads the devices', async () => {
    const { bridge } = mount();
    await startPairing(bridge);
    act(() => bridge.emitRemote({ event: 'pair.request', data: request('req-A') }));
    await screen.findByTestId('remote-pair-sas');
    act(() => bridge.emitRemote({ event: 'pair.done', data: { requestId: 'req-A', deviceId: 'd1' } }));
    expect((await screen.findByTestId('remote-connected')).textContent).toBe(T.pair.connected);
    expect(bridge.remoteCalls.filter((c) => c.name === 'devices.list').length).toBeGreaterThan(1);
  });

  it('revokes a device and resets only after a confirmation', async () => {
    const { bridge } = mount();
    fireEvent.click(await screen.findByTestId('remote-revoke'));
    await waitFor(() => expect(bridge.remoteCalls.some((c) => c.name === 'devices.revoke' && (c.params as { deviceId: string }).deviceId === 'd1')).toBe(true));
    fireEvent.click(screen.getByTestId('remote-reset'));
    expect(bridge.remoteCalls.some((c) => c.name === 'reset')).toBe(false);
    fireEvent.click(screen.getByTestId('remote-reset-yes'));
    await waitFor(() => expect(bridge.remoteCalls.some((c) => c.name === 'reset')).toBe(true));
  });

  it('the «Allow creating sessions and rooms» switch is on by default and writes remoteCreate', async () => {
    const { save } = mount();
    const toggle = await screen.findByTestId('remote-allow-create');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith('remoteCreate', '0');
  });
});

describe('Settings → Remote access in the dialog', () => {
  it('the remoteCreate switch round-trips through settings.set', async () => {
    const bridge = createFakeBridge();
    let config = { remoteCreate: true } as Record<string, unknown>;
    bridge.setHandler('settings.get', () => ({ config: config as never, locked: {} }));
    bridge.setHandler('settings.set', ({ key, value }) => {
      config = { ...config, [key]: value === '1' };
      return { config: config as never };
    });
    bridge.setRemoteHandler('state', () => RUNNING);
    bridge.setRemoteHandler('devices.list', () => []);
    bridge.setRemoteHandler('audit.tail', () => []);
    useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
    useUiStore.getState().init(bridge);
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: S.settings.sections.remote }));
    const toggle = await screen.findByTestId('remote-allow-create');
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'settings.set' && JSON.stringify(c.params) === '{"key":"remoteCreate","value":"0"}')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('remote-allow-create').getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(screen.getByTestId('remote-allow-create'));
    await waitFor(() => expect(screen.getByTestId('remote-allow-create').getAttribute('aria-checked')).toBe('true'));
  });
});
