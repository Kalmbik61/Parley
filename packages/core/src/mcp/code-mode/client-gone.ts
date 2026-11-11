// A replacement launch whose client is gone (plan T8h, §4). An MCP server's stdin closes when its client goes. A classic process then lingers
// while a socket keeps it alive; this one ends as soon as no started call waits for its receipt, so a held run does not leave a process behind.
// Nothing is forced and nothing is asked to cancel: no timer, no kill. A count that never reaches 0 leaves the process alive, the launcher
// picks classic all the same, and that is a stated limit. Direct calls have no ledger entry, so a pending direct call is cut: its client is gone.

import type { SessionScheduler } from './scheduler.js';

export function exitWhenClientGone(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, scheduler: Pick<SessionScheduler, 'whenClientGone'>, exit: () => void): void {
  // Nobody reads the answer any more: a write to the closed pipe must not end the process before its calls settle.
  stdout.on('error', () => undefined);
  let gone = false;
  const onGone = (): void => {
    if (gone) return;
    gone = true;
    void scheduler.whenClientGone().then(exit);
  };
  stdin.once('end', onGone);
  stdin.once('close', onGone);
}
