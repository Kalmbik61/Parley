#!/usr/bin/env node
// Хук разведки: пишет stdin Claude Code в events.jsonl как есть, с временем прихода.
// Для событий, отмеченных в control.json как "wait", ждёт decision.json и отдаёт его в stdout —
// так стенд проверяет ответ на запрос через хук, а не клавишами.
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.PROBE_OUT;
if (!out) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const t = Date.now();
let ev;
try {
  ev = JSON.parse(input);
} catch {
  ev = { raw: input };
}
const log = (record) => fs.appendFileSync(path.join(out, 'events.jsonl'), `${JSON.stringify(record)}\n`);
log({ t, ev });

let ctl = {};
try {
  ctl = JSON.parse(fs.readFileSync(path.join(out, 'control.json'), 'utf8'));
} catch {
  // управления нет — хук только пишет
}
const name = ev.hook_event_name;
const mode = ctl[`${name}:${ev.tool_name}`] ?? ctl[name];
if (mode === 'wait') {
  const file = path.join(out, 'decision.json');
  const deadline = Date.now() + (ctl.waitMs ?? 120000);
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const decision = fs.readFileSync(file, 'utf8');
      fs.unlinkSync(file);
      log({ t: Date.now(), decisionFor: name, tool: ev.tool_name ?? null, decision: JSON.parse(decision) });
      process.stdout.write(decision);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  log({ t: Date.now(), decisionFor: name, tool: ev.tool_name ?? null, decision: null, note: 'hook gave up waiting' });
}
process.exit(0);
