import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dns from 'node:dns/promises';
import type { IpcMain, Net } from 'electron';
import { RELAY_SETUP_CALL_NAMES, type RelaySetupCallName, type RelaySetupEvent } from '../../shared/relay-setup-types.js';
import { ControlCallError } from '../remote-control.js';
import { withIpcError } from '../ipc.js';
import type { HealthFetcher } from './health.js';
import { isImagePublished, pinnedImageRef } from './image.js';
import { createKnownHosts } from './known-hosts.js';
import { createRunLog } from './log.js';
import { createRelaySetup, type RelaySetupDeps, type RelaySetupService } from './service.js';
import { connectSsh } from './ssh.js';

/** What a scripted server may replace (e2e only, see `fakeSshModulePath`). */
export type RelaySetupOverrides = Partial<Pick<RelaySetupDeps, 'connect' | 'health' | 'resolver' | 'image' | 'configureBridge' | 'healthAttempts' | 'healthDelayMs'>>;

/**
 * The e2e seam of the window screenshots (spec 10): `PARLEY_RELAY_SETUP_FAKE_SSH` names a module that provides a
 * scripted `connect` (and stubs for the health probe) instead of `ssh2`. It exists only in an unpackaged build: a
 * packaged app never reads the variable, so a person's installation cannot be pointed at a script.
 */
export function fakeSshModulePath(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  if (isPackaged) return null;
  const file = env['PARLEY_RELAY_SETUP_FAKE_SSH'];
  return file !== undefined && file !== '' && path.isAbsolute(file) ? file : null;
}

export async function loadFakeSsh(file: string): Promise<RelaySetupOverrides> {
  const module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as RelaySetupOverrides;
  if (typeof module.connect !== 'function') throw new Error('the scripted SSH module has no connect()');
  return module;
}

export interface RelaySetupWiring {
  /** `~/.parley/remote` — `known_hosts` and `relay-setup.log` live there. */
  remoteDir: string;
  configureBridge: (address: string) => Promise<void>;
  emit: (event: RelaySetupEvent) => void;
  /** Electron's `net`: its requests use the system certificate store (spec 6.7 step 6). */
  net: Pick<Net, 'fetch'>;
  /** E2E only. */
  overrides?: RelaySetupOverrides;
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
    ...wiring.overrides,
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
