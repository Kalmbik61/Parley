import type { IpcRenderer } from 'electron';
import type { WorksSyncSurfaceBatch, WorksSyncSurfaceStatus } from '@parley/protocol';
import type { WorksSyncBridge } from '../shared/bridge.js';

/** Подтверждение после reducer/consumer, а не сразу после доставки Electron. */
export function createWorksSyncBridge(ipc: Pick<IpcRenderer, 'on' | 'send'>): WorksSyncBridge {
  let nextStream = 0;
  type Consumer = { stream: number; batch: Parameters<WorksSyncBridge['subscribe']>[0];
    status: Parameters<WorksSyncBridge['subscribe']>[1]; last: WorksSyncSurfaceStatus | null; failed: boolean };
  let consumer: Consumer | null = null;
  ipc.on('works-sync:batch', async (_event, stream: number, delivery: number, batch: WorksSyncSurfaceBatch) => {
    const current = consumer;
    if (current === null || current.stream !== stream || current.failed) return;
    try {
      await current.batch(batch);
      if (consumer === current && current.stream === stream && !current.failed) ipc.send('works-sync:ack', stream, delivery);
    } catch {
      if (consumer !== current || current.stream !== stream) return;
      current.failed = true;
      const failure: WorksSyncSurfaceStatus = { state: 'error', epoch: current.last?.epoch ?? batch.transaction.epoch,
        applied: current.last?.applied ?? batch.transaction.base, error: 'protocol', retryable: true };
      current.last = failure;
      ipc.send('works-sync:unsubscribe', stream);
      // Ошибка сохраняется до явного ремонта; callback остаётся для новой подписки.
      try { current.status(failure); } catch { /* Consumer status callback also failed. */ }
    }
  });
  ipc.on('works-sync:status', (_event, stream: number, status: WorksSyncSurfaceStatus) => {
    if (consumer?.stream !== stream || consumer.failed) return;
    consumer.last = status;
    consumer.status(status);
  });
  return {
    subscribe(batch, status) {
      if (consumer !== null) ipc.send('works-sync:unsubscribe', consumer.stream);
      const current: Consumer = { stream: ++nextStream, batch, status, last: null, failed: false };
      consumer = current;
      ipc.send('works-sync:subscribe', current.stream);
      return () => {
        if (consumer !== current) return;
        consumer = null;
        ipc.send('works-sync:unsubscribe', current.stream);
      };
    },
    retry: () => {
      if (consumer?.failed) {
        consumer.stream = ++nextStream;
        consumer.failed = false;
        ipc.send('works-sync:subscribe', consumer.stream);
      }
      ipc.send('works-sync:retry');
    },
  };
}
