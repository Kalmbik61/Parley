// P4: вопрос агента (AskUserQuestion) клавишами и через хук; одобрение плана (ExitPlanMode); Write с диффом.
import fs from 'node:fs';
import path from 'node:path';
import { Session, KEY, sleep, describeEvents, PROJ } from './lib.mjs';
const s = new Session('p4-questions-plan');
let from = 0;
const section = (title) => { console.log(`\n===== ${title} =====`); from = s.events.length; };
const turnEvents = () => console.log(describeEvents(s, from).join('\n'));
const tail = async (n, label) => (await s.snap(label)).split('\n').filter((l) => l.trim() !== '').slice(-n).join('\n');
const rawLen = () => fs.statSync(path.join(s.out, 'pty.raw')).size;
const rawSince = (mark) => fs.readFileSync(path.join(s.out, 'pty.raw'), 'utf8').slice(mark);
const ev = (name, tool) => (e) => e.hook_event_name === name && (!tool || e.tool_name === tool);
const footer = async (label) => (await s.snap(label)).split('\n').filter((l) => /mode on|accept edits|bypass|auto mode/i.test(l)).slice(-1)[0] ?? '(подвал не найден)';
try {
  await s.waitEvent('SessionStart', ev('SessionStart'), { timeoutMs: 40000 });
  await s.quiet(1200, 20000);

  section('I. AskUserQuestion — ответ клавишами');
  let mark = rawLen();
  await s.send('Use the AskUserQuestion tool to ask me exactly one question "Which color?" with two options "Red" and "Blue". After I answer, reply with only the chosen color.');
  const preI = await s.waitEvent('PreToolUse AskUserQuestion', ev('PreToolUse', 'AskUserQuestion'), { from, timeoutMs: 60000 });
  console.log('PreToolUse.tool_input:', JSON.stringify(preI.ev.tool_input).slice(0, 300));
  await sleep(1200);
  console.log('--- экран вопроса ---\n' + (await tail(12, 'i-question')));
  console.log('PermissionRequest для AskUserQuestion пришёл:', s.events.slice(from).some((r) => r.ev && ev('PermissionRequest', 'AskUserQuestion')(r.ev)));
  s.write(KEY.down, 'down');
  await sleep(400);
  console.log('--- после Down ---\n' + (await tail(6, 'i-after-down')));
  s.write(KEY.enter, 'enter');
  await sleep(900);
  let scr = await s.snap('i-after-enter');
  console.log('--- после Enter ---\n' + scr.split('\n').filter((l) => l.trim()).slice(-8).join('\n'));
  if (/Submit|submit/.test(scr)) { s.write(KEY.enter, 'enter=submit'); }
  const postI = await s.waitEvent('PostToolUse AskUserQuestion', ev('PostToolUse', 'AskUserQuestion'), { from, timeoutMs: 30000 });
  console.log('PostToolUse.tool_response:', JSON.stringify(postI.ev.tool_response).slice(0, 300));
  const stopI = await s.waitEvent('Stop', ev('Stop'), { from, timeoutMs: 60000 });
  console.log('ответ модели:', JSON.stringify(stopI.ev.last_assistant_message).slice(0, 80));
  turnEvents();

  section('II. AskUserQuestion — ответ хуком PreToolUse (updatedInput.answers)');
  s.control({ 'PreToolUse:AskUserQuestion': 'wait' });
  mark = rawLen();
  await s.send('Use the AskUserQuestion tool again: ask exactly one question "Which fruit?" with options "Apple" and "Pear". After I answer, reply with only the chosen fruit.');
  const preII = await s.waitEvent('PreToolUse AskUserQuestion', ev('PreToolUse', 'AskUserQuestion'), { from, timeoutMs: 60000 });
  await sleep(800);
  const dialogBefore = /Which fruit|Apple/.test(rawSince(mark).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''));
  s.decide({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...preII.ev.tool_input, answers: { 'Which fruit?': 'Pear' } } } });
  const postII = await s.waitEvent('PostToolUse AskUserQuestion', ev('PostToolUse', 'AskUserQuestion'), { from, timeoutMs: 30000 });
  console.log('PostToolUse.tool_response:', JSON.stringify(postII.ev.tool_response).slice(0, 300));
  const stopII = await s.waitEvent('Stop', ev('Stop'), { from, timeoutMs: 60000 });
  console.log('ответ модели:', JSON.stringify(stopII.ev.last_assistant_message).slice(0, 80));
  console.log('диалог вопроса был на экране до решения:', dialogBefore, '| после:', /Which fruit/.test((await s.screen())));
  turnEvents();
  s.control({});

  section('III. План: /plan → ExitPlanMode → одобрение клавишей → Write через хук');
  await s.send('/plan');
  await sleep(1200);
  console.log('режим:', await footer('iii-plan-mode'));
  s.control({ 'PermissionRequest:Write': 'wait' });
  mark = rawLen();
  await s.send('Make a two-line plan to create a file named hello.txt containing the word hi. Then call ExitPlanMode to present the plan.');
  const preP = await s.waitEvent('PreToolUse ExitPlanMode', ev('PreToolUse', 'ExitPlanMode'), { from, timeoutMs: 90000 });
  console.log('PreToolUse(ExitPlanMode).tool_input ключи:', Object.keys(preP.ev.tool_input ?? {}).join(', '), '| plan:', JSON.stringify(preP.ev.tool_input?.plan).slice(0, 160));
  const permP = s.events.slice(from).find((r) => r.ev && ev('PermissionRequest', 'ExitPlanMode')(r.ev)) ?? (await s.waitEvent('PermissionRequest ExitPlanMode', ev('PermissionRequest', 'ExitPlanMode'), { from, timeoutMs: 15000 }).catch(() => null));
  console.log('PermissionRequest(ExitPlanMode):', permP ? 'ключи ' + Object.keys(permP.ev).join(', ') + ' | suggestions ' + JSON.stringify(permP.ev.permission_suggestions) : 'не пришёл');
  await sleep(1500);
  console.log('--- экран одобрения плана ---\n' + (await tail(14, 'iii-plan-dialog')));
  s.write(KEY.enter, 'enter=default-option');
  const postP = await s.waitEvent('PostToolUse ExitPlanMode', ev('PostToolUse', 'ExitPlanMode'), { from, timeoutMs: 30000 });
  console.log('PostToolUse(ExitPlanMode).tool_response ключи:', Object.keys(postP.ev.tool_response ?? {}).join(', '), '| режим после:', postP.ev.permission_mode);
  await sleep(600);
  console.log('подвал:', await footer('iii-after-approve'));
  const permW = await s.waitEvent('PermissionRequest Write', ev('PermissionRequest', 'Write'), { from, timeoutMs: 90000 });
  console.log('PermissionRequest(Write).tool_input:', JSON.stringify(permW.ev.tool_input).slice(0, 200), '| режим:', permW.ev.permission_mode);
  await sleep(800);
  console.log('--- диалог Write на экране ---\n' + (await tail(10, 'iii-write-dialog')));
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const postW = await s.waitEvent('PostToolUse Write', ev('PostToolUse', 'Write'), { from, timeoutMs: 30000 });
  console.log('PostToolUse(Write).tool_response:', JSON.stringify(postW.ev.tool_response).slice(0, 300));
  await s.waitEvent('Stop', ev('Stop'), { from, timeoutMs: 60000 });
  await s.quiet(1000, 10000);
  turnEvents();
  console.log('hello.txt:', fs.existsSync(path.join(PROJ, 'hello.txt')) ? JSON.stringify(fs.readFileSync(path.join(PROJ, 'hello.txt'), 'utf8')) : '(нет)');
  const writeRec = s.logs.map((l) => l.rec).reverse().find((r) => r.toolUseResult && r.toolUseResult.structuredPatch);
  console.log('toolUseResult записи Write в журнале:', writeRec ? Object.keys(writeRec.toolUseResult).join(', ') + ' | structuredPatch=' + JSON.stringify(writeRec.toolUseResult.structuredPatch).slice(0, 160) : '(нет)');
  s.control({});
} catch (error) {
  console.log('ОШИБКА:', error.message);
  console.log((await s.screen()).split('\n').slice(-28).join('\n'));
  turnEvents();
} finally {
  await s.close();
  console.log('выход:', JSON.stringify(s.exited));
}
