// Classifies one phone in the JSON of `xcrun devicectl list devices --json-output`: `node device-state.mjs <json> <hardware UDID>`.
// `tunnelState` is not the readiness signal: a wired, paired phone reports "disconnected" until a device command brings the
// tunnel up. Ready = paired and reachable over a cable or the network; "unavailable" tunnel = not reachable at all.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @returns {{ state: 'ready' | 'unpaired' | 'unavailable' | 'absent', name: string, developerMode: string }} */
export function classifyDevice(json, udid) {
  const d = (json?.result?.devices ?? []).find((x) => x?.hardwareProperties?.udid === udid);
  if (!d) return { state: 'absent', name: '', developerMode: '' };
  const c = d.connectionProperties ?? {};
  const name = d.deviceProperties?.name ?? '';
  const developerMode = d.deviceProperties?.developerModeStatus ?? '';
  if (c.pairingState !== 'paired') return { state: 'unpaired', name, developerMode };
  const reachable = (c.transportType === 'wired' || c.transportType === 'localNetwork') && c.tunnelState !== 'unavailable';
  return { state: reachable ? 'ready' : 'unavailable', name, developerMode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let json = null;
  try {
    json = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  } catch {
    /* absent */
  }
  const r = classifyDevice(json, process.argv[3]);
  console.log(`${r.state}|${r.name}|${r.developerMode}`);
}
