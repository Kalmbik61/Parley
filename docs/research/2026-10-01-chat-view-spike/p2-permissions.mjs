// P2: запрос разрешения — что отдаёт хук, как выглядит диалог, ответ клавишами и ответ решением хука.
import fs from 'node:fs';
import path from 'node:path';
import { Session, KEY, sleep, describeEvents, PROJ } from './lib.mjs';
const s = new Session('p2-permissions');
const keys = (o) => Object.keys(o ?? {}).join(', ');
const dialog = (text) => text.split('\n').filter((l) => /proceed|Yes|No,|don't ask|Bash|touch|mkdir|esc|❯|^\s+\d\./i.test(l)).join('\n');
let from = 0;
const section = (title) => { console.log(`\n===== ${title} =====`); from = s.events.length; };
const turnEvents = () => console.log(describeEvents(s, from).join('\n'));
const lastToolResult = () => {
  const recs = s.logs.map((l) => l.rec).filter((r) => r.type === 'user' && Array.isArray(r.message?.content));
  const r = recs.reverse().find((rec) => rec.message.content.some((b) => b.type === 'tool_result'));
  const b = r?.message.content.find((bb) => bb.type === 'tool_result');
  return b ? JSON.stringify(b.content).slice(0, 220) + (r.toolUseResult !== undefined ? ' | toolUseResult=' + JSON.stringify(r.toolUseResult).slice(0, 160) : '') : '(нет)';
};
try {
  await s.waitEvent('SessionStart', (ev) => ev.hook_event_name === 'SessionStart', { timeoutMs: 40000 });
  await s.quiet(1200, 20000);

  section('A. Bash touch — разрешить клавишей Enter');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": touch probe-a.txt');
  const permA = await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  console.log('PermissionRequest ключи:', keys(permA.ev));
  console.log('tool_input:', JSON.stringify(permA.ev.tool_input));
  console.log('permission_suggestions:', JSON.stringify(permA.ev.permission_suggestions));
  await sleep(600);
  console.log('--- диалог на экране ---\n' + dialog(await s.snap('perm-a-dialog')));
  s.write(KEY.enter, 'enter=Yes');
  await s.waitEvent('PostToolUse', (ev) => ev.hook_event_name === 'PostToolUse', { from });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  turnEvents();
  console.log('файл создан:', fs.existsSync(path.join(PROJ, 'probe-a.txt')));

  section('B. Bash touch — отказ клавишей Esc');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": touch probe-b.txt');
  await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  await sleep(600);
  s.write(KEY.esc, 'esc=No');
  await s.quiet(2500, 30000);
  await s.snap('perm-b-after-esc');
  turnEvents();
  console.log('экран после Esc (хвост):\n' + (await s.screen()).split('\n').slice(-12).join('\n'));
  console.log('tool_result в журнале:', lastToolResult());
  console.log('файл создан:', fs.existsSync(path.join(PROJ, 'probe-b.txt')));

  section('C. Bash touch — «Yes, and don\'t ask again» клавишами');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": touch probe-c.txt');
  await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  await sleep(600);
  s.write(KEY.down, 'down');
  await sleep(300);
  const after = await s.snap('perm-c-after-down');
  console.log('--- диалог после Down ---\n' + dialog(after));
  if (!/❯\s*2\./.test(after)) throw new Error('Down не выбрал пункт 2');
  s.write(KEY.enter, 'enter=option2');
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  turnEvents();
  const local = path.join(PROJ, '.claude', 'settings.local.json');
  console.log('settings.local.json:', fs.existsSync(local) ? fs.readFileSync(local, 'utf8').trim() : '(нет файла)');
  section('C2. Bash touch — после «don\'t ask again» запрос быть не должен');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": touch probe-c2.txt');
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  turnEvents();

  section('D. mkdir — хук PermissionRequest держит запрос, окно разрешает');
  s.control({ PermissionRequest: 'wait' });
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-1');
  await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  await sleep(2500);
  console.log('--- экран, пока хук держит запрос (хвост) ---\n' + (await s.snap('perm-d-hook-holding')).split('\n').slice(-14).join('\n'));
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  await s.waitEvent('PostToolUse', (ev) => ev.hook_event_name === 'PostToolUse', { from });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  await sleep(500);
  turnEvents();
  console.log('каталог создан:', fs.existsSync(path.join(PROJ, 'probe-dir-1')));
  console.log('был ли диалог на экране:', /Do you want to proceed/.test(fs.readFileSync(path.join(s.out, 'pty.raw'), 'utf8').slice(-20000)));

  section('E. mkdir — хук отвечает deny с сообщением');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-2');
  await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user declined this command in the Parley window. Do not retry.' } } });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  turnEvents();
  const stopE = s.events.slice(from).find((r) => r.ev?.hook_event_name === 'Stop');
  console.log('ответ модели:', JSON.stringify(stopE.ev.last_assistant_message).slice(0, 200));
  console.log('tool_result в журнале:', lastToolResult());

  section('F. mkdir — хук allow + setMode acceptEdits (session)');
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-dir-3');
  const permF = await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  console.log('режим в запросе:', permF.ev.permission_mode);
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } } });
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  await s.quiet(1200, 15000);
  turnEvents();
  console.log('подвал экрана:\n' + (await s.snap('after-setmode')).split('\n').slice(-3).join('\n'));
  console.log('записи permission-mode в журнале:', s.logs.filter((l) => l.rec.type === 'permission-mode').map((l) => l.rec.permissionMode).join(','));
  console.log('строка статуса: вызовов', s.status.length);
  s.control({});
} catch (error) {
  console.log('ОШИБКА:', error.message);
  console.log((await s.screen()).split('\n').slice(-25).join('\n'));
} finally {
  await s.close();
  console.log('выход:', JSON.stringify(s.exited));
}
