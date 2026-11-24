#!/usr/bin/env node
// Raw-terminal stub of Qwen Code input for host typing tests (the real qwen never runs in automated tests). It turns
// bracketed paste on like qwen 0.27.2 (ESC[?2004h) and reports what reached its prompt:
//   paste: <text>   a bracketed paste arrived (newlines shown as \n)
//   field: <text>   the input field after a chunk of typed (not pasted) input
//   turn: <text>    Enter submitted the field; the field is cleared
// prints Qwen's OSC 7501 program status on signals (SIGUSR1: blocked:kind=permission, SIGUSR2: idle),
// and journals the hooks qwen would: SessionStart at start; per turn UserPromptSubmit, then after STUB_TURN_MS (default
// 200) Stop and Notification idle_prompt. Ctrl+U clears the field. The journal is
// $PARLEY_WORK_DIR/events/$PARLEY_SESSION_ID.jsonl, one JSON object per line.

import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setInterval, setTimeout } from 'node:timers';

const journal = join(process.env.PARLEY_WORK_DIR ?? '.', 'events', `${process.env.PARLEY_SESSION_ID ?? 's-00'}.jsonl`);
const turnMs = Number(process.env.STUB_TURN_MS ?? '200');
const hook = (name, extra = {}) =>
  appendFileSync(journal, `${JSON.stringify({ hook_event_name: name, timestamp: new Date().toISOString(), ...extra })}\n`);
const show = (text) => text.replace(/\n/g, '\\n');

process.stdin.setRawMode?.(true);
process.stdout.write('\x1b[?2004h');
hook('SessionStart', { source: 'startup' });
process.stdout.write('stub-qwen-tty ready\r\n');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
let field = '';
let pending = '';
let pasting = false;

process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8');
  const before = field;
  while (pending.length > 0) {
    if (pasting) {
      const end = pending.indexOf(PASTE_END);
      if (end === -1) return;
      const text = pending.slice(0, end);
      field += text;
      process.stdout.write(`paste: ${show(text)}\r\n`);
      pending = pending.slice(end + PASTE_END.length);
      pasting = false;
      continue;
    }
    if (pending.startsWith(PASTE_START)) {
      pending = pending.slice(PASTE_START.length);
      pasting = true;
      continue;
    }
    if (PASTE_START.startsWith(pending)) return;
    const char = pending[0];
    pending = pending.slice(1);
    if (char === '\r') {
      const text = field;
      field = '';
      process.stdout.write(`turn: ${show(text)}\r\n`);
      if (text.trim() === '') continue;
      hook('UserPromptSubmit', { prompt: text });
      setTimeout(() => {
        hook('Stop', { context_usage: 0.01, context_limit: 1000 });
        hook('Notification', { notification_type: 'idle_prompt' });
      }, turnMs);
    } else if (char === '\x15') {
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== before && field !== '' && !pasting) process.stdout.write(`field: ${show(field)}\r\n`);
});

const status = (body) => process.stdout.write(`\x1b]7501;${body}\x1b\\`);
process.on('SIGUSR1', () => status(`state=blocked:kind=permission:app=qwen-code:msg=${Buffer.from('Permission needed: Shell').toString('base64')}`));
process.on('SIGUSR2', () => status('state=idle:app=qwen-code'));

setInterval(() => {}, 60_000);
