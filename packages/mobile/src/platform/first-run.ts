// First-run wipe (spec §7.8): the iOS Keychain survives deleting the app, so a start without the install marker
// (a file in the app's own storage, which does not survive) erases every host record, once per install.
import type { HostStore } from '@parley/remote-client';

export interface InstallMarker {
  exists(): boolean | Promise<boolean>;
  create(): void | Promise<void>;
}

/** Returns `true` when the wipe ran. The marker is written after the wipe, so a crash in between repeats it. */
export async function wipeOnFirstRun(hosts: Pick<HostStore, 'wipeAll'>, marker: InstallMarker): Promise<boolean> {
  if (await marker.exists()) return false;
  await hosts.wipeAll();
  await marker.create();
  return true;
}
