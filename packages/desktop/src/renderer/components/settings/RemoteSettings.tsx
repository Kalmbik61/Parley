/**
 * Settings → Remote access (mobile app plan A10, spec 12): the switch, the relay, pairing, devices, activity.
 * The screen talks to the bridge only through main (`bridge.remote`, the local control socket) — never the relay.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ParleyConfig } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import type { RemoteAuditRecord, RemoteDevice, RemoteState } from '../../../shared/remote-types.js';
import { errorText, S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Switch } from '../../ui/switch.js';
import { INITIAL_PAIR, pairReducer, reissueDue } from './remote-pairing.js';

export interface RemoteSettingsProps {
  bridge: ParleyBridge;
  /** `null` until `settings.get` answers. */
  config: ParleyConfig | null;
  locked: Record<string, string>;
  save: (key: keyof ParleyConfig, value: string) => Promise<void>;
  /** Error of the last failed `settings.set` for `remoteCreate`. */
  error?: string | undefined;
}

const OFF: RemoteState = { enabled: false, process: 'off', error: null, status: null };
/** The QR is replaced this long before it expires, so the phone never scans a dead code. */
const REISSUE_MARGIN_MS = 3000;
const TEXT = S.settings.remote;

function whenText(ms: number | null): string {
  return ms === null ? TEXT.devices.neverSeen : new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function RemoteSettings({ bridge, config, locked, save, error }: RemoteSettingsProps): JSX.Element {
  const remote = bridge.remote;
  const [state, setState] = useState<RemoteState>(OFF);
  const [pair, dispatch] = useReducer(pairReducer, INITIAL_PAIR);
  const [notice, setNotice] = useState<string | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [activity, setActivity] = useState<RemoteAuditRecord[]>([]);
  const [relay, setRelay] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const running = state.process === 'running';

  const fail = useCallback((err: unknown, action: string): void => {
    const info = decodeIpcError(err);
    if (!alive.current) return;
    const known: Record<string, string> = {
      stale_request: TEXT.pair.staleRequest,
      reset_failed: TEXT.devices.resetFailed,
      busy: TEXT.devices.busy,
    };
    setNotice(known[info.code] ?? errorText(info.code, action));
  }, []);

  const loadLists = useCallback(async (): Promise<void> => {
    try {
      const [list, records] = await Promise.all([remote.call('devices.list', {}), remote.call('audit.tail', { limit: 200 })]);
      if (!alive.current) return;
      setDevices(list);
      setActivity(records.slice().reverse());
    } catch (err: unknown) {
      fail(err, S.errors.actions.loadSettings);
    }
  }, [remote, fail]);

  const startOffer = useCallback(async (): Promise<void> => {
    try {
      const offer = await remote.call('pair.start', {});
      if (alive.current) dispatch({ type: 'offer', offer });
    } catch (err: unknown) {
      if (alive.current) dispatch({ type: 'stop' });
      fail(err, S.errors.actions.saveSettings);
    }
  }, [remote, fail]);

  useEffect(() => {
    alive.current = true;
    const off = remote.on((message) => {
      if (!alive.current) return;
      switch (message.event) {
        case 'state':
          setState(message.data);
          return;
        case 'pair.request':
          dispatch({ type: 'request', request: message.data });
          return;
        case 'pair.done':
          dispatch({ type: 'done', requestId: message.data.requestId });
          void loadLists();
          return;
        case 'pair.failed':
          dispatch({ type: 'failed', requestId: message.data.requestId, reason: message.data.reason });
          return;
        case 'pair.offerClosed':
          dispatch({ type: 'offerClosed', reason: message.data.reason });
          return;
      }
    });
    remote.call('state', {}).then(
      (next) => alive.current && setState(next),
      (err: unknown) => fail(err, S.errors.actions.loadSettings),
    );
    return () => {
      alive.current = false;
      off();
    };
  }, [remote, fail, loadLists]);

  useEffect(() => {
    if (running) void loadLists();
    else {
      setDevices([]);
      setActivity([]);
      dispatch({ type: 'stop' });
    }
  }, [running, loadLists]);

  useEffect(() => {
    if (state.status?.relayUrl) setRelay(state.status.relayUrl);
  }, [state.status?.relayUrl]);

  // Reissue the offer before it expires — but not while a request waits for «Allow» (plan A10).
  const offerExpiresAt = pair.offer?.expiresAt ?? null;
  const due = reissueDue(pair);
  useEffect(() => {
    if (!due || offerExpiresAt === null) return;
    const timer = setTimeout(() => void startOffer(), Math.max(0, offerExpiresAt - Date.now() - REISSUE_MARGIN_MS));
    return () => clearTimeout(timer);
  }, [due, offerExpiresAt, startOffer]);

  // A wrong code burns the offer: a new QR at once.
  useEffect(() => {
    if (pair.active && pair.offer === null && pair.wrongCode) void startOffer();
  }, [pair.active, pair.offer, pair.wrongCode, startOffer]);

  // The countdown under the QR, and the end of a request the user did not answer.
  const requestExpiresAt = pair.request?.expiresAt ?? null;
  useEffect(() => {
    if (offerExpiresAt === null && requestExpiresAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offerExpiresAt, requestExpiresAt]);
  const requestId = pair.request?.requestId ?? null;
  useEffect(() => {
    if (requestId === null || requestExpiresAt === null) return;
    const timer = setTimeout(() => dispatch({ type: 'closeRequest', requestId }), Math.max(0, requestExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [requestId, requestExpiresAt]);

  const run = async (action: string, operation: () => Promise<void>): Promise<void> => {
    setNotice(null);
    try {
      await operation();
    } catch (err: unknown) {
      fail(err, action);
    }
  };

  /** The answer carries the id of the dialog's own request; a refusal (`stale_request`) closes the dialog. */
  const answer = (id: string, allow: boolean): void => {
    dispatch({ type: 'closeRequest', requestId: id });
    void run(S.errors.actions.saveSettings, async () => void (await remote.call('pair.answer', { requestId: id, allow })));
  };

  const request = pair.request;
  const remaining = pair.offer === null ? 0 : Math.max(0, Math.ceil((pair.offer.expiresAt - now) / 1000));
  const status = state.status;
  const createAllowed = config?.remoteCreate ?? true;

  const processLine =
    state.process === 'off'
      ? TEXT.status.off
      : state.process === 'starting'
        ? TEXT.status.starting
        : state.process === 'error'
          ? TEXT.status.error(state.error ?? '')
          : null;

  return (
    <section data-testid="remote-section" className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-2">
          <span>{TEXT.enabled}</span>
          <Switch
            data-testid="remote-enabled"
            checked={state.enabled}
            onCheckedChange={(checked) =>
              void run(S.errors.actions.saveSettings, async () => {
                setState(await remote.call('setEnabled', { enabled: checked }));
              })
            }
          />
        </label>
        <p className="text-xs text-muted-foreground">{TEXT.enabledHint}</p>
      </div>

      <div data-testid="remote-status" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {processLine !== null ? <span>{processLine}</span> : null}
        {running && status !== null ? (
          <>
            <span>{TEXT.status.bridge(status.running)}</span>
            <span>{TEXT.status.host[status.host]}</span>
            <span>{TEXT.status.relay[status.relay]}</span>
          </>
        ) : null}
      </div>
      {notice !== null ? (
        <p data-testid="remote-notice" className="text-xs text-destructive">
          {notice}
        </p>
      ) : null}

      {state.enabled ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span>{TEXT.relayLabel}</span>
            <div className="flex items-center gap-2">
              <Input
                data-testid="remote-relay"
                aria-label={TEXT.relayLabel}
                placeholder={TEXT.relayPlaceholder}
                value={relay}
                onChange={(event) => setRelay(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                data-testid="remote-relay-save"
                disabled={!running || relay.trim() === ''}
                onClick={() =>
                  void run(S.errors.actions.saveSettings, async () => {
                    setState(await remote.call('configure', { relayUrl: relay.trim() }));
                  })
                }
              >
                {TEXT.relaySave}
              </Button>
            </div>
            {relay.trim().startsWith('ws://') ? <span className="text-xs text-muted-foreground">{TEXT.relayDevNote}</span> : null}
            <Button type="button" variant="outline" size="sm" className="self-start" disabled title={TEXT.wizardSoon} data-testid="remote-wizard">
              {TEXT.setUpOnServer}
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <label className="flex items-center justify-between gap-2">
              <span>{TEXT.allowCreate}</span>
              <Switch
                data-testid="remote-allow-create"
                checked={createAllowed}
                disabled={config === null || locked.remoteCreate !== undefined}
                onCheckedChange={(checked) => void save('remoteCreate', checked ? '1' : '0')}
              />
            </label>
            <p className="text-xs text-muted-foreground">{TEXT.allowCreateHint}</p>
            {error !== undefined ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <div className="flex flex-col gap-2" data-testid="remote-pair">
            <h3 className="text-sm font-medium">{TEXT.pair.heading}</h3>
            {pair.connected ? <p data-testid="remote-connected" className="text-xs">{TEXT.pair.connected}</p> : null}
            {pair.failedReason !== null ? (
              <p data-testid="remote-pair-failed" className="text-xs text-destructive">
                {TEXT.pair.failed[pair.failedReason] ?? TEXT.pair.failedOther}
              </p>
            ) : null}
            {pair.wrongCode ? <p data-testid="remote-wrong-code" className="text-xs text-destructive">{TEXT.pair.wrongCode}</p> : null}
            {pair.offer !== null ? (
              <div className="flex flex-col items-start gap-1.5">
                <img data-testid="remote-qr" src={pair.offer.qr} alt={TEXT.pair.qrAlt} className="size-44 rounded-md bg-white p-1" />
                <span className="text-xs text-muted-foreground">{TEXT.pair.hint}</span>
                <span className="text-xs text-muted-foreground">{TEXT.pair.expiresIn(remaining)}</span>
              </div>
            ) : null}
            {pair.active ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                data-testid="remote-pair-stop"
                onClick={() => {
                  dispatch({ type: 'stop' });
                  void run(S.errors.actions.saveSettings, async () => void (await remote.call('pair.cancel', {})));
                }}
              >
                {TEXT.pair.stop}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="self-start"
                data-testid="remote-pair-start"
                disabled={!running}
                onClick={() => {
                  dispatch({ type: 'begin' });
                  void startOffer();
                }}
              >
                {TEXT.pair.start}
              </Button>
            )}
          </div>

          <div className="flex flex-col gap-2" data-testid="remote-devices">
            <h3 className="text-sm font-medium">{TEXT.devices.heading}</h3>
            {devices.length === 0 ? <p className="text-xs text-muted-foreground">{TEXT.devices.empty}</p> : null}
            {devices.map((device) => (
              <div key={device.deviceId} className="flex items-center justify-between gap-2" data-testid="remote-device">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {device.name} <span className="text-muted-foreground">· {device.platform}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {TEXT.devices.paired(whenText(device.pairedAt))} · {device.lastSeen === null ? TEXT.devices.neverSeen : TEXT.devices.lastSeen(whenText(device.lastSeen))}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="remote-revoke"
                  onClick={() =>
                    void run(S.errors.actions.saveSettings, async () => {
                      await remote.call('devices.revoke', { deviceId: device.deviceId });
                      await loadLists();
                    })
                  }
                >
                  {TEXT.devices.revoke}
                </Button>
              </div>
            ))}
            {confirmReset ? (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="remote-reset-confirm">
                <span className="font-medium">{TEXT.devices.resetConfirmTitle}</span>
                <span className="text-xs text-muted-foreground">{TEXT.devices.resetConfirmBody}</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    data-testid="remote-reset-yes"
                    onClick={() =>
                      void run(S.errors.actions.saveSettings, async () => {
                        setConfirmReset(false);
                        await remote.call('reset', {});
                        await loadLists();
                      })
                    }
                  >
                    {TEXT.devices.resetConfirm}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirmReset(false)}>
                    {TEXT.devices.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" className="self-start" data-testid="remote-reset" disabled={!running} onClick={() => setConfirmReset(true)}>
                {TEXT.devices.reset}
              </Button>
            )}
          </div>

          <div className="flex flex-col gap-2" data-testid="remote-activity">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{TEXT.activity.heading}</h3>
              <Button type="button" variant="outline" size="sm" disabled={!running} onClick={() => void loadLists()}>
                {TEXT.activity.refresh}
              </Button>
            </div>
            {activity.length === 0 ? <p className="text-xs text-muted-foreground">{TEXT.activity.empty}</p> : null}
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto font-mono text-xs text-muted-foreground">
              {activity.map((record, index) => (
                <li key={`${record.at}-${index}`}>{TEXT.activity.line(record.at, record.deviceName, record.method ?? record.kind, record.outcome)}</li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <Dialog open={request !== null} onOpenChange={(open) => !open && request !== null && answer(request.requestId, false)}>
        <DialogContent data-testid="remote-pair-dialog">
          <DialogTitle>{TEXT.dialog.title}</DialogTitle>
          {request !== null ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col">
                <span data-testid="remote-pair-name" className="font-medium">
                  {TEXT.dialog.unverified(request.name)}
                </span>
                <span className="text-xs text-muted-foreground">{TEXT.dialog.platform(request.platform)}</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-xs text-muted-foreground">{TEXT.dialog.codeLabel}</span>
                <span data-testid="remote-pair-sas" className="font-mono text-3xl tracking-widest">
                  {request.sas}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{TEXT.dialog.compare}</p>
              <DialogFooter>
                <Button type="button" variant="outline" data-testid="remote-pair-deny" onClick={() => answer(request.requestId, false)}>
                  {TEXT.dialog.deny}
                </Button>
                <Button type="button" data-testid="remote-pair-allow" onClick={() => answer(request.requestId, true)}>
                  {TEXT.dialog.allow}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
