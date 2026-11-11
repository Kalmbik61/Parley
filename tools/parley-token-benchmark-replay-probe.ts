// T9a harness, slice H2b: the probe that tells the log a REAL handler started. It imports nothing from core or host, so a test file can name it inside
// a `vi.mock` factory for the core module without a circular import.

type StartListener = (method: string) => void;
const startListeners = new Set<StartListener>();
/** Subscribes to every start of the real tool runner's `call`; returns the unsubscribe. */
export const onHandlerStart = (listener: StartListener): (() => void) => { startListeners.add(listener); return () => { startListeners.delete(listener); }; };

/**
 * For a test file's `vi.mock('../packages/core/dist/index.js', async (orig) => withHandlerProbe(await orig()))`: the real module with its
 * `createToolRunner` wrapped, so each `call` that the endpoint really starts is reported. The endpoint's replay memory sits in front of it: a retry of
 * a callId it has already seen never reaches `call`, and so is never reported.
 */
export function withHandlerProbe<T extends { createToolRunner: (context: never) => { call: (...args: never[]) => unknown } }>(real: T): T {
  return {
    ...real,
    createToolRunner: (context: never) => {
      const runner = real.createToolRunner(context);
      return { ...runner, call: (...args: never[]) => { for (const l of startListeners) l(String(args[0])); return runner.call(...args); } };
    },
  } as T;
}

