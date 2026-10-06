#!/usr/bin/env node
// Заглушка вместо настоящего `codex` для E2E окна (кусок 11a плана комнат Organic). Настоящий codex в
// автотестах не запускается никогда — даже с --version: вход, лимиты подписки, недетерминизм. Подмена
// бинаря — та же, что у claude: `PARLEY_CODEX_BIN` (`findRunnerBinary` в core), рядом со
// `stub-echo-agent.mjs`.
//
// Ведёт себя как Codex ровно настолько, насколько на это опирается хост (спека комнат, 3.6):
// - включает bracketed paste и пишет заголовок окна (OSC 0): `Ready | <id>`, кадры спиннера
//   `⠋ Working | <id>` во время хода, `[ ! ] Action Required | <id>` и уведомление OSC 9 при вопросе;
// - принимает ввод как поле Codex: вставка ESC[200~ … ESC[201~ копится в поле, Enter (\r) отправляет
//   (`enter: <текст>`), Tab (\t) ставит в очередь занятого агента (`tab: <текст>`);
// - по «отправленной» строке выполняет команду `STUB_*`:
//     STUB_WORK       — ход: заголовок со спиннером, пока не придёт STUB_READY или STUB_NOTIFY
//     STUB_READY      — конец хода: `Ready`
//     STUB_APPROVAL   — вопрос человеку: OSC 9 `Approval requested: …` и заголовок Action Required
//     STUB_NOTIFY     — конец хода без заголовка `Ready`: спиннер молча замолкает, а заглушка запускает
//                       программу из `-c notify=[…]` своего argv — так, как это делает Codex после хода
//                       (JSON события `agent-turn-complete` последним аргументом). Программа настоящая:
//                       скрипт харнесса, который пишет строку `Stop` в журнал событий сессии
//     STUB_EXIT       — выход с кодом 0
//
// Окружение:
//   STUB_CODEX_NO_TITLE=1  — заголовков нет вовсе: экран входа или доверия к папке, которого агент не покидает
//   STUB_CODEX_THREAD=<id> — id треда в заголовке и в JSON notify

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { clearInterval, setInterval } from 'node:timers';
import { URL } from 'node:url';

// Проба версий хоста (`<команда> --version`): ответ как у настоящего Codex, выход сразу.
if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli 0.44.0\n');
  process.exit(0);
}

// Каталог моделей (`codex debug models`; нормалайзер модели и effort 2026-10-06, спека 5.2): хост спрашивает его на
// старте, как версию. Ответ — урезанный каталог в форме настоящего (`fixtures/codex-debug-models.json`): две видимые
// модели не в порядке `priority` и одна скрытая — по ним E2E видит, что список пришёл от CLI, а не встроенный.
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(readFileSync(new URL('./fixtures/codex-debug-models.json', import.meta.url), 'utf8'));
  process.exit(0);
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const THREAD = process.env.STUB_CODEX_THREAD ?? '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const out = (text) => process.stdout.write(text);
const title = (text) => out(`\x1b]0;${text}\x07`);
const line = (text) => out(`${text.replace(/\r?\n/g, '\r\n')}\r\n`);

let spinner = null;

function startWork() {
  clearInterval(spinner);
  let frame = 0;
  title(`${FRAMES[0]} Working | ${THREAD}`);
  spinner = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
    title(`${FRAMES[frame]} Working | ${THREAD}`);
  }, 60);
}

function stopSpinner() {
  clearInterval(spinner);
  spinner = null;
}

/** Как Codex после хода: программа из `-c notify=[…]`, JSON события — последним аргументом. */
function runNotify() {
  const at = process.argv.findIndex((arg) => arg.startsWith('notify=['));
  if (at === -1) return line('notify: в argv нет -c notify');
  const command = JSON.parse(process.argv[at].slice('notify='.length));
  const event = JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': THREAD,
    'turn-id': 'turn-1',
    cwd: process.cwd(),
    'last-assistant-message': 'Готово.',
  });
  const child = spawn(command[0], [...command.slice(1), event], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
  return line('notify: запущен');
}

function submit(text, key) {
  if (key === 'tab') return line(`tab: ${text}`);
  line(`enter: ${text}`);
  if (text === 'STUB_WORK') startWork();
  else if (text === 'STUB_READY') {
    stopSpinner();
    title(`Ready | ${THREAD}`);
  } else if (text === 'STUB_APPROVAL') {
    // Пока Codex ждёт человека, спиннер не крутится: заголовок держит Action Required.
    stopSpinner();
    out('\x1b]9;Approval requested: ls -la\x07');
    title(`[ ! ] Action Required | ${THREAD}`);
  } else if (text === 'STUB_NOTIFY') {
    stopSpinner();
    runNotify();
  } else if (text === 'STUB_EXIT') process.exit(0);
  return undefined;
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
out('\x1b[?2004h');
line('stub-codex готов');
if (process.env.STUB_CODEX_NO_TITLE === '1') line('Do you trust the contents of this directory?');
else title(`Ready | ${THREAD}`);

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

/** Нажатия вне вставки: Enter отправляет, Tab — в очередь, остальное — набор. */
function typed(text) {
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      const sent = composer;
      composer = '';
      submit(sent, 'enter');
    } else if (char === '\t') {
      const sent = composer;
      composer = '';
      submit(sent, 'tab');
    } else {
      composer += char;
    }
  }
}

process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(0));
