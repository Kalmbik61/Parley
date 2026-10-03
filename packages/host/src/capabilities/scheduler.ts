type Provider = 'claude' | 'codex';
export class ProviderSchedulerError extends Error {
  constructor(readonly code: 'shutdown' | 'operation-failed') { super(code); }
}
type Job = { controller: AbortController; run: () => Promise<void>; cancel: () => void };

/** One instance per host, shared by MCP and plugin actions across every project. */
export function createProviderScheduler() {
  const queues: Record<Provider, Job[]> = { claude: [], codex: [] };
  const active: Partial<Record<Provider, Job>> = {};
  let disposed = false;
  const pump = (provider: Provider): void => {
    if (disposed || active[provider]) return;
    const job = queues[provider].shift();
    if (!job) return;
    active[provider] = job;
    void job.run().finally(() => { delete active[provider]; pump(provider); });
  };
  return {
    run<T>(provider: Provider, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (disposed) return Promise.reject(new ProviderSchedulerError('shutdown'));
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        const cancel = (): void => { controller.abort(); reject(new ProviderSchedulerError('shutdown')); };
        queues[provider].push({ controller, cancel, run: async () => {
          try {
            const value = await operation(controller.signal);
            if (disposed || controller.signal.aborted) cancel();
            else resolve(value);
          } catch { reject(new ProviderSchedulerError(disposed ? 'shutdown' : 'operation-failed')); }
        } });
        pump(provider);
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const provider of ['claude', 'codex'] as const) {
        for (const job of queues[provider].splice(0)) job.cancel();
        active[provider]?.cancel();
      }
    },
  };
}
export type ProviderScheduler = ReturnType<typeof createProviderScheduler>;
