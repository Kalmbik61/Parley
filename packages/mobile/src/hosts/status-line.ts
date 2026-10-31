// The second line of the current Mac in Settings → Macs (D1 §11).
import type { HostStatus, SupervisorStatus } from '@parley/remote-client';

export function hostStatusLine(sup: SupervisorStatus | null, host: HostStatus | null, rtt: number | null): string {
  if (sup === null) return 'Not connected';
  if (sup.blocked !== null) return 'Needs attention';
  switch (sup.state) {
    case 'ready':
      if (host === 'offline') return "Parley isn't running";
      if (host === 'starting') return 'Mac is starting…';
      return rtt === null ? 'Connected' : `Connected · ${rtt} ms`;
    case 'offline':
      return 'No internet connection';
    case 'waiting':
      return 'Reconnecting…';
    default:
      return 'Connecting…';
  }
}
