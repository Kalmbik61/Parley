#!/usr/bin/env node
// Строка статуса разведки: сохраняет JSON, который Claude Code присылает скрипту, и печатает метку.
import fs from 'node:fs';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const out = process.env.PROBE_OUT;
if (out) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    data = { raw: input };
  }
  fs.appendFileSync(path.join(out, 'statusline.jsonl'), `${JSON.stringify({ t: Date.now(), data })}\n`);
}
process.stdout.write('probe-statusline');
