/**
 * «Set up on my server…» (mobile app plan A18a, spec 6.7). The window asks for the SSH details and sends them to main;
 * it only ever gets back plan text, step progress and server output with the secrets masked.
 */
import { useEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import type { RelayPlanView, RelaySetupPhase, SetupAuthInput, SetupIntent } from '../../../shared/relay-setup-types.js';
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

interface StepRow {
  id: string;
  title: string;
  status: keyof typeof T.stepStatus;
  lines: string[];
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
  const [rows, setRows] = useState<StepRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!open) return;
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
      if (event.event === 'step') {
        setRows((current) => {
          const index = current.findIndex((row) => row.id === event.id);
          if (index < 0) return [...current, { id: event.id, title: event.title, status: event.status, lines: [] }];
          return current.map((row, i) => (i === index ? { ...row, status: event.status } : row));
        });
      } else {
        setRows((current) => current.map((row) => (row.id === event.step ? { ...row, lines: [...row.lines.slice(-200), event.text] } : row)));
      }
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [open, setup]);

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
      if (alive.current) setError(info.code === 'bad_input' ? info.message : (T.errors as Record<string, string>)[info.code] ?? T.errors.setup_failed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const close = (): void => {
    void setup.call('cancel', {}).catch(() => undefined);
    wipeSecrets();
    setPhase(null);
    setRows([]);
    setError(null);
    setRemoveData(false);
    onClose();
  };

  const begin = (): void => {
    const auth: SetupAuthInput = authKind === 'key' ? { kind: 'key', file: keyFile } : { kind: authKind };
    setRows([]);
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

  const terminal = phase !== null && ['hostkey-changed', 'auth-failed', 'unsupported', 'done', 'removed', 'failed'].includes(phase.phase);
  const planPhase = phase?.phase === 'plan' ? phase : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="relay-setup-dialog" className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>{T.title}</DialogTitle>
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
                setRows([]);
                setPhase({ phase: 'running' });
                void step(() => setup.call('run', { removeData }));
              }}
              onCancel={close}
            />
          ) : null}

          {phase?.phase === 'running' || (terminal && rows.length > 0) ? (
            <ol data-testid="relay-setup-log" className="flex flex-col gap-2 text-xs">
              {rows.map((row) => (
                <li key={row.id}>
                  <div className="font-medium">{row.title} — {T.stepStatus[row.status]}</div>
                  {row.lines.length > 0 ? <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5">{row.lines.join('\n')}</pre> : null}
                </li>
              ))}
            </ol>
          ) : null}

          {phase?.phase === 'proxy-pending' ? (
            <>
              <p>{T.proxyPending(phase.address)}</p>
              <pre data-testid="relay-setup-snippet" className="overflow-auto rounded bg-muted p-2 text-xs">{phase.snippet}</pre>
              <p className="text-xs text-muted-foreground">{phase.certificateHint}</p>
              <DialogFooter>
                <Button type="button" data-testid="relay-setup-check" disabled={busy} onClick={() => void step(() => setup.call('check', {}))}>{T.checkAgain}</Button>
              </DialogFooter>
            </>
          ) : null}

          {phase?.phase === 'done' ? (
            <p data-testid="relay-setup-done">{T.done(phase.address)} {phase.configured ? T.doneConfigured : T.doneNotConfigured}</p>
          ) : null}
          {phase?.phase === 'removed' ? <p data-testid="relay-setup-removed">{T.removed}</p> : null}
          {phase?.phase === 'failed' ? (
            <>
              <p data-testid="relay-setup-failed" className="text-destructive">{T.failed}: {phase.message}</p>
              {phase.step === 'health' ? (
                <DialogFooter>
                  <Button type="button" data-testid="relay-setup-check" disabled={busy} onClick={() => void step(() => setup.call('check', {}))}>{T.checkAgain}</Button>
                </DialogFooter>
              ) : null}
            </>
          ) : null}
          {error !== null && phase !== null && phase.phase !== 'need-passphrase' && phase.phase !== 'need-sudo' ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}

          {terminal ? (
            <DialogFooter>
              <Button type="button" data-testid="relay-setup-close" onClick={close}>{T.close}</Button>
            </DialogFooter>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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
