// P5: (a) нужны ли ответы терминала на запросы программы для клавиш; (b) запрос на запись файла в manual-режиме.
import fs from 'node:fs';
import path from 'node:path';
import { Session, KEY, sleep, describeEvents, PROJ } from './lib.mjs';
const ev = (name, tool) => (e) => e.hook_event_name === name && (!tool || e.tool_name === tool);
const highlighted = (text) => (text.split('\n').find((l) => /❯\s*\d+\./.test(l)) ?? '').trim();

async function menuProbe(replies) {
  const s = new Session(`p5a-replies-${replies ? 'on' : 'off'}`, { replies });
  try {
    await s.waitEvent('SessionStart', ev('SessionStart'), { timeoutMs: 40000 });
    await s.quiet(1500, 20000);
    console.log(`\n===== (a) /model меню, ответы терминала: ${replies ? 'есть' : 'нет'} =====`);
    console.log('ответов терминала отправлено:', s.termReplies.length);
    await s.send('/model');
    await s.waitScreen('меню модели', /Esc to cancel/, 15000);
    await s.quiet(600, 5000);
    const before = highlighted(await s.snap('menu'));
    s.write(KEY.down, 'down');
    await sleep(500);
    const after = highlighted(await s.snap('menu-after-down'));
    console.log('выделено до:', before, '| после Down:', after, '| Down сработал:', before !== after);
    s.write(KEY.esc, 'esc');
    await sleep(500);
  } catch (error) {
    console.log('ОШИБКА:', error.message);
  } finally {
    await s.close();
  }
}
await menuProbe(false);
await menuProbe(true);

const s = new Session('p5b-write');
let from = 0;
try {
  await s.waitEvent('SessionStart', ev('SessionStart'), { timeoutMs: 40000 });
  await s.quiet(1200, 20000);
  console.log('\n===== (b) Write в manual-режиме: диалог с диффом, allow хуком =====');
  from = s.events.length;
  s.control({ 'PermissionRequest:Write': 'wait', 'PermissionRequest:Edit': 'wait' });
  await s.send('Use the Write tool to create a file named notes.txt with exactly these two lines:\nalpha\nbeta\nThen reply "done".');
  const perm = await s.waitEvent('PermissionRequest Write', ev('PermissionRequest', 'Write'), { from, timeoutMs: 60000 });
  console.log('PermissionRequest(Write).tool_input:', JSON.stringify(perm.ev.tool_input), '| suggestions:', JSON.stringify(perm.ev.permission_suggestions));
  await sleep(1200);
  console.log('--- диалог на экране ---\n' + (await s.snap('write-dialog')).split('\n').filter((l) => l.trim()).slice(-12).join('\n'));
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const post = await s.waitEvent('PostToolUse Write', ev('PostToolUse', 'Write'), { from, timeoutMs: 30000 });
  console.log('PostToolUse(Write).tool_response:', JSON.stringify(post.ev.tool_response).slice(0, 240));
  await s.waitEvent('Stop', ev('Stop'), { from, timeoutMs: 60000 });
  await s.quiet(1000, 10000);
  console.log(describeEvents(s, from).join('\n'));
  const rec = s.logs.map((l) => l.rec).reverse().find((r) => r.toolUseResult && typeof r.toolUseResult === 'object' && r.toolUseResult.structuredPatch);
  console.log('журнал toolUseResult:', rec ? Object.keys(rec.toolUseResult).join(', ') : '(нет)', '| structuredPatch:', rec ? JSON.stringify(rec.toolUseResult.structuredPatch).slice(0, 200) : '');
  console.log('notes.txt:', JSON.stringify(fs.readFileSync(path.join(PROJ, 'notes.txt'), 'utf8')));
  from = s.events.length;
  console.log('\n===== (c) Edit в manual-режиме: диалог и tool_input =====');
  await s.send('Use the Edit tool to change "beta" to "gamma" in notes.txt, then reply "done".');
  const permE = await s.waitEvent('PermissionRequest Edit', ev('PermissionRequest', 'Edit'), { from, timeoutMs: 60000 });
  console.log('PermissionRequest(Edit).tool_input:', JSON.stringify(permE.ev.tool_input));
  await sleep(1200);
  console.log('--- диалог на экране ---\n' + (await s.snap('edit-dialog')).split('\n').filter((l) => l.trim()).slice(-12).join('\n'));
  s.decide({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const postE = await s.waitEvent('PostToolUse Edit', ev('PostToolUse', 'Edit'), { from, timeoutMs: 30000 });
  console.log('PostToolUse(Edit).tool_response ключи:', Object.keys(postE.ev.tool_response ?? {}).join(', '), '| structuredPatch:', JSON.stringify(postE.ev.tool_response?.structuredPatch).slice(0, 200));
  await s.waitEvent('Stop', ev('Stop'), { from, timeoutMs: 60000 });
  s.control({});
} catch (error) {
  console.log('ОШИБКА:', error.message);
  console.log((await s.screen()).split('\n').slice(-20).join('\n'));
} finally {
  await s.close();
  console.log('выход:', JSON.stringify(s.exited));
}
