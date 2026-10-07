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
//     STUB_WORK       — ход: заголовок со спиннером, пока не придёт STUB_READY или STUB_NOTE
//     STUB_READY      — конец хода: `Ready`
//     STUB_APPROVAL   — вопрос человеку: OSC 9 `Approval requested: …` и заголовок Action Required
//     STUB_NOTE <текст> — уведомление OSC 9 с этим текстом; спиннер молча замолкает, заголовок `Ready` не
//                       пишется. `STUB_NOTE Agent turn complete` — конец хода, как его видит хост без
//                       подмены `notify` (спека 2026-10-07, 5.5)
//     STUB_EXIT       — выход с кодом 0
//   Журнал Codex (STUB_CODEX_SESSIONS, спека ленты Codex 2026-10-07, 5.3) — команды, которые что-то пишут в него:
//     обычный ввод    — ход начат (`task_started`), текст — `UserMessage`
//     STUB_CMD <cmd>  — `CommandExecution` (`/bin/zsh -lc <cmd>`, вывод `ok`)
//     STUB_EDIT <путь> — `FileChange` с коротким unified diff
//     STUB_SAY <текст> — `AgentMessage` (final_answer), `task_complete`, затем OSC 9 `Agent turn complete`
//     STUB_SUBAGENT <тред> / STUB_SUBAGENT_DONE <тред> — агент: `SubAgentActivity` в журнале родителя и свой журнал
//     Esc во время хода — `turn_aborted`
//
// Окружение:
//   STUB_CODEX_NO_TITLE=1  — заголовков нет вовсе: экран входа или доверия к папке, которого агент не покидает
//   STUB_CODEX_THREAD=<id> — id треда в заголовке и в журнале
//   STUB_CODEX_VERSION=<x.y.z> — версия в ответе на --version (по умолчанию 0.44.0)
//   STUB_CODEX_SESSIONS=<каталог> — корень журналов: при старте создаётся rollout-файл треда

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { URL } from 'node:url';

// Проба версий хоста (`<команда> --version`): ответ как у настоящего Codex, выход сразу.
if (process.argv[2] === '--version') {
  process.stdout.write(`codex-cli ${process.env.STUB_CODEX_VERSION ?? '0.44.0'}\n`);
  process.exit(0);
}

// Каталог моделей (`codex debug models`; нормалайзер модели и effort 2026-10-06, спека 5.2): хост спрашивает его на
// старте, как версию. Ответ — урезанный каталог в форме настоящего (`fixtures/codex-debug-models.json`): две видимые
// модели не в порядке `priority` и одна скрытая — по ним E2E видит, что список пришёл от CLI, а не встроенный.
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(readFileSync(new URL('./fixtures/codex-debug-models.json', import.meta.url), 'utf8'));
  process.exit(0);
}

// STUB_ARGV_LOG=<файл>: каждый запуск дописывает строку JSON с argv и окружением Parley — так E2E сверяет
// то, что хост передал агенту (флаги, системный слой, переменные навигатора), не читая настоящий процесс.
if (process.env.STUB_ARGV_LOG !== undefined && process.env.STUB_ARGV_LOG !== '') {
  const keep = Object.entries(process.env).filter(([name]) => name.startsWith('PARLEY_') || name.startsWith('HARNAS_') || name === 'SLASH_COMMAND_TOOL_CHAR_BUDGET');
  appendFileSync(process.env.STUB_ARGV_LOG, `${JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(keep), cwd: process.cwd() })}\n`);
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const THREAD = process.env.STUB_CODEX_THREAD ?? '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const out = (text) => process.stdout.write(text);
const title = (text) => out(`\x1b]0;${text}\x07`);
const line = (text) => out(`${text.replace(/\r?\n/g, '\r\n')}\r\n`);

let spinner = null;

// Журнал Codex: rollout-файл треда в корне STUB_CODEX_SESSIONS. Без переменной все функции ниже ничего не делают.
// Хост запускает бинарь и без терминала (клиент ролей `app-server` по stdio): журнал пишет только процесс под PTY.
const SESSIONS = process.stdin.isTTY ? process.env.STUB_CODEX_SESSIONS : undefined;
const VERSION = process.env.STUB_CODEX_VERSION ?? '0.44.0';
const CHILD_TASK = 'Найди все места, где строится карточка агента, и перечисли файлы со строками. '.repeat(3).slice(0, 200);
const EDIT_DIFF = '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n';

/** Журнал одного треда: файл, счётчик `ordinal` и запись строки. */
function openRollout(threadId, meta) {
  if (SESSIONS === undefined || SESSIONS === '') return null;
  const now = new Date();
  const dir = path.join(SESSIONS, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${now.toISOString().replace(/[:.]/g, '-')}-${threadId}.jsonl`);
  writeFileSync(file, '');
  const log = {
    ordinal: 0,
    write(type, payload) {
      appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ordinal: log.ordinal, type, payload })}\n`);
      log.ordinal += 1;
    },
  };
  log.write('session_meta', { id: threadId, cli_version: VERSION, ...meta });
  return log;
}

const main = openRollout(THREAD, { cwd: process.cwd(), source: 'cli' });
main?.write('turn_context', {
  turn_id: 't0',
  model: 'gpt-6-astra',
  approval_policy: 'on-request',
  sandbox_policy: { type: 'workspace-write' },
});

let turn = 0;
let turnOpen = false;
let items = 0;
const children = new Map();

/** Ход начинается с первой записи; уже идущий не дублируется. */
function ensureTurn() {
  if (main === null || turnOpen) return;
  turn += 1;
  turnOpen = true;
  main.write('event_msg', { type: 'task_started', turn_id: `u${turn}` });
}

/** Законченный элемент хода `item_completed` в журнал треда. */
function item(log, threadId, body) {
  items += 1;
  log?.write('event_msg', { type: 'item_completed', thread_id: threadId, turn_id: `u${turn}`, item: { id: `it${items}`, ...body } });
}

function endTurn(type, extra) {
  if (main === null || !turnOpen) return;
  turnOpen = false;
  main.write('event_msg', { type, turn_id: `u${turn}`, ...extra });
}

/** Команды журнала: `true`, если строка — одна из них. */
function journalCommand(text) {
  if (main === null) return false;
  const rest = (name) => (text.startsWith(`${name} `) ? text.slice(name.length + 1) : null);
  const cmd = rest('STUB_CMD');
  const edit = rest('STUB_EDIT');
  const say = rest('STUB_SAY');
  const sub = rest('STUB_SUBAGENT');
  const subDone = rest('STUB_SUBAGENT_DONE');
  if (cmd !== null) {
    ensureTurn();
    item(main, THREAD, { type: 'CommandExecution', command: ['/bin/zsh', '-lc', cmd], cwd: process.cwd(), parsed_cmd: [], source: 'agent', status: 'completed', aggregated_output: 'ok', exit_code: 0 });
  } else if (edit !== null) {
    ensureTurn();
    item(main, THREAD, { type: 'FileChange', status: 'completed', changes: { [edit]: { type: 'update', unified_diff: EDIT_DIFF } } });
  } else if (say !== null) {
    ensureTurn();
    item(main, THREAD, { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'text', text: say }] });
    endTurn('task_complete', { last_agent_message: say, duration_ms: 1000 });
    stopSpinner();
    out('\x1b]9;Agent turn complete\x07');
  } else if (subDone !== null) {
    const child = children.get(subDone);
    if (child === undefined) return true;
    item(child, subDone, { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'text', text: 'Нашёл: reduce.ts:452' }] });
    item(main, THREAD, { type: 'SubAgentActivity', kind: 'completed', agent_thread_id: subDone, agent_path: '/root/explorer' });
  } else if (sub !== null) {
    ensureTurn();
    const path0 = '/root/explorer';
    const child = openRollout(sub, {
      parent_thread_id: THREAD,
      forked_from_id: THREAD,
      agent_nickname: 'explorer',
      subagent_history_start_ordinal: 1,
      source: { subagent: { thread_spawn: { parent_thread_id: THREAD, depth: 1, agent_path: path0, agent_nickname: 'explorer', agent_role: 'explorer' } } },
    });
    children.set(sub, child);
    child.write('response_item', { type: 'agent_message', author: '/root', recipient: path0, content: [{ type: 'input_text', text: CHILD_TASK }] });
    item(child, sub, { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'rg -n newAgent packages/core/src'], cwd: process.cwd(), parsed_cmd: [], source: 'agent', status: 'completed', aggregated_output: 'reduce.ts:452', exit_code: 0 });
    item(main, THREAD, { type: 'SubAgentActivity', kind: 'started', agent_thread_id: sub, agent_path: path0 });
  } else return false;
  return true;
}

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

function submit(text, key) {
  if (key === 'tab') {
    line(`tab: ${text}`);
    // Ход идёт (обычный ввод его открыл), и окно отправило строку в очередь Tab: команды журнала заглушка исполняет сразу.
    journalCommand(text);
    return undefined;
  }
  line(`enter: ${text}`);
  if (journalCommand(text)) return undefined;
  if (text === 'STUB_WORK') {
    // Ход в ленте начинается сообщением пользователя: без него `turnActive` хода не видит (кнопки Stop не будет).
    const fresh = !turnOpen;
    ensureTurn();
    if (fresh) item(main, THREAD, { type: 'UserMessage', content: [{ type: 'text', text }] });
    startWork();
  }
  else if (text === 'STUB_READY') {
    stopSpinner();
    title(`Ready | ${THREAD}`);
  } else if (text === 'STUB_APPROVAL') {
    // Пока Codex ждёт человека, спиннер не крутится: заголовок держит Action Required.
    stopSpinner();
    out('\x1b]9;Approval requested: ls -la\x07');
    title(`[ ! ] Action Required | ${THREAD}`);
  } else if (text === 'STUB_NOTE' || text.startsWith('STUB_NOTE ')) {
    stopSpinner();
    out(`\x1b]9;${text.slice('STUB_NOTE'.length).trim()}\x07`);
  } else if (text === 'STUB_EXIT') process.exit(0);
  else if (main !== null && !text.startsWith('STUB_')) {
    // Обычный ввод человека или окна: ход начат, текст — сообщение пользователя.
    ensureTurn();
    item(main, THREAD, { type: 'UserMessage', content: [{ type: 'text', text }] });
  }
  return undefined;
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
out('\x1b[?2004h');
line('stub-codex готов');
if (process.env.STUB_CODEX_NO_TITLE === '1') line('Do you trust the contents of this directory?');
else title(`Ready | ${THREAD}`);

let composer = '';
let pasting = false;
let escTimer;
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
      // Одинокий Esc — начало маркера вставки: если продолжения нет, это клавиша Esc (прерывание хода).
      if (pending === '\x1b') {
        clearTimeout(escTimer);
        escTimer = setTimeout(() => {
          if (pending !== '\x1b') return;
          pending = '';
          interrupt();
        }, 40);
      }
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

/** Esc: идущий ход прерван — `turn_aborted`, спиннер молчит, заголовок `Ready`. */
function interrupt() {
  if (!turnOpen) return;
  stopSpinner();
  endTurn('turn_aborted', { reason: 'interrupted' });
  title(`Ready | ${THREAD}`);
}

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
