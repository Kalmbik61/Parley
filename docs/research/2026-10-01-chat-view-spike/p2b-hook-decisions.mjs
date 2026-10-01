// P2b: ответ на запрос разрешения решением хука (allow / deny / setMode) и таймаут хука.
import fs from 'node:fs';
import path from 'node:path';
import { Session, KEY, sleep, describeEvents, PROJ } from './lib.mjs';
const s = new Session('p2b-hook-decisions', { settings: { timeouts: { PermissionRequest: 8 } } });
let from = 0;
const section = (title) => { console.log(`\n===== ${title} =====`); from = s.events.length; };
const turnEvents = () => console.log(describeEvents(s, from).join('\n'));
const tail = async (n, label) => (await s.snap(label)).split('\n').slice(-n).join('\n');
const sawDialog = (since) => fs.readFileSync(path.join(s.out, 'pty.raw'), 'utf8').slice(since).includes('Do you want to proceed');
const rawLen = () => fs.statSync(path.join(s.out, 'pty.raw')).size;
try {
  await s.waitEvent('SessionStart', (ev) => ev.hook_event_name === 'SessionStart', { timeoutMs: 40000 });
  await s.quiet(1200, 20000);

  section('D. хук держит запрос 2.5 с, потом allow');
  s.control({ PermissionRequest: 'wait' });
  let mark = rawLen();
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-1');
  await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  await sleep(2500);
  console.log('--- экран, пока хук держит запрос ---\n' + (await tail(10, 'd-hook-holding')));
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  await sleep(400);
  turnEvents();
  console.log('каталог создан:', fs.existsSync(path.join(PROJ, 'probe-dir-1')), '| диалог показывался:', sawDialog(mark));

  section('E. хук отвечает deny с сообщением');
  mark = rawLen();
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-2');
  await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user declined this command in the Parley window. Do not retry it.' } } });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  await sleep(400);
  turnEvents();
  const stopE = s.events.slice(from).find((r) => r.ev?.hook_event_name === 'Stop');
  console.log('ответ модели:', JSON.stringify(stopE.ev.last_assistant_message).slice(0, 220));
  console.log('каталог создан:', fs.existsSync(path.join(PROJ, 'probe-dir-2')), '| диалог показывался:', sawDialog(mark));
  console.log('--- экран ---\n' + (await tail(9, 'e-after-deny')));

  section('F. хук allow + setMode acceptEdits (session)');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-3');
  const permF = await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  console.log('режим в запросе:', permF.ev.permission_mode, '| suggestions:', JSON.stringify(permF.ev.permission_suggestions));
  const statusBefore = s.status.length;
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } } });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  await s.quiet(1500, 15000);
  turnEvents();
  console.log('подвал экрана:\n' + (await tail(2, 'f-after-setmode')));
  console.log('permission-mode в журнале (последние 4):', s.logs.filter((l) => l.rec.type === 'permission-mode').map((l) => l.rec.permissionMode).slice(-4).join(','));
  console.log('строка статуса: было', statusBefore, 'стало', s.status.length);

  section('G. хук молчит дольше таймаута (8 с) — должен появиться обычный диалог');
  mark = rawLen();
  const t0 = Date.now();
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-4');
  const permG = await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  console.log('режим в запросе:', permG.ev.permission_mode);
  await s.waitScreen('диалог после таймаута', /Do you want to proceed/, 30000);
  console.log('диалог появился через', Date.now() - permG.t, 'мс после PermissionRequest');
  console.log('--- экран ---\n' + (await tail(8, 'g-dialog-after-timeout')));
  s.write(KEY.enter, 'enter=Yes');
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  turnEvents();
  console.log('каталог создан:', fs.existsSync(path.join(PROJ, 'probe-dir-4')));
  s.control({});
} catch (error) {
  console.log('ОШИБКА:', error.message);
  console.log((await s.screen()).split('\n').slice(-25).join('\n'));
} finally {
  await s.close();
  console.log('выход:', JSON.stringify(s.exited));
}
