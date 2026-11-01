import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayPlanView } from '../../../shared/relay-setup-types.js';
import { S } from '../../../shared/strings.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { RelaySetupDialog } from './RelaySetupDialog.js';

const T = S.settings.remote.wizard;
afterEach(cleanup);

const PLAN: RelayPlanView = {
  intent: 'install',
  steps: [{ id: 'docker', title: 'Docker', check: 'docker --version', commands: ['apt-get update'] }],
  notes: ['Docker packages come from docker.com'],
  blocked: null,
  address: 'r.example.com',
  proxy: null,
};

function mount() {
  const bridge = createFakeBridge();
  bridge.setRelaySetupHandler('keys', () => ({ files: ['id_ed25519'], agent: false }));
  bridge.setRelaySetupHandler('cancel', () => null);
  render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
  return bridge;
}

describe('RelaySetupDialog', () => {
  it('host key → plan → Run; the password is sent once and forgotten by the form', async () => {
    const bridge = mount();
    bridge.setRelaySetupHandler('begin', () => ({ phase: 'hostkey', host: '1.2.3.4', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }));
    bridge.setRelaySetupHandler('trust', () => ({ phase: 'plan', plan: PLAN, os: 'Ubuntu 24.04' }));
    bridge.setRelaySetupHandler('run', () => ({ phase: 'done', address: 'r.example.com', configured: true }));

    fireEvent.change(await screen.findByTestId('relay-setup-host'), { target: { value: ' 1.2.3.4 ' } });
    await waitFor(() => expect(screen.getByTestId('relay-setup-auth-password')).toBeTruthy());
    fireEvent.click(screen.getByTestId('relay-setup-auth-password'));
    fireEvent.change(screen.getByTestId('relay-setup-password'), { target: { value: 'secret-pw' } });
    fireEvent.click(screen.getByTestId('relay-setup-connect'));

    expect((await screen.findByTestId('relay-setup-fingerprint')).textContent).toBe('SHA256:abc');
    const begin = bridge.relaySetupCalls.find((c) => c.name === 'begin')!.params as { host: string; secrets: { password?: string } };
    expect(begin.host).toBe('1.2.3.4');
    expect(begin.secrets.password).toBe('secret-pw');
    // Nothing runs before the person confirms the fingerprint, and nothing from the plan before «Run».
    expect(bridge.relaySetupCalls.map((c) => c.name)).not.toContain('run');

    fireEvent.click(screen.getByTestId('relay-setup-trust'));
    expect((await screen.findByTestId('relay-setup-plan')).textContent).toContain('apt-get update');
    expect(bridge.relaySetupCalls.map((c) => c.name)).not.toContain('run');
    fireEvent.click(screen.getByTestId('relay-setup-run'));
    expect((await screen.findByTestId('relay-setup-done')).textContent).toContain(T.done('r.example.com'));
  });

  it('a changed host key leaves no way on', async () => {
    const bridge = mount();
    bridge.setRelaySetupHandler('begin', () => ({ phase: 'hostkey-changed', host: '1.2.3.4', port: 22, known: 'SHA256:old', presented: 'SHA256:new' }));
    fireEvent.change(await screen.findByTestId('relay-setup-host'), { target: { value: '1.2.3.4' } });
    fireEvent.click(screen.getByTestId('relay-setup-connect'));
    expect(await screen.findByTestId('relay-setup-hostkey-changed')).toBeTruthy();
    expect(screen.queryByTestId('relay-setup-trust')).toBeNull();
    expect(screen.queryByTestId('relay-setup-run')).toBeNull();
  });

  it('shows a blocked plan without «Run» enabled, and the field errors of main', async () => {
    const bridge = mount();
    bridge.setRelaySetupHandler('begin', () => ({ phase: 'plan', plan: { ...PLAN, steps: [], blocked: 'Unsupported system' }, os: 'Alpine' }));
    fireEvent.change(await screen.findByTestId('relay-setup-host'), { target: { value: '1.2.3.4' } });
    fireEvent.click(screen.getByTestId('relay-setup-connect'));
    expect((await screen.findByTestId('relay-setup-blocked')).textContent).toContain('Unsupported system');
    expect((screen.getByTestId('relay-setup-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('remove: the data checkbox asks main for a new plan', async () => {
    const bridge = mount();
    bridge.setRelaySetupHandler('begin', () => ({ phase: 'plan', plan: { ...PLAN, intent: 'remove' }, os: 'Ubuntu' }));
    bridge.setRelaySetupHandler('plan', () => ({ phase: 'plan', plan: { ...PLAN, intent: 'remove' }, os: 'Ubuntu' }));
    fireEvent.change(await screen.findByTestId('relay-setup-host'), { target: { value: '1.2.3.4' } });
    fireEvent.click(screen.getByTestId('relay-setup-intent-remove'));
    fireEvent.click(screen.getByTestId('relay-setup-connect'));
    fireEvent.click(await screen.findByTestId('relay-setup-remove-data'));
    await waitFor(() => expect(bridge.relaySetupCalls.some((c) => c.name === 'plan' && (c.params as { removeData: boolean }).removeData)).toBe(true));
  });

  it('forgets the password as soon as the request is sent, not when the slow connect returns', async () => {
    const bridge = mount();
    let finish!: () => void;
    bridge.setRelaySetupHandler('begin', () => new Promise((resolve) => (finish = () => resolve({ phase: 'auth-failed' }))));
    fireEvent.change(await screen.findByTestId('relay-setup-host'), { target: { value: '1.2.3.4' } });
    await waitFor(() => expect(screen.getByTestId('relay-setup-auth-password')).toBeTruthy());
    fireEvent.click(screen.getByTestId('relay-setup-auth-password'));
    fireEvent.change(screen.getByTestId('relay-setup-password'), { target: { value: 'secret-pw' } });
    fireEvent.click(screen.getByTestId('relay-setup-connect'));
    expect((screen.getByTestId('relay-setup-password') as HTMLInputElement).value).toBe('');
    finish();
    await screen.findByTestId('relay-setup-auth-failed');
  });
});
