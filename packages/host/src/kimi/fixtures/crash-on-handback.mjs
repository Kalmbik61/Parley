import { onMapWritten, viewMap } from '@parley/core';
import { startHost } from '../../host.ts';

// Never used by the host binary. The parent test supplies a disposable home and fixture Kimi.
const [home, encoded] = process.argv.slice(2);
const ref = JSON.parse(encoded);
await startHost({ home });
onMapWritten(({ projectPath, workId }) => {
  if (projectPath !== ref.projectPath || workId !== ref.workId) return;
  const released = viewMap(projectPath, workId, ({ sessions }) =>
    sessions.some((session) => session.id === ref.sessionId && session.kimiTerminal === undefined));
  // onMapWritten runs after SQLite commits and before the awaiting handler can publish Chat.
  if (released) process.kill(process.pid, 'SIGKILL');
});
process.send('ready');
