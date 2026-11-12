// Copies raw recordings to recorded/ replacing local paths, host name, pids and ports with invented constants.
// Usage: node sanitize.mjs <raw-dir> <out-dir> <work-dir>. Fails if a path of this machine or the fake key survives.
import fs from 'node:fs';
import os from 'node:os';

const [, , RAW, OUT, W] = process.argv;
const skip = new Set(['auth-login.txt', 'parent.pid', 'serve-orphan.pid']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [
  [new RegExp(esc(fs.realpathSync(W)), 'g'), '/lab/work'], [new RegExp(esc(W), 'g'), '/lab/work'],
  [new RegExp(esc(os.homedir()), 'g'), '/home/lab'], [new RegExp(esc(os.hostname()), 'g'), 'lab-host'],
  [/\/private\/var\/folders\/[^"\s]*/g, '/tmp/opencode'], [/\/var\/folders\/[^"\s]*/g, '/tmp/opencode'],
  [/"pid":\d+/g, '"pid":1234'], [/127\.0\.0\.1:\d+/g, '127.0.0.1:4096'], [/localhost:\d+/g, 'localhost:4096'],
  [/sk-ant-FAKE[A-Za-z0-9-]*/g, 'sk-FAKE'], [/\x1b\[[0-9;?]*[a-zA-Z]/g, ''],
  [/Date: .*/g, 'Date: <date>'],
];
for (const name of fs.readdirSync(RAW)) {
  if (skip.has(name) || !fs.statSync(`${RAW}/${name}`).isFile()) continue;
  let text = fs.readFileSync(`${RAW}/${name}`, 'utf8');
  for (const [re, to] of rules) text = text.replace(re, to);
  if (/\/Users\/|FAKE-LAB/.test(text)) throw new Error(`${name}: local path or key survived`);
  fs.writeFileSync(`${OUT}/${name}`, text);
}
