#!/usr/bin/env node
// Управляемая заглушка вместо настоящего `codex` для тестов хоста (кусок 11a плана комнат). Настоящий
// codex в автотестах не запускается никогда — даже с --version: лимиты подписки, вход и недетерминизм.
//
// Заглушка ведёт себя как Codex ровно настолько, насколько на это опирается хост: пишет заголовок
// окна (OSC 0) со спиннером, `Ready` и `[ ! ] Action Required`, уведомления OSC 9, включает bracketed
// paste и различает Enter (`\r`) и Tab (`\t`). Строки заголовков — те же, что разбирает
// `src/pty/codex-terminal.ts`; настоящий Codex их не сверял (исследование, раздел 14).
//
// Терминал — в сыром режиме, ввод копится в «поле ввода»:
//   вставка ESC[200~ … ESC[201~ → текст в поле, печатается `paste: <текст>`;
//   Enter (\r)                  → `enter: <текст>`, поле пусто; команды STUB_* исполняются;
//   Tab (\t)                    → `tab: <текст>` (очередь занятого агента), поле пусто.
//
// Команды (текст поля в момент Enter):
//   STUB_WORK [мс]      — ход: заголовок со спиннером; по истечении — `Ready` (мс=0 — до STUB_READY)
//   STUB_READY          — конец хода: `Ready`
//   STUB_APPROVAL       — вопрос человеку: OSC 9 `Approval requested: …` и заголовок Action Required
//   STUB_TITLE <текст>  — произвольный заголовок
//   STUB_NOTE <текст>   — произвольное уведомление OSC 9
//   STUB_NOTIFY [json]  — как Codex после хода: запускает программу из `-c notify=[…]` с JSON последним
//   STUB_EXIT           — выход с кодом 0
//
// Окружение:
//   STUB_CODEX_NO_TITLE=1        — заголовков нет вовсе (экран входа или доверия к папке)
//   STUB_CODEX_READY_MS=<n>      — пауза до первого `Ready` (по умолчанию 0)
//   STUB_CODEX_NO_PASTE=1        — bracketed paste не включается
//   STUB_CODEX_THREAD=<uuid>     — id треда в заголовке
//   STUB_CODEX_ARGS_FILE=<путь>  — при старте пишет туда JSON { argv, cwd, env }

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const THREAD = process.env.STUB_CODEX_THREAD ?? '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const out = (text) => process.stdout.write(text);
const title = (text) => out(`\x1b]0;${text}\x07`);
const line = (text) => out(`${text.replace(/\r?\n/g, '\r\n')}\r\n`);

let spinner = null;
let frame = 0;
let stopWork = null;

function startWork(ms) {
  clearInterval(spinner);
  clearTimeout(stopWork);
  frame = 0;
  title(`${FRAMES[0]} Working | ${THREAD}`);
  spinner = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
    title(`${FRAMES[frame]} Working | ${THREAD}`);
  }, 40);
  if (ms > 0) stopWork = setTimeout(finishWork, ms);
}

function finishWork() {
  clearInterval(spinner);
  clearTimeout(stopWork);
  title(`Ready | ${THREAD}`);
}

/** Как Codex после хода: программа из `-c notify=[…]`, JSON события — последним аргументом. */
function runNotify(json) {
  const args = process.argv;
  const at = args.findIndex((arg) => arg.startsWith('notify=['));
  if (at === -1) return line('notify: в argv нет -c notify');
  let command;
  try {
    command = JSON.parse(args[at].slice('notify='.length));
  } catch {
    return line('notify: значение не JSON');
  }
  const payload =
    json ??
    JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': THREAD,
      'turn-id': 'turn-1',
      cwd: process.cwd(),
      'last-assistant-message': 'Готово.',
    });
  const child = spawn(command[0], [...command.slice(1), payload], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => undefined);
  child.unref();
  return line('notify: запущен');
}

function submit(text, key) {
  if (key === 'tab') {
    line(`tab: ${text}`);
    return;
  }
  line(`enter: ${text}`);
  const [command, ...rest] = text.split(' ');
  const argument = rest.join(' ');
  if (command === 'STUB_WORK') startWork(Number(argument || '0'));
  else if (command === 'STUB_READY') finishWork();
  else if (command === 'STUB_APPROVAL') {
    // Пока Codex ждёт человека, спиннер не крутится: заголовок держит Action Required.
    clearInterval(spinner);
    clearTimeout(stopWork);
    out(`\x1b]9;Approval requested: ls -la\x07`);
    title(`[ ! ] Action Required | ${THREAD}`);
  } else if (command === 'STUB_TITLE') title(argument);
  else if (command === 'STUB_NOTE') out(`\x1b]9;${argument}\x07`);
  else if (command === 'STUB_NOTIFY') runNotify(argument === '' ? undefined : argument);
  else if (command === 'STUB_EXIT') process.exit(0);
}

if (process.env.STUB_CODEX_ARGS_FILE !== undefined) {
  writeFileSync(
    process.env.STUB_CODEX_ARGS_FILE,
    JSON.stringify({
      argv: process.argv,
      cwd: process.cwd(),
      env: {
        HARNAS_WORK_DIR: process.env.HARNAS_WORK_DIR ?? null,
        HARNAS_SESSION_ID: process.env.HARNAS_SESSION_ID ?? null,
      },
    }),
  );
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
if (process.env.STUB_CODEX_NO_PASTE !== '1') out('\x1b[?2004h');

if (process.env.STUB_CODEX_NO_TITLE === '1') {
  line('Do you trust the contents of this directory?');
} else {
  setTimeout(() => title(`Ready | ${THREAD}`), Number(process.env.STUB_CODEX_READY_MS ?? '0'));
}
line('stub-codex готов');

let composer = '';
let pasting = false;
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const marker = pasting ? PASTE_END : PASTE_START;
    const at = pending.indexOf(marker);
    if (at === -1) {
      // Хвост может быть началом маркера, разрезанного между кусками чтения.
      const esc = pending.lastIndexOf('\x1b');
      const keep = esc !== -1 && marker.startsWith(pending.slice(esc)) ? pending.slice(esc) : '';
      const ready = pending.slice(0, pending.length - keep.length);
      pending = keep;
      if (pasting) composer += ready;
      else typed(ready);
      return;
    }
    const before = pending.slice(0, at);
    pending = pending.slice(at + marker.length);
    if (pasting) {
      composer += before;
      line(`paste: ${composer}`);
      pasting = false;
    } else {
      typed(before);
      pasting = true;
    }
  }
});

/** Обычные нажатия вне вставки: Enter отправляет, Tab — в очередь, остальное — набор. */
function typed(text) {
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      const text = composer;
      composer = '';
      submit(text, 'enter');
    } else if (char === '\t') {
      const text = composer;
      composer = '';
      submit(text, 'tab');
    } else {
      composer += char;
    }
  }
}

process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(0));
