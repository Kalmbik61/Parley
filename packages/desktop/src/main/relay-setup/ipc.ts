import path from 'node:path';
import dns from 'node:dns/promises';
import type { IpcMain, Net } from 'electron';
import { RELAY_SETUP_CALL_NAMES, type RelaySetupCallName, type RelaySetupEvent } from '../../shared/relay-setup-types.js';
import { ControlCallError } from '../remote-control.js';
import { withIpcError } from '../ipc.js';
import type { HealthFetcher } from './health.js';
import { isImagePublished, pinnedImageRef } from './image.js';
import { createKnownHosts } from './known-hosts.js';
import { createRunLog } from './log.js';
import { createRelaySetup, type RelaySetupService } from './service.js';
import { connectSsh } from './ssh.js';

export interface RelaySetupWiring {
  /** `~/.parley/remote` — `known_hosts` and `relay-setup.log` live there. */
  remoteDir: string;
  configureBridge: (address: string) => Promise<void>;
  emit: (event: RelaySetupEvent) => void;
  /** Electron's `net`: its requests use the system certificate store (spec 6.7 step 6). */
  net: Pick<Net, 'fetch'>;
}

export function createAppRelaySetup(wiring: RelaySetupWiring): RelaySetupService {
  const health: HealthFetcher = async (url) => {
    const response = await wiring.net.fetch(url);
    return { status: response.status };
  };
  return createRelaySetup({
    knownHosts: createKnownHosts(path.join(wiring.remoteDir, 'known_hosts')),
    connect: connectSsh,
    log: createRunLog(path.join(wiring.remoteDir, 'relay-setup.log'), () => [] /* the service masks the run's secrets before it writes a line */),
    image: { ref: pinnedImageRef(), published: isImagePublished() },
    health,
    resolver: { resolve4: (h) => dns.resolve4(h), resolve6: (h) => dns.resolve6(h) },
    configureBridge: wiring.configureBridge,
    emit: wiring.emit,
  });
}

/** `relay-setup:call` — one channel, limited to `RELAY_SETUP_CALL_NAMES`. Unexpected errors never carry their text to the window. */
export function registerRelaySetupIpc(ipcMain: IpcMain, service: RelaySetupService): void {
  const allowed = new Set<string>(RELAY_SETUP_CALL_NAMES);
  ipcMain.handle(
    'relay-setup:call',
    withIpcError(async (_event, name: unknown, params: unknown) => {
      if (typeof name !== 'string' || !allowed.has(name)) throw new ControlCallError('bad_request', 'unknown relay setup method');
      const args = typeof params === 'object' && params !== null ? params : {};
      try {
        return await service.call(name as RelaySetupCallName, args as never);
      } catch (error) {
        if (error instanceof ControlCallError) throw error;
        throw new ControlCallError('setup_failed', 'The setup step failed');
      }
    }),
  );
}
