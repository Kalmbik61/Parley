#!/usr/bin/env node
// Заглушка вместо настоящего `claude` для E2E чипа процессов (`session-processes.spec.ts`): живой агент в автотестах
// не запускается никогда. Стаб отвечает на пробу версии и остаётся жить; пока в каталоге `STUB_PROC_DIR` есть файл
// `run`, у него есть дочерний `zsh`, который держит под собой `sleep` с подменённым argv[0] — строкой, похожей на
// токен. Уберут файл — дочерний процесс завершается. Так спек включает и выключает «команду» без ввода в терминал.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setInterval } from 'node:timers';

if (process.argv[2] === '--version') {
  process.stdout.write('2.1.286 (Claude Code)\n');
  process.exit(0);
}

process.stdout.write('stub-processes готов\r\n');

const flag = path.join(process.env.STUB_PROC_DIR ?? '/nonexistent', 'run');
let child = null;

setInterval(() => {
  const wanted = existsSync(flag);
  if (wanted && child === null) {
    child = spawn('zsh', ['-c', '(exec -a "fake --token=SECRET-PROBE" sleep 120) & wait'], { stdio: 'ignore' });
    child.on('close', () => { child = null; });
  } else if (!wanted && child !== null) {
    // `zsh` убивается сигналом, а внук `sleep` иначе дожил бы до своего таймаута — снимаем и его.
    spawnSync('pkill', ['-P', String(child.pid)]);
    child.kill('SIGKILL');
  }
}, 200);

process.on('SIGTERM', () => {
  if (child !== null) {
    spawnSync('pkill', ['-P', String(child.pid)]);
    child.kill('SIGKILL');
  }
  process.exit(0);
});
process.stdin.resume();
