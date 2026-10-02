// P6: субагенты — что отдают хуки про вызов Agent, SubagentStart/Stop, вложенные вызовы с agent_id, фон.
import fs from 'node:fs';
import path from 'node:path';
import { Session, sleep, describeEvents } from './lib.mjs';
const s = new Session('p6b-subagents');
const ev = (name, tool) => (e) => e.hook_event_name === name && (!tool || e.tool_name === tool);
let from = 0;
const dump = () => {
  for (const r of s.events.slice(from)) {
    const e = r.ev; if (!e) continue;
    const bits = [`${String(s.rel(r.t)).padStart(6)}ms`, e.hook_event_name];
    if (e.tool_name) bits.push(e.tool_name);
    if (e.agent_id) bits.push(`agent_id=${e.agent_id}`);
    if (e.agent_type !== undefined) bits.push(`agent_type=${JSON.stringify(e.agent_type)}`);
    if (e.hook_event_name === 'MessageDisplay') bits.push(`#${e.index}${e.final ? ' final' : ''} ${JSON.stringify(e.delta).slice(0, 40)}`);
    if (e.hook_event_name === 'PreToolUse' && e.tool_name === 'Agent') bits.push(JSON.stringify(e.tool_input).slice(0, 220));
    if (e.hook_event_name === 'PostToolUse' && e.tool_name === 'Agent') bits.push('response=' + JSON.stringify(e.tool_response).slice(0, 300));
    if (e.hook_event_name === 'Stop' || e.hook_event_name === 'SubagentStop') bits.push(`bg=${JSON.stringify(e.background_tasks).slice(0, 200)}`);
    if (e.hook_event_name === 'SubagentStop') bits.push(`last=${JSON.stringify(e.last_assistant_message ?? null).slice(0, 80)} path=${(e.agent_transcript_path ?? '').split('/').slice(-3).join('/')}`);
    if (e.hook_event_name === 'Notification') bits.push(e.notification_type);
    console.log(bits.join(' '));
  }
};
try {
  await s.waitEvent('SessionStart', ev('SessionStart'), { timeoutMs: 40000 });
  await s.quiet(1200, 20000);
  console.log('===== A. Agent (Explore): список файлов =====');
  from = s.events.length;
  await s.send('Use the Agent tool with subagent_type "Explore" and description "List project files" to find out which files are in this folder. When it reports back, reply with the file names only.');
  // ждём либо финальный ответ родителя после субагента, либо 3 минуты
  await s.waitFor('SubagentStop с типом', () => s.events.slice(from).find((r) => r.ev?.hook_event_name === 'SubagentStop' && r.ev.agent_type) ?? null, 180000);
  await s.waitFor('Stop после субагента', () => { const stops = s.events.slice(from).filter((r) => r.ev?.hook_event_name === 'Stop'); const sub = s.events.slice(from).findIndex((r) => r.ev?.hook_event_name === 'SubagentStop' && r.ev.agent_type); return s.events.slice(from).some((r, i) => i > sub && r.ev?.hook_event_name === 'Stop') ? true : null; }, 120000);
  await s.quiet(4000, 60000);
  dump();
  console.log('--- экран (хвост) ---\n' + (await s.snap('a-after')).split('\n').filter((l) => l.trim()).slice(-14).join('\n'));
  const stop = s.events.slice(from).find((r) => r.ev?.hook_event_name === 'SubagentStop' && r.ev.agent_type);
  const p = stop?.ev.agent_transcript_path;
  if (p && fs.existsSync(p)) {
    const recs = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    console.log('журнал субагента:', path.basename(p), 'записей', recs.length, 'типы', [...new Set(recs.map((r) => r.type))].join(','), '| agentId в записях:', recs.find((r) => r.agentId)?.agentId, '| isSidechain:', recs.find((r) => r.isSidechain !== undefined)?.isSidechain);
  } else console.log('журнал субагента не найден:', p);
  const main = s.logs.map((l) => l.rec).filter((r) => r.type === 'assistant' && Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === 'tool_use' && b.name === 'Agent'));
  console.log('в главном журнале tool_use Agent:', main.length, '| tool_use_id в записи:', main[0]?.message.content.find((b) => b.type === 'tool_use')?.id);
  const res = s.logs.map((l) => l.rec).filter((r) => r.type === 'user' && r.toolUseResult && (r.toolUseResult.agentId || r.toolUseResult.status));
  console.log('toolUseResult Agent в журнале:', res.map((r) => JSON.stringify(r.toolUseResult).slice(0, 260)).join('\n'));
} catch (error) {
  console.log('ОШИБКА:', error.message);
  dump();
  console.log((await s.screen()).split('\n').slice(-20).join('\n'));
} finally {
  await s.close();
  console.log('выход:', JSON.stringify(s.exited));
}
