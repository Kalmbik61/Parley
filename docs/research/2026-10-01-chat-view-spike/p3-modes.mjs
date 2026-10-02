// P3: таймаут хука разрешения, цикл режимов Shift+Tab, /plan, /clear, прерывание Esc и очередь.
import fs from 'node:fs';
import path from 'node:path';
import { Session, KEY, sleep, describeEvents, PROJ } from './lib.mjs';
const s = new Session('p3-modes', { settings: { timeouts: { PermissionRequest: 6 } } });
let from = 0;
const section = (title) => { console.log(`\n===== ${title} =====`); from = s.events.length; };
const turnEvents = () => console.log(describeEvents(s, from).join('\n'));
const footer = async (label) => (await s.snap(label)).split('\n').filter((l) => /mode|accept edits|bypass|auto|plan/i.test(l)).slice(-1)[0] ?? '(подвал не найден)';
const modesInLog = () => s.logs.filter((l) => l.rec.type === 'permission-mode').map((l) => l.rec.permissionMode).join(',');
try {
  await s.waitEvent('SessionStart', (ev) => ev.hook_event_name === 'SessionStart', { timeoutMs: 40000 });
  await s.quiet(1200, 20000);

  section('G. хук молчит дольше таймаута (6 с): появляется ли обычный диалог');
  s.control({ PermissionRequest: 'wait', waitMs: 60000 });
  await s.send('Use the Bash tool to run exactly this command, then reply "done": mkdir probe-g');
  const permG = await s.waitEvent('PermissionRequest', (ev) => ev.hook_event_name === 'PermissionRequest', { from });
  await sleep(1500);
  const shownEarly = /Do you want to proceed/.test(await s.screen());
  console.log('диалог виден уже через 1.5 с, пока хук держит:', shownEarly);
  await sleep(6500);
  console.log('--- экран через 8 с после запроса ---\n' + (await s.snap('g-after-timeout')).split('\n').slice(-9).join('\n'));
  s.write(KEY.enter, 'enter=Yes');
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from, timeoutMs: 60000 });
  turnEvents();
  console.log('каталог создан:', fs.existsSync(path.join(PROJ, 'probe-g')));
  s.control({});

  section('H. цикл режимов Shift+Tab (без запросов к модели)');
  console.log('до:', await footer('h-0'), '| журнал:', modesInLog(), '| статус-вызовов:', s.status.length);
  for (let i = 1; i <= 4; i++) {
    const ev0 = s.events.length;
    s.write(KEY.shiftTab, 'shift+tab');
    await sleep(900);
    console.log(`после ${i}×Shift+Tab:`, await footer(`h-${i}`), '| новых хуков:', s.events.length - ev0, '| статус-вызовов:', s.status.length, '| журнал:', modesInLog());
  }
  section('H2. /plan командой');
  await s.send('/plan');
  await sleep(1500);
  console.log('после /plan:', await footer('h-plan'), '| журнал:', modesInLog());
  turnEvents();
  await s.send('Reply with one word: ready');
  const ups = await s.waitEvent('UserPromptSubmit', (ev) => ev.hook_event_name === 'UserPromptSubmit', { from });
  console.log('UserPromptSubmit.permission_mode =', ups.ev.permission_mode);
  await s.waitEvent('Stop', (ev) => ev.hook_event_name === 'Stop', { from });
  await s.quiet(1000, 10000);
  console.log('после хода:', await footer('h-plan-after-turn'), '| журнал:', modesInLog());
  // вернуться в manual: жмём Shift+Tab, пока подвал не скажет manual (не больше 5 раз)
  for (let i = 0; i < 5; i++) {
    if (/manual mode/.test(await footer('h-back'))) break;
    s.write(KEY.shiftTab, 'shift+tab');
    await sleep(800);
  }
  console.log('вернулись:', await footer('h-back-final'));

  section('L. прерывание Esc во время ответа и очередь сообщений');
  await s.send('Count slowly from 1 to 40, one number per line, no other text.');
  await s.waitEvent('MessageDisplay', (ev) => ev.hook_event_name === 'MessageDisplay', { from, timeoutMs: 60000 });
  s.write(KEY.esc, 'esc=interrupt');
  await s.quiet(1500, 20000);
  turnEvents();
  console.log('--- экран после Esc (хвост) ---\n' + (await s.snap('l-after-esc')).split('\n').slice(-8).join('\n'));
  const recsAfter = s.logs.filter((l) => l.t > s.marks.filter((m) => m.kind === 'write' && m.label === 'esc=interrupt')[0].t).map((l) => l.rec.type + (l.rec.subtype ? '/' + l.rec.subtype : ''));
  console.log('записи журнала после Esc:', recsAfter.join(', '));
  const interrupted = s.logs.map((l) => l.rec).filter((r) => r.type === 'user' && JSON.stringify(r.message?.content ?? '').includes('interrupted'));
  console.log('запись о прерывании в журнале:', interrupted.length ? JSON.stringify(interrupted[interrupted.length - 1].message.content).slice(0, 160) : '(нет)');
  section('L2. сообщение во время работы — очередь');
  await s.send('Count slowly from 1 to 30, one number per line, no other text.');
  await s.waitEvent('MessageDisplay', (ev) => ev.hook_event_name === 'MessageDisplay', { from, timeoutMs: 60000 });
  await s.send('Then reply with one word: queued');
  await sleep(800);
  console.log('--- экран с очередью (хвост) ---\n' + (await s.snap('l2-queued')).split('\n').slice(-10).join('\n'));
  await s.waitFor('второй Stop', () => s.events.slice(from).filter((r) => r.ev?.hook_event_name === 'Stop').length >= 2 ? true : null, 120000);
  turnEvents();
  console.log('queue-operation в журнале:', s.logs.filter((l) => l.rec.type === 'queue-operation').map((l) => JSON.stringify(l.rec).slice(0, 140)).join('\n'));

  section('K. /clear → новая сессия');
  await s.send('/clear');
  const ss = await s.waitEvent('SessionStart(clear)', (ev) => ev.hook_event_name === 'SessionStart' && ev.source === 'clear', { from, timeoutMs: 20000 });
  turnEvents();
  console.log('новый session_id:', ss.ev.session_id, '| прежний:', s.sessionId, '| transcript_path:', path.basename(ss.ev.transcript_path));
  await s.quiet(1000, 10000);
  section('K2. /model без аргумента — меню');
  await s.send('/model');
  await sleep(1500);
  console.log('--- экран меню (хвост) ---\n' + (await s.snap('k2-model-menu')).split('\n').slice(-16).join('\n'));
  turnEvents();
  s.write(KEY.esc, 'esc=close-menu');
  await sleep(800);
  console.log('меню закрылось:', !/Select model|Switch model/i.test(await s.screen()));
} catch (error) {
  console.log('ОШИБКА:', error.message);
  console.log((await s.screen()).split('\n').slice(-25).join('\n'));
} finally {
  await s.close();
  console.log('выход:', JSON.stringify(s.exited));
}
