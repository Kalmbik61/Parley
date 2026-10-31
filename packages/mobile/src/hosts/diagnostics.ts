// Rows of Settings → Diagnostics (D1 §11.3), as plain data so they can be tested.
import type { HostRecord, HostStatus, SupervisorStatus } from '@parley/remote-client';

export interface DiagnosticsInput {
  host: HostRecord | null;
  supervisor: SupervisorStatus | null;
  hostStatus: HostStatus | null;
  /** Round trip of the last `ping`, ms. */
  rtt: number | null;
}

export function diagnosticsRows({ host, supervisor, hostStatus, rtt }: DiagnosticsInput): Array<{ key: string; value: string }> {
  const dash = '—';
  const hello = supervisor?.hello ?? null;
  const connected = host !== null && host.lastTs > 0 ? new Date(host.lastTs).toLocaleString('en-US') : dash;
  return [
    { key: 'Relay', value: host?.relay ?? dash },
    { key: 'State', value: supervisor === null ? dash : (supervisor.blocked ?? supervisor.state) },
    { key: 'RTT', value: rtt === null ? dash : `${rtt} ms` },
    { key: 'Last connected', value: connected },
    { key: 'Host', value: hostStatus ?? hello?.host ?? dash },
    { key: 'Epoch', value: hello?.epoch ?? dash },
    { key: 'Bridge version', value: hello?.bridgeVersion ?? dash },
    { key: 'Host version', value: hello?.hostVersion ?? dash },
    { key: 'Stage', value: hello?.stage === undefined ? dash : String(hello.stage) },
    // Only the first 8 characters of the device id: enough to match the Mac's device list, not a credential.
    { key: 'Device ID', value: host === null ? dash : host.deviceId.slice(0, 8) },
  ];
}
