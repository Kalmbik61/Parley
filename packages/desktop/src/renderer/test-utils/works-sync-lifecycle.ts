import { WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE, type WorksMailStatePage, type WorksSyncSurfaceBatch, type WorksSyncSurfaceStatus } from '@parley/protocol';
import type { FakeBridge } from './fake-bridge.js';
import { makeWork } from './work-fixtures.js';

/** Main-owned recovery fixture: automatic existing-host handshake fails; explicit retry succeeds. */
export function worksSyncLifecycle(bridge: FakeBridge) {
  const entry = { ...makeWork('w-01'), version: 1 };
  const key = { projectPath: entry.projectPath, workId: entry.map.work.id };
  const connected = { state: 'connected' as const, hostVersion: 'test',
    methods: ['works.sync', 'works.mailState'], features: [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE] };
  let batch!: (value: WorksSyncSurfaceBatch) => void | Promise<void>;
  let status!: (value: WorksSyncSurfaceStatus) => void;
  let rejectMail!: (error: Error) => void;
  let reads = 0, subscriptions = 0, unsubscribes = 0, automaticAttempts = 0, explicitAttempts = 0;
  const mail: WorksMailStatePage = { kind: 'mail-page', epoch: 'a', key, sourceVersion: 1, requiredStructuralVersion: 1,
    index: 0, cursor: 'mail', next: null, commit: true, records: [
      { kind: 'mail-summary', key, unreadLetters: 3 },
      { kind: 'section', key, field: 'mailRooms', start: 0, items: [], final: true },
      { kind: 'section', key, field: 'unreadRooms', start: 0, items: [], final: true },
      { kind: 'section', key, field: 'mentionCandidates', start: 0, items: [], final: true },
    ] };
  bridge.setHandler('works.mailState', () => ++reads === 1 ? new Promise((_resolve, reject) => { rejectMail = reject; }) : mail);
  const reset = async () => {
    await batch({ kind: 'works-sync-batch', transaction: { mode: 'reset', epoch: 'a', base: 0, target: 1 }, index: 0, commit: true,
      records: [{ kind: 'work', key, work: entry.map.work, version: 1 }, ...Object.entries(entry.map)
        .filter(([field]) => field !== 'work' && field !== 'schemaVersion')
        .map(([field, row]) => ({ kind: 'row' as const, key, field, row }))] });
    status({ state: 'current', epoch: 'a', applied: 1 });
  };
  bridge.worksSync = {
    subscribe(onBatch, onStatus) {
      subscriptions++; batch = onBatch; status = onStatus;
      status({ state: 'loading', epoch: null, applied: 0, wanted: 1, rows: 0, pages: 0 });
      return () => { unsubscribes++; };
    },
    retry() {
      explicitAttempts++;
      bridge.emitStatus(connected);
      void reset();
    },
  };
  bridge.emitStatus(connected);
  return { entry, reset,
    failAutomaticRecovery() {
      automaticAttempts++;
      bridge.emitStatus({ state: 'disconnected', reason: 'existing host handshake failed' });
      status({ state: 'error', epoch: 'a', applied: 1, error: 'connection', retryable: true });
      rejectMail(new Error('connection lost'));
    },
    get subscriptions() { return subscriptions; }, get unsubscribes() { return unsubscribes; },
    get automaticAttempts() { return automaticAttempts; }, get explicitAttempts() { return explicitAttempts; },
  };
}
