import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayPlanView, RelayRunView } from '../../../shared/relay-setup-types.js';
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
  web: null,
};

/** A record of main as `state` returns it. */
function record(over: Partial<RelayRunView> = {}): RelayRunView {
  return {
    seq: 5,
    intent: 'install',
    host: '1.2.3.4',
    plan: PLAN,
    steps: [
      { id: 'docker', title: 'Docker', status: 'done', lines: ['$ apt-get update', 'Get:1 mirror'] },
      { id: 'image', title: 'Relay image', status: 'running', lines: [] },
    ],
    progress: null,
    cancelling: false,
    phase: { phase: 'running' },
    ...over,
  };
}

function mount(onClose: () => void = () => undefined) {
  const bridge = createFakeBridge();
  bridge.setRelaySetupHandler('keys', () => ({ files: ['id_ed25519'], agent: false }));
  bridge.setRelaySetupHandler('cancel', () => null);
  bridge.setRelaySetupHandler('state', () => null);
  bridge.setRelaySetupHandler('dismiss', () => null);
  const view = render(<RelaySetupDialog bridge={bridge} open onClose={onClose} />);
  return Object.assign(bridge, { view });
}

const names = (bridge: ReturnType<typeof mount>): string[] => bridge.relaySetupCalls.map((c) => c.name);

describe('RelaySetupDialog', () => {
  it('host key → plan → Run; the password is sent once and forgotten by the form', async () => {
    const bridge = mount();
    bridge.setRelaySetupHandler('begin', () => ({ phase: 'hostkey', host: '1.2.3.4', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }));
    bridge.setRelaySetupHandler('trust', () => ({ phase: 'plan', plan: PLAN, os: 'Ubuntu 24.04' }));
    bridge.setRelaySetupHandler('run', () => ({ phase: 'running' }));

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
    // After «Run» the window reads the record of main and shows it; the outcome comes with it.
    bridge.setRelaySetupHandler('state', () => record({ seq: 9, steps: [{ id: 'docker', title: 'Docker', status: 'done', lines: [] }], phase: { phase: 'done', address: 'r.example.com', configured: true } }));
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

  it('Esc and a click on the backdrop close neither the form nor a run', async () => {
    const onClose = vi.fn();
    const bridge = mount(onClose);
    const dialog = await screen.findByTestId('relay-setup-dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(names(bridge)).not.toContain('cancel');
    cleanup();

    const bridge2 = createFakeBridge();
    bridge2.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge2.setRelaySetupHandler('state', () => record());
    render(<RelaySetupDialog bridge={bridge2} open onClose={onClose} />);
    const live = await screen.findByTestId('relay-setup-dialog');
    await screen.findByTestId('relay-setup-record');
    fireEvent.keyDown(live, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge2.relaySetupCalls.map((c) => c.name)).not.toContain('cancel');
  });

  it('the cross before «Run» cancels the session; during a run it only hides the window', async () => {
    const onClose = vi.fn();
    const bridge = mount(onClose);
    await screen.findByTestId('relay-setup-host');
    fireEvent.click(screen.getByRole('button', { name: S.common.close }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(names(bridge)).toContain('cancel');
    cleanup();

    const live = createFakeBridge();
    live.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    live.setRelaySetupHandler('state', () => record());
    const hide = vi.fn();
    render(<RelaySetupDialog bridge={live} open onClose={hide} />);
    await screen.findByTestId('relay-setup-record');
    fireEvent.click(screen.getByRole('button', { name: S.common.close }));
    expect(hide).toHaveBeenCalledTimes(1);
    expect(live.relaySetupCalls.map((c) => c.name)).not.toContain('cancel');
    expect(live.relaySetupCalls.map((c) => c.name)).not.toContain('dismiss');
  });

  it('a new window instance, and a reopened one, show the record of main with its log', async () => {
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge.setRelaySetupHandler('state', () => record());
    const first = render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    expect((await screen.findByTestId('relay-setup-log')).textContent).toContain('Get:1 mirror');
    expect(screen.queryByTestId('relay-setup-host')).toBeNull();
    // Hidden and shown again.
    first.rerender(<RelaySetupDialog bridge={bridge} open={false} onClose={() => undefined} />);
    first.rerender(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('relay-setup-log').textContent).toContain('Get:1 mirror'));
    cleanup();
    // The window was reloaded: a brand-new instance.
    render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    expect((await screen.findByTestId('relay-setup-log')).textContent).toContain('apt-get update');
  });

  it('an event that arrives between the subscription and the answer of state is not lost, and an old one is not applied twice', async () => {
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    let answer!: (view: RelayRunView) => void;
    bridge.setRelaySetupHandler('state', () => new Promise<RelayRunView>((resolve) => (answer = resolve)));
    render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    await waitFor(() => expect(bridge.relaySetupCalls.some((c) => c.name === 'state')).toBe(true));
    // seq 5 is inside the snapshot (already counted), seq 6 is newer.
    bridge.emitRelaySetup({ event: 'line', step: 'image', text: 'inside-snapshot', seq: 5 });
    bridge.emitRelaySetup({ event: 'line', step: 'image', text: 'after-snapshot', seq: 6 });
    answer(record({ seq: 5 }));
    await waitFor(() => expect(screen.getByTestId('relay-setup-log').textContent).toContain('after-snapshot'));
    expect(screen.getByTestId('relay-setup-log').textContent).not.toContain('inside-snapshot');
    // Later events go straight in, a repeated number is dropped.
    bridge.emitRelaySetup({ event: 'line', step: 'image', text: 'live-one', seq: 7 });
    bridge.emitRelaySetup({ event: 'line', step: 'image', text: 'live-one', seq: 7 });
    await waitFor(() => expect(screen.getByTestId('relay-setup-log').textContent).toContain('live-one'));
    expect(screen.getByTestId('relay-setup-log').textContent?.match(/live-one/g)).toHaveLength(1);
  });

  it('shows the download bar with the text of spec 7.1, and «Cancelling after this step…» with Cancel disabled', async () => {
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge.setRelaySetupHandler('state', () => record({ progress: { step: 'image', layersDone: 3, layersTotal: 8, bytesDone: 41_200_000, bytesTotal: 82_000_000 } }));
    render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    expect((await screen.findByTestId('relay-setup-progress-text')).textContent).toBe('Downloading the relay image: 41.2 of 82.0 MB · 3 of 8 layers');
    expect(screen.getByTestId('relay-setup-progress').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.queryByTestId('relay-setup-cancelling')).toBeNull();
    expect((screen.getByTestId('relay-setup-cancel-run') as HTMLButtonElement).disabled).toBe(false);

    bridge.emitRelaySetup({ event: 'cancelling', seq: 6 });
    expect((await screen.findByTestId('relay-setup-cancelling')).textContent).toBe(T.cancelling);
    expect((screen.getByTestId('relay-setup-cancel-run') as HTMLButtonElement).disabled).toBe(true);

    // The bar goes with its step.
    bridge.emitRelaySetup({ event: 'step', id: 'image', title: 'Relay image', status: 'done', seq: 7 });
    await waitFor(() => expect(screen.queryByTestId('relay-setup-progress')).toBeNull());
  });

  it('Cancel during the run calls cancel and does not close the window', async () => {
    const onClose = vi.fn();
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge.setRelaySetupHandler('state', () => record());
    bridge.setRelaySetupHandler('cancel', () => null);
    render(<RelaySetupDialog bridge={bridge} open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('relay-setup-cancel-run'));
    await waitFor(() => expect(bridge.relaySetupCalls.map((c) => c.name)).toContain('cancel'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a cancelled run is shown without red; its outcome event arrives while the window is open', async () => {
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge.setRelaySetupHandler('state', () => record());
    render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    await screen.findByTestId('relay-setup-record');
    bridge.emitRelaySetup({ event: 'phase', phase: { phase: 'cancelled', step: 'image', message: 'Cancelled. Run the setup again to finish: finished steps are skipped.' }, seq: 6 });
    const text = await screen.findByTestId('relay-setup-cancelled');
    expect(text.textContent).toContain('Cancelled.');
    expect(text.className).not.toContain('destructive');
    expect(screen.queryByTestId('relay-setup-check')).toBeNull();
    expect(screen.getByTestId('relay-setup-new')).toBeTruthy();
  });

  it('cancelled at the health check offers Check', async () => {
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge.setRelaySetupHandler('state', () => record({ phase: { phase: 'cancelled', step: 'health', message: 'Cancelled. Use Check to test the relay again.' } }));
    bridge.setRelaySetupHandler('check', () => ({ phase: 'done', address: 'r.example.com', configured: true }));
    render(<RelaySetupDialog bridge={bridge} open onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId('relay-setup-check'));
    await waitFor(() => expect(bridge.relaySetupCalls.map((c) => c.name)).toContain('check'));
  });

  it('Close and New setup forget the record with dismiss; New setup shows the form, Close closes the window', async () => {
    const finished = record({ phase: { phase: 'done', address: 'r.example.com', configured: true } });
    const bridge = createFakeBridge();
    bridge.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    bridge.setRelaySetupHandler('state', () => finished);
    bridge.setRelaySetupHandler('dismiss', () => null);
    const onClose = vi.fn();
    render(<RelaySetupDialog bridge={bridge} open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('relay-setup-new'));
    expect(await screen.findByTestId('relay-setup-host')).toBeTruthy();
    expect(bridge.relaySetupCalls.filter((c) => c.name === 'dismiss')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    cleanup();

    const again = createFakeBridge();
    again.setRelaySetupHandler('keys', () => ({ files: [], agent: false }));
    again.setRelaySetupHandler('state', () => finished);
    again.setRelaySetupHandler('dismiss', () => null);
    const close = vi.fn();
    render(<RelaySetupDialog bridge={again} open onClose={close} />);
    fireEvent.click(await screen.findByTestId('relay-setup-close'));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(again.relaySetupCalls.filter((c) => c.name === 'dismiss')).toHaveLength(1);
  });

  it('a plan with an edit of the web server shows the file, the action, the content and the copy', async () => {
    const bridge = mount();
    const web = {
      summary: 'Caddy of the project course-platform-prod holds ports 80 and 443',
      network: 'course-platform-prod_default',
      edits: [
        {
          server: 'Caddy',
          file: '/srv/course/caddy/sites/parley-relay.caddy',
          action: 'add' as const,
          content: 'relay.example.com {\n\treverse_proxy parley-relay:8787\n}\n',
          backup: '/var/lib/parley-relay-setup/backups/parley-relay.caddy',
          check: 'caddy validate',
          reload: 'caddy reload',
        },
      ],
    };
    bridge.setRelaySetupHandler('begin', () => ({ phase: 'plan', plan: { ...PLAN, web }, os: 'Ubuntu 24.04' }));
    fireEvent.change(await screen.findByTestId('relay-setup-host'), { target: { value: '1.2.3.4' } });
    fireEvent.click(screen.getByTestId('relay-setup-connect'));
    const block = await screen.findByTestId('relay-setup-web');
    expect(block.textContent).toContain(T.webTitle);
    expect(block.textContent).toContain('course-platform-prod_default');
    const edit = screen.getByTestId('relay-setup-web-edit').textContent ?? '';
    expect(edit).toContain('/srv/course/caddy/sites/parley-relay.caddy');
    expect(edit).toContain(T.webAction.add);
    expect(edit).toContain('reverse_proxy parley-relay:8787');
    expect(edit).toContain('/var/lib/parley-relay-setup/backups/parley-relay.caddy');
    expect(edit).toContain('caddy validate');
    expect(edit).toContain('caddy reload');
  });
});
