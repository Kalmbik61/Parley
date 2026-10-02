// P1: доверие папке, первый промпт, поток ответа. Сравниваем три источника по времени:
// экран терминала, хук MessageDisplay, журнал сессии.
import { Session, KEY, sleep, describeEvents } from './lib.mjs';
const s = new Session('p1-stream');
const keys = (o) => Object.keys(o ?? {}).join(', ');
try {
  await s.waitScreen('первый экран', /trust this folder|shortcuts|❯/i, 30000);
  let text = await s.screen();
  if (/trust this folder/i.test(text)) {
    console.log('доверие папке: диалог показан; событий хуков до ответа:', s.events.length);
    await s.quiet(800, 8000);
    console.log('ответы терминала на запросы программы:', s.termReplies.map((r) => r.data).join(' '));
    s.write(KEY.down, 'down');
    await sleep(400);
    text = await s.snap('trust-after-down');
    const moved = /❯ Yes, I trust/.test(text);
    console.log('после Down курсор на «Yes, I trust»:', moved);
    if (!moved) throw new Error('Down не сдвинул выбор — Enter не жмём');
    s.write(KEY.enter, 'enter');
  }
  await s.waitEvent('SessionStart', (ev) => ev.hook_event_name === 'SessionStart', { timeoutMs: 30000 });
  await s.quiet(1500, 20000);
  console.log('--- экран готовности ---\n' + (await s.snap('ready')));
  console.log('--- события до первого промпта ---\n' + describeEvents(s).join('\n'));
  const start = s.events.find((r) => r.ev?.hook_event_name === 'SessionStart');
  console.log('SessionStart ключи:', keys(start.ev), '| source:', start.ev.source, '| model:', start.ev.model);
  console.log('строка статуса: вызовов', s.status.length, '| ключи:', keys(s.status[0]?.data));

  const from = s.events.length;
  const tSend = Date.now();
  await s.send('Reply with exactly 12 numbered lines, each a short fact about the sea. No tools, no preamble.');
  const seen = {};
  const stop = await s.waitFor('Stop', async () => {
    const scr = await s.screen();
    if (!seen.first && /^\s*[⏺●]?\s*1\. /m.test(scr)) seen.first = Date.now();
    if (!seen.last && /^\s*12\. /m.test(scr)) seen.last = Date.now();
    return s.events.slice(from).find((r) => r.ev?.hook_event_name === 'Stop') ?? null;
  }, 90000);
  await s.quiet(1200, 15000);
  console.log('--- экран после ответа ---\n' + (await s.snap('answered')));
  const d = (t) => (t ? `${t - tSend}ms` : 'нет');
  console.log('--- время от отправки промпта ---');
  console.log('экран: первая строка ответа', d(seen.first), '| последняя (12.)', d(seen.last));
  for (const r of s.events.slice(from)) {
    if (!r.ev) continue;
    const ev = r.ev;
    let extra = '';
    if (ev.hook_event_name === 'MessageDisplay') extra = `#${ev.index} final=${ev.final} delta=${JSON.stringify(ev.delta).slice(0, 70)}`;
    if (ev.hook_event_name === 'UserPromptSubmit') extra = `mode=${ev.permission_mode} prompt=${JSON.stringify(ev.prompt).slice(0, 50)}`;
    if (ev.hook_event_name === 'Stop') extra = `ключи: ${keys(ev)}`;
    console.log(`хук  ${d(r.t).padStart(8)} ${ev.hook_event_name} ${extra}`);
  }
  for (const l of s.logs) {
    if (l.t < tSend) continue;
    const rec = l.rec;
    const c = rec.message?.content;
    const blocks = Array.isArray(c) ? c.map((b) => b.type + (b.type === 'text' ? `(${b.text.length}ch)` : '')).join('+') : typeof c === 'string' ? `string(${c.length}ch)` : '';
    console.log(`журнал ${d(l.t).padStart(8)} type=${rec.type}${rec.subtype ? '/' + rec.subtype : ''} ${blocks} ${rec.permissionMode ? 'permissionMode=' + rec.permissionMode : ''}`);
  }
  console.log('Stop.last_assistant_message длина:', (stop.ev.last_assistant_message ?? '').length);
  const st = s.status[s.status.length - 1]?.data;
  console.log('--- последняя строка статуса (полностью) ---\n' + JSON.stringify(st, null, 1));
} catch (error) {
  console.log('ОШИБКА:', error.message);
  console.log(await s.screen());
} finally {
  const before = s.events.length;
  await s.close();
  console.log('--- события при выходе ---\n' + describeEvents(s, before).join('\n'));
  console.log('выход:', JSON.stringify(s.exited));
}
