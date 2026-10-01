// Стенд разведки «окно без терминала»: настоящий интерактивный `claude` в PTY, как его запускает
// хост Parley, плюс запись трёх источников — хуки, журнал сессии, экран терминала.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(process.env.PARLEY_HOST_PKG ?? path.resolve(HERE, '../../../packages/host/package.json'));
const pty = req('node-pty');
const { Terminal } = req('@xterm/headless');

export const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
export const PROJ = path.join(HERE, 'proj');
const NODE = process.execPath;

export const KEY = {
  enter: '\r',
  esc: '\x1b',
  shiftTab: '\x1b[Z',
  ctrlC: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
};

// Все события из справочника хуков, кроме тех, что требуют matcher с именами файлов
// (FileChanged) или подменяют поведение (WorktreeCreate/Remove, Setup).
export const ALL_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'ConfigChange',
  'CwdChanged',
  'InstructionsLoaded',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
];

/** Окружение агента без меток родительской сессии: хост Parley запускается не из Claude Code. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|PARLEY|HARNAS)/.test(key)) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  return { ...env, ...extra };
}

function writeSettings(outDir, { events = ALL_EVENTS, timeouts = {}, extra = {} } = {}) {
  const hooks = {};
  for (const event of events) {
    const handler = { type: 'command', command: `${NODE} ${path.join(HERE, 'hook.mjs')}` };
    if (timeouts[event] !== undefined) handler.timeout = timeouts[event];
    hooks[event] = [{ hooks: [handler] }];
  }
  const settings = {
    hooks,
    statusLine: { type: 'command', command: `${NODE} ${path.join(HERE, 'statusline.mjs')}` },
    ...extra,
  };
  const file = path.join(outDir, 'settings.json');
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

function tail(file, onLine) {
  let offset = 0;
  let rest = '';
  return () => {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const parts = (rest + buf.toString('utf8')).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        onLine({ unparsed: line.slice(0, 200) });
      }
    }
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Session {
  constructor(name, { args = [], cols = 110, rows = 40, settings = {}, model = 'haiku', cwd = PROJ, resume = null, replies = true } = {}) {
    this.forwardReplies = replies;
    this.name = name;
    this.out = path.join(HERE, 'out', name);
    fs.rmSync(this.out, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.out, 'screens'), { recursive: true });
    this.t0 = Date.now();
    this.marks = [];
    this.events = []; // хуки: { t, ev } и { t, decisionFor, ... }
    this.logs = []; // журнал сессии: { t, rec }
    this.status = []; // строка статуса: { t, data }
    this.ptyChunks = []; // { t, n }
    this.snapCount = 0;
    this.sessionId = resume ?? crypto.randomUUID();
    this.cwd = cwd;
    this.settingsPath = writeSettings(this.out, settings);
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    const idArgs = resume ? ['--resume', resume] : ['--session-id', this.sessionId];
    const fullArgs = [
      ...idArgs,
      '--settings',
      this.settingsPath,
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      ...(model ? ['--model', model] : []),
      ...args,
    ];
    this.cmdline = ['claude', ...fullArgs].join(' ');
    this.raw = fs.createWriteStream(path.join(this.out, 'pty.raw'));
    this.proc = pty.spawn(CLAUDE, fullArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: cleanEnv({ PROBE_OUT: this.out }),
    });
    this.exited = null;
    this.lastData = Date.now();
    this.proc.onData((data) => {
      this.raw.write(data);
      this.lastData = Date.now();
      this.ptyChunks.push({ t: this.lastData, n: data.length });
      this.term.write(data);
    });
    this.proc.onExit((info) => {
      this.exited = info;
      this.mark('exit', info);
    });
    // Настоящий терминал отвечает на запросы программы (DA1, версия, протокол клавиатуры).
    // Когда окно терминала скрыто, отвечать должен headless-терминал хоста — здесь так же.
    this.termReplies = [];
    this.term.onData((data) => {
      this.termReplies.push({ t: Date.now(), data: JSON.stringify(data) });
      if (!this.exited && this.forwardReplies) this.proc.write(data);
    });
    this.transcriptPath = path.join(
      process.env.HOME,
      '.claude',
      'projects',
      fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'),
      `${this.sessionId}.jsonl`,
    );
    this._tailEvents = tail(path.join(this.out, 'events.jsonl'), (record) => {
      this.events.push(record);
      const p = record.ev?.transcript_path;
      if (p && p !== this.transcriptPath) this._setTranscript(p);
    });
    this._tailStatus = tail(path.join(this.out, 'statusline.jsonl'), (record) => this.status.push(record));
    this._setTranscript(this.transcriptPath);
    this._timer = setInterval(() => this.poll(), 15);
  }

  _setTranscript(file) {
    this.transcriptPath = file;
    this.mark('transcript-path', { file });
    this._tailLog = tail(file, (rec) => this.logs.push({ t: Date.now(), rec }));
  }

  poll() {
    this._tailEvents();
    this._tailStatus();
    this._tailLog();
  }

  mark(kind, data = {}) {
    this.marks.push({ t: Date.now(), kind, ...data });
  }

  rel(t) {
    return t - this.t0;
  }

  async flush() {
    await new Promise((resolve) => this.term.write('', resolve));
  }

  async screen() {
    await this.flush();
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < this.term.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  async snap(label) {
    const text = await this.screen();
    const file = path.join(this.out, 'screens', `${String(++this.snapCount).padStart(2, '0')}-${label}.txt`);
    fs.writeFileSync(file, `${text}\n`);
    this.mark('snap', { label, file: path.basename(file) });
    return text;
  }

  async waitFor(what, predicate, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.poll();
      const value = await predicate();
      if (value) return value;
      if (this.exited) throw new Error(`claude вышел, пока ждали «${what}»: ${JSON.stringify(this.exited)}`);
      if (Date.now() > deadline) {
        await this.snap(`timeout-${what.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)}`);
        throw new Error(`таймаут ожидания «${what}»`);
      }
      await sleep(25);
    }
  }

  waitScreen(what, re, timeoutMs) {
    return this.waitFor(what, async () => (re.test(await this.screen()) ? true : null), timeoutMs);
  }

  /** Ждёт событие хука с индексом не меньше from; возвращает запись { t, ev }. */
  waitEvent(what, predicate, { from = 0, timeoutMs = 60000 } = {}) {
    return this.waitFor(
      what,
      () => this.events.slice(from).find((record) => record.ev && predicate(record.ev)) ?? null,
      timeoutMs,
    );
  }

  async quiet(ms = 600, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() - this.lastData < ms && Date.now() < deadline) await sleep(40);
  }

  write(data, label = 'key') {
    this.mark('write', { label, data: JSON.stringify(data).slice(0, 120) });
    this.proc.write(data);
  }

  /** Как `pty.send` хоста: вставка текста и Enter после паузы. */
  async send(text, { enterDelayMs = 250 } = {}) {
    const bracketed = this.term.modes.bracketedPasteMode;
    this.mark('send', { text: text.slice(0, 160), bracketed });
    this.proc.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
    await sleep(enterDelayMs);
    this.proc.write(KEY.enter);
  }

  control(ctl) {
    fs.writeFileSync(path.join(this.out, 'control.json'), JSON.stringify(ctl));
    this.mark('control', { ctl });
  }

  decide(decision) {
    const file = path.join(this.out, 'decision.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(decision));
    fs.renameSync(`${file}.tmp`, file);
    this.mark('decide', { decision });
  }

  async close({ graceful = true } = {}) {
    if (!this.exited && graceful) {
      // Открытый диалог съел бы текст команды: сначала Esc.
      this.proc.write(KEY.esc);
      await sleep(400);
      await this.send('/exit');
      const deadline = Date.now() + 6000;
      while (!this.exited && Date.now() < deadline) await sleep(50);
    }
    if (!this.exited) {
      this.proc.kill();
      await sleep(300);
    }
    await sleep(400);
    this.poll();
    clearInterval(this._timer);
    this.raw.end();
    const summary = {
      name: this.name,
      cmdline: this.cmdline,
      sessionId: this.sessionId,
      transcriptPath: this.transcriptPath,
      t0: this.t0,
      marks: this.marks,
      events: this.events,
      logs: this.logs,
      status: this.status,
      ptyChunks: this.ptyChunks,
    };
    fs.writeFileSync(path.join(this.out, 'timeline.json'), JSON.stringify(summary, null, 1));
    return summary;
  }
}

/** Короткая сводка событий хуков для печати: время от старта, имя, главное поле. */
export function describeEvents(session, from = 0) {
  return session.events.slice(from).map((record) => {
    const at = `${String(session.rel(record.t)).padStart(6)}ms`;
    if (!record.ev) return `${at} DECISION ${record.decisionFor} ${JSON.stringify(record.decision)?.slice(0, 160)}`;
    const ev = record.ev;
    const bits = [ev.hook_event_name];
    if (ev.tool_name) bits.push(ev.tool_name);
    if (ev.notification_type) bits.push(ev.notification_type);
    if (ev.permission_mode) bits.push(`mode=${ev.permission_mode}`);
    if (ev.source) bits.push(`source=${ev.source}`);
    if (ev.hook_event_name === 'MessageDisplay') bits.push(`#${ev.index}${ev.final ? ' final' : ''} +${(ev.delta ?? '').length}ch`);
    return `${at} ${bits.join(' ')}`;
  });
}
