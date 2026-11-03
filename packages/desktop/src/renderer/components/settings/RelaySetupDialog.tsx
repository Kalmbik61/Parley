/**
 * «Set up on my server…» (mobile app plan A18a, spec 6.7). The window asks for the SSH details and sends them to main;
 * it only ever gets back plan text, step progress and server output with the secrets masked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { describePullProgress, pullPercent, withRunEvent } from '../../../shared/relay-run-view.js';
import type { RelayPlanView, RelayRunView, RelaySetupEvent, RelaySetupPhase, SetupAuthInput, SetupIntent } from '../../../shared/relay-setup-types.js';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';

const T = S.settings.remote.wizard;

export interface RelaySetupDialogProps {
  bridge: ParleyBridge;
  open: boolean;
  onClose: () => void;
}

type AuthKind = SetupAuthInput['kind'];

export function RelaySetupDialog({ bridge, open, onClose }: RelaySetupDialogProps): JSX.Element {
  const setup = bridge.relaySetup;
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('root');
  const [authKind, setAuthKind] = useState<AuthKind>('agent');
  const [keyFile, setKeyFile] = useState('');
  const [keys, setKeys] = useState<{ files: string[]; agent: boolean }>({ files: [], agent: false });
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [intent, setIntent] = useState<SetupIntent>('install');
  const [removeData, setRemoveData] = useState(false);
  const [phase, setPhase] = useState<RelaySetupPhase | null>(null);
  /** The run record of main (spec 8.1): the window only shows it. `null`: no run, the form is on screen. */
  const [view, setView] = useState<RelayRunView | null>(null);
  /** The first `state` has answered; until then nothing is drawn, so a record is never replaced by an empty form. */
  const [ready, setReady] = useState(false);
  /** `run` was taken by main but its record could not be read: the run may still be live there, so Close must not cancel it. */
  const [lostRun, setLostRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  /** Events that arrive while `state` is being read wait here and are applied after the snapshot (spec 8.1). */
  const loading = useRef(false);
  const buffer = useRef<RelaySetupEvent[]>([]);

  /** Subscription first (done by the effect), then `state`, then the buffered events newer than the snapshot. */
  const loadState = useCallback(async (): Promise<RelayRunView | null> => {
    loading.current = true;
    buffer.current = [];
    try {
      let snapshot: RelayRunView | null = null;
      try {
        snapshot = await setup.call('state', {});
      } catch {
        snapshot = null;
      }
      if (!alive.current) return snapshot;
      if (snapshot !== null) for (const event of buffer.current) if (event.seq > snapshot.seq) snapshot = withRunEvent(snapshot, event);
      setView(snapshot);
      if (snapshot !== null) {
        setPhase(null);
        setLostRun(false);
      }
      return snapshot;
    } finally {
      loading.current = false;
      buffer.current = [];
    }
  }, [setup]);

  useEffect(() => {
    alive.current = true;
    if (!open) return;
    setReady(false);
    void setup.call('keys', {}).then(
      (found) => {
        if (!alive.current) return;
        setKeys(found);
        setKeyFile((current) => current || found.files[0] || '');
        if (found.agent) setAuthKind('agent');
        else if (found.files.length > 0) setAuthKind('key');
        else setAuthKind('password');
      },
      () => undefined,
    );
    const off = setup.on((event) => {
      if (!alive.current) return;
      if (loading.current) {
        buffer.current.push(event);
        return;
      }
      // Only events newer than the record apply; a duplicate or an old one is dropped.
      setView((current) => (current !== null && event.seq > current.seq ? withRunEvent(current, event) : current));
    });
    void loadState().then(() => {
      if (alive.current) setReady(true);
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [open, setup, loadState]);

  const wipeSecrets = (): void => {
    setPassword('');
    setPassphrase('');
    setSudoPassword('');
  };

  async function step(task: () => Promise<RelaySetupPhase>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await task();
      if (alive.current) setPhase(next);
    } catch (err: unknown) {
      const info = decodeIpcError(err);
      // `bad_request` says «session ended» only for the expired session; the other refusals keep their own words.
      const expired = info.code === 'bad_request' && /not expected now/.test(info.message);
      if (alive.current) setError(info.code === 'bad_input' ? info.message : expired ? T.errors.bad_request : info.code === 'bad_request' ? info.message : (T.errors as Record<string, string>)[info.code] ?? T.errors.setup_failed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  /** Before «Run»: the session is cancelled, the connection and the credentials are dropped. */
  const endSession = (): void => {
    void setup.call('cancel', {}).catch(() => undefined);
    wipeSecrets();
    setPhase(null);
    setView(null);
    setLostRun(false);
    setError(null);
    setRemoveData(false);
    onClose();
  };

  /** During a run and after it the cross only hides the window: the run goes on and the record stays in main. */
  const runActive = view !== null || lostRun || phase?.phase === 'running';
  const hide = (): void => {
    wipeSecrets();
    onClose();
  };
  const close = runActive ? hide : endSession;

  /** «Close» / «New setup» after the outcome: the record is forgotten. */
  const dismiss = async (): Promise<boolean> => {
    try {
      await setup.call('dismiss', {});
      return true;
    } catch {
      return false;
    }
  };
  const closeForGood = (): void => {
    void dismiss().then((ok) => {
      if (!ok || !alive.current) return;
      setView(null);
      setPhase(null);
      setLostRun(false);
      onClose();
    });
  };
  const newSetup = (): void => {
    void dismiss().then((ok) => {
      if (!ok || !alive.current) return;
      setView(null);
      setPhase(null);
      setLostRun(false);
      setError(null);
      setRemoveData(false);
    });
  };

  const begin = (): void => {
    const auth: SetupAuthInput = authKind === 'key' ? { kind: 'key', file: keyFile } : { kind: authKind };
    // The request is built, the form forgets the secrets, and only then does the (slow) call start.
    const payload = {
        host: host.trim(),
        port: port.trim(),
        user: user.trim(),
        auth,
        secrets: {
          ...(authKind === 'password' && password !== '' ? { password } : {}),
          ...(passphrase !== '' ? { passphrase } : {}),
          ...(sudoPassword !== '' ? { sudoPassword } : {}),
        },
        ...(domain.trim() !== '' ? { domain: domain.trim() } : {}),
        intent,
    };
    wipeSecrets();
    void step(() => setup.call('begin', payload));
  };

  const terminal = phase !== null && ['hostkey-changed', 'auth-failed', 'unsupported', 'failed'].includes(phase.phase);
  const planPhase = phase?.phase === 'plan' ? phase : null;
  // The wizard closes by the cross only: no Esc, no click on the backdrop, in any phase.
  const keepOpen = (event: Event): void => event.preventDefault();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        data-testid="relay-setup-dialog"
        className="max-h-[85vh] overflow-y-auto"
        onEscapeKeyDown={keepOpen}
        onPointerDownOutside={keepOpen}
        onInteractOutside={keepOpen}
      >
        <DialogTitle>{T.title}</DialogTitle>
        {view !== null ? (
          <RunRecord
            view={view}
            busy={busy}
            onCancel={() => void setup.call('cancel', {}).catch(() => undefined)}
            onCheck={() => void step(() => setup.call('check', {}))}
            onClose={closeForGood}
            onNewSetup={newSetup}
          />
        ) : null}
        {ready && view === null && phase?.phase === 'running' ? <p>{T.running}</p> : null}
        {ready && view === null ? (
        <div className="flex flex-col gap-3 text-sm">
          {phase === null ? (
            <>
              <p className="text-xs text-muted-foreground">{T.intro}</p>
              <label className="flex flex-col gap-1">
                <span>{T.host}</span>
                <Input data-testid="relay-setup-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.7" />
              </label>
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-1">
                  <span>{T.user}</span>
                  <Input data-testid="relay-setup-user" value={user} onChange={(e) => setUser(e.target.value)} />
                </label>
                <label className="flex w-24 flex-col gap-1">
                  <span>{T.port}</span>
                  <Input data-testid="relay-setup-port" value={port} onChange={(e) => setPort(e.target.value)} />
                </label>
              </div>
              <fieldset className="flex flex-col gap-1">
                <legend>{T.auth}</legend>
                {(['agent', 'key', 'password'] as const).map((kind) => (
                  <label key={kind} className="flex items-center gap-2">
                    <input type="radio" name="relay-auth" checked={authKind === kind} onChange={() => setAuthKind(kind)} data-testid={`relay-setup-auth-${kind}`} />
                    <span>{kind === 'agent' ? (keys.agent ? T.authAgent : T.authAgentMissing) : kind === 'key' ? T.authKey : T.authPassword}</span>
                  </label>
                ))}
              </fieldset>
              {authKind === 'key' ? (
                keys.files.length > 0 ? (
                  <label className="flex flex-col gap-1">
                    <span>{T.keyFile}</span>
                    <select data-testid="relay-setup-key" className="h-9 rounded-md border bg-background px-2" value={keyFile} onChange={(e) => setKeyFile(e.target.value)}>
                      {keys.files.map((file) => (
                        <option key={file} value={file}>
                          {file}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="text-xs text-muted-foreground">{T.noKeys}</p>
                )
              ) : null}
              {authKind === 'password' ? (
                <label className="flex flex-col gap-1">
                  <span>{T.password}</span>
                  <Input data-testid="relay-setup-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
              ) : null}
              <label className="flex flex-col gap-1">
                <span>{T.domain}</span>
                <Input data-testid="relay-setup-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="relay.example.com" />
                <span className="text-xs text-muted-foreground">{T.domainHint}</span>
              </label>
              <fieldset className="flex flex-col gap-1">
                <legend>{T.intent}</legend>
                {(['install', 'rollback', 'remove'] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2">
                    <input type="radio" name="relay-intent" checked={intent === value} onChange={() => setIntent(value)} data-testid={`relay-setup-intent-${value}`} />
                    <span>{T[value]}</span>
                  </label>
                ))}
              </fieldset>
              {error !== null ? <p data-testid="relay-setup-error" className="text-xs text-destructive">{error}</p> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>{T.cancel}</Button>
                <Button type="button" data-testid="relay-setup-connect" disabled={busy || host.trim() === ''} onClick={begin}>{T.connect}</Button>
              </DialogFooter>
            </>
          ) : null}

          {phase?.phase === 'hostkey' ? (
            <>
              <h3 className="font-medium">{T.hostKeyTitle}</h3>
              <p className="text-xs text-muted-foreground">{T.hostKeyText(phase.host, phase.port, phase.keyType)}</p>
              <code data-testid="relay-setup-fingerprint" className="break-all rounded bg-muted p-2 text-xs">{phase.fingerprint}</code>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>{T.cancel}</Button>
                <Button type="button" data-testid="relay-setup-trust" disabled={busy} onClick={() => void step(() => setup.call('trust', {}))}>{T.hostKeyTrust}</Button>
              </DialogFooter>
            </>
          ) : null}

          {phase?.phase === 'hostkey-changed' ? (
            <>
              <p data-testid="relay-setup-hostkey-changed" className="text-destructive">{T.hostKeyChanged(phase.host)}</p>
              <p className="text-xs">{T.hostKeyKnown}: <code className="break-all">{phase.known}</code></p>
              <p className="text-xs">{T.hostKeyPresented}: <code className="break-all">{phase.presented}</code></p>
            </>
          ) : null}

          {phase?.phase === 'need-passphrase' || phase?.phase === 'need-sudo' ? (
            <>
              <p>{phase.phase === 'need-passphrase' ? (phase.wrong ? T.wrongPassphrase : T.needPassphrase) : T.needSudo}</p>
              <Input
                data-testid="relay-setup-secret"
                type="password"
                autoComplete="off"
                value={phase.phase === 'need-passphrase' ? passphrase : sudoPassword}
                onChange={(e) => (phase.phase === 'need-passphrase' ? setPassphrase(e.target.value) : setSudoPassword(e.target.value))}
              />
              {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>{T.cancel}</Button>
                <Button
                  type="button"
                  data-testid="relay-setup-provide"
                  disabled={busy}
                  onClick={() => {
                    const value = phase.phase === 'need-passphrase' ? { passphrase } : { sudoPassword };
                    wipeSecrets();
                    void step(() => setup.call('provide', value));
                  }}
                >
                  {T.continue}
                </Button>
              </DialogFooter>
            </>
          ) : null}

          {phase?.phase === 'auth-failed' ? <p data-testid="relay-setup-auth-failed" className="text-destructive">{T.authFailed}</p> : null}

          {phase?.phase === 'unsupported' ? (
            <>
              <p data-testid="relay-setup-unsupported">{T.unsupported(phase.os)}</p>
              <p className="text-xs">{T.manual}: <code>{phase.manualUrl}</code></p>
            </>
          ) : null}

          {planPhase !== null ? (
            <PlanView
              plan={planPhase.plan}
              os={planPhase.os}
              removeData={removeData}
              busy={busy}
              onRemoveData={(value) => {
                setRemoveData(value);
                void step(() => setup.call('plan', { removeData: value }));
              }}
              onRun={() => {
                // `phase` stays on the plan until main has taken the run: a refused `run` (the session ended on an idle
                // timer) leaves the plan with its error instead of a «Running…» nobody can leave.
                void step(async () => {
                  const started = await setup.call('run', { removeData });
                  if (started.phase !== 'running') return started;
                  // The record exists in main now: read it (events that come meanwhile wait for it).
                  // One more read before giving up: the run is live in main, a failed read must not look like a failed run.
                  const record = (await loadState()) ?? (await loadState());
                  if (record !== null) return { phase: 'running' as const };
                  setLostRun(true);
                  return { phase: 'failed' as const, step: null, message: T.runLost };
                });
              }}
              onCancel={close}
            />
          ) : null}

          {phase?.phase === 'failed' ? <p data-testid="relay-setup-failed" className="text-destructive">{T.failed}: {phase.message}</p> : null}
          {error !== null && phase !== null && phase.phase !== 'need-passphrase' && phase.phase !== 'need-sudo' ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}

          {terminal ? (
            <DialogFooter>
              {/* A live run in main is not ours to cancel when the window only failed to read it. */}
              <Button type="button" data-testid="relay-setup-close" onClick={lostRun ? hide : endSession}>{T.close}</Button>
            </DialogFooter>
          ) : null}
        </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const PHASE_TEXT_ID: Record<string, string> = { done: 'relay-setup-done', removed: 'relay-setup-removed', failed: 'relay-setup-failed', cancelled: 'relay-setup-cancelled' };

/** The run as main keeps it (spec 8.1): steps with their lines, the download bar, the outcome and its footer. */
function RunRecord(props: {
  view: RelayRunView;
  busy: boolean;
  onCancel: () => void;
  onCheck: () => void;
  onClose: () => void;
  onNewSetup: () => void;
}): JSX.Element {
  const { view } = props;
  const phase = view.phase;
  const running = phase.phase === 'running';
  // An interruptible step gets no `cancelling` event: the button answers the click at once, locally.
  const [asked, setAsked] = useState(false);
  // A new phase (cancelled at health → Check → running again) gives Cancel back.
  useEffect(() => setAsked(false), [phase.phase]);
  const canCheck = phase.phase === 'proxy-pending' || ((phase.phase === 'failed' || phase.phase === 'cancelled') && phase.step === 'health');
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="relay-setup-record">
      <ol data-testid="relay-setup-log" className="flex flex-col gap-2 text-xs">
        {view.steps.map((row) => (
          <li key={row.id}>
            <div className="font-medium">{row.title} — {T.stepStatus[row.status]}</div>
            {view.progress?.step === row.id ? (
              <div className="my-1 flex flex-col gap-1">
                <div
                  role="progressbar"
                  aria-label={T.progressLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pullPercent(view.progress)}
                  data-testid="relay-setup-progress"
                  className="h-1.5 w-full overflow-hidden rounded bg-muted"
                >
                  <div className="h-full bg-primary" style={{ width: `${pullPercent(view.progress)}%` }} />
                </div>
                <span data-testid="relay-setup-progress-text">{T.downloading(describePullProgress(view.progress))}</span>
              </div>
            ) : null}
            {row.lines.length > 0 ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5">{row.lines.join('\n')}</pre> : null}
          </li>
        ))}
      </ol>

      {running && view.cancelling ? <p data-testid="relay-setup-cancelling" className="text-xs text-muted-foreground">{T.cancelling}</p> : null}

      {phase.phase === 'proxy-pending' ? (
        <>
          <p>{T.proxyPending(phase.address)}</p>
          <pre data-testid="relay-setup-snippet" className="overflow-auto rounded bg-muted p-2 text-xs">{phase.snippet}</pre>
          <p className="text-xs text-muted-foreground">{phase.certificateHint}</p>
        </>
      ) : null}
      {phase.phase === 'done' ? <p data-testid={PHASE_TEXT_ID.done}>{T.done(phase.address)} {phase.configured ? T.doneConfigured : T.doneNotConfigured}</p> : null}
      {phase.phase === 'removed' ? <p data-testid={PHASE_TEXT_ID.removed}>{T.removed}</p> : null}
      {phase.phase === 'failed' ? <p data-testid={PHASE_TEXT_ID.failed} className="text-destructive">{T.failed}: {phase.message}</p> : null}
      {/* A cancel is not an error: no red. */}
      {phase.phase === 'cancelled' ? <p data-testid={PHASE_TEXT_ID.cancelled}>{phase.message}</p> : null}

      <DialogFooter>
        {running ? (
          <Button type="button" variant="outline" data-testid="relay-setup-cancel-run" disabled={view.cancelling || asked} onClick={() => {
            setAsked(true);
            props.onCancel();
          }}>{T.cancel}</Button>
        ) : (
          <>
            {canCheck ? <Button type="button" data-testid="relay-setup-check" disabled={props.busy} onClick={props.onCheck}>{T.checkAgain}</Button> : null}
            <Button type="button" variant="outline" data-testid="relay-setup-new" onClick={props.onNewSetup}>{T.newSetup}</Button>
            <Button type="button" data-testid="relay-setup-close" onClick={props.onClose}>{T.close}</Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

/** «Your web server» (spec 8.3): who holds the ports, the Docker network, and a card for every edit of their files. */
function WebBlock({ web }: { web: NonNullable<RelayPlanView['web']> }): JSX.Element {
  return (
    <section data-testid="relay-setup-web" className="flex flex-col gap-2 rounded border p-2 text-xs">
      <h4 className="font-medium">{T.webTitle}</h4>
      <p>{web.summary}</p>
      {web.network !== null ? <p className="text-muted-foreground">{T.webNetwork}: <code>{web.network}</code></p> : null}
      {web.edits.map((edit) => (
        <div key={`${edit.file}-${edit.action}`} data-testid="relay-setup-web-edit" className="flex flex-col gap-1 rounded bg-muted p-2">
          <div className="font-medium">{T.webEditTitle}</div>
          <div>{T.webEdit.server}: {edit.server}</div>
          <div>{T.webEdit.file}: <code className="break-all">{edit.file}</code></div>
          <div>{T.webEdit.action}: {T.webAction[edit.action]}</div>
          {edit.content !== null ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{edit.content}</pre> : null}
          <div>{T.webEdit.backup}: <code className="break-all">{edit.backup}</code></div>
          <div>{T.webEdit.check}: <code className="break-all">{edit.check}</code></div>
          <div>{T.webEdit.reload}: <code className="break-all">{edit.reload}</code></div>
        </div>
      ))}
    </section>
  );
}

function PlanView(props: {
  plan: RelayPlanView;
  os: string;
  removeData: boolean;
  busy: boolean;
  onRemoveData: (value: boolean) => void;
  onRun: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { plan } = props;
  return (
    <>
      <h3 className="font-medium">{T.planTitle}</h3>
      <p className="text-xs text-muted-foreground">{T.planOn(props.os)}</p>
      {plan.web !== null ? <WebBlock web={plan.web} /> : null}
      {plan.blocked !== null ? (
        <p data-testid="relay-setup-blocked" className="text-destructive">{T.blocked}: {plan.blocked}</p>
      ) : (
        <ol data-testid="relay-setup-plan" className="flex flex-col gap-2 text-xs">
          {plan.steps.map((planStep, index) => (
            <li key={planStep.id}>
              <div className="font-medium">{index + 1}. {planStep.title}</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5">
                {[...(planStep.check !== null ? [`# ${T.check}: ${planStep.check}`] : []), ...planStep.commands].join('\n')}
              </pre>
            </li>
          ))}
        </ol>
      )}
      <ul className="list-disc pl-4 text-xs text-muted-foreground">
        {plan.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      {plan.intent === 'remove' && plan.blocked === null ? (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" data-testid="relay-setup-remove-data" checked={props.removeData} disabled={props.busy} onChange={(e) => props.onRemoveData(e.target.checked)} />
          <span>{T.removeData}</span>
        </label>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onCancel}>{T.cancel}</Button>
        <Button type="button" data-testid="relay-setup-run" disabled={props.busy || plan.blocked !== null} onClick={props.onRun}>{T.run}</Button>
      </DialogFooter>
    </>
  );
}
