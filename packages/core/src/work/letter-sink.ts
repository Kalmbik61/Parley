import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import {
  addMark,
  DIRECT_CURSOR_KEY,
  journalFile,
  journalLine,
  letterId,
  parseLetter,
  parseLetters,
  withCursors,
  type JournalLetter,
} from './journal.js';
import { LETTER_SINK, type LetterSink, type NewMessage } from './map.js';
import { workPaths, type WorkPaths } from './store.js';
import type { Message } from './types.js';

/**
 * Приёмник писем для мутатора `updateMap` на карте-журнале (v3). Мутаторы комнат, решений и планов синхронные и
 * зовут `addMessage(map, …)`, а потом берут `message.id` (решение, доставка плана), поэтому номер письма нужен сразу,
 * а не после записи. Приёмник берёт замок журнала комнаты при первом письме в неё, читает номер последней строки и
 * держит замок до сохранения карты: письма из `send_message` (они берут тот же замок) не вклинятся и номер не
 * повторится. Сами строки пишутся в `flush`, после мутатора: упал мутатор — `release` снимает замки, и в журналах
 * ничего нет, как у карты v2, которая при отказе не записывалась.
 *
 * Порядок замков: `map.lock` (его держит `updateStored`), затем замки журналов; `appendMessage` берёт только замок
 * журнала, поэтому взаимной блокировки нет. Замок берётся один раз и без ожидания (`openSync(…, 'wx')`): мутатор
 * синхронный, `await` в него не втиснуть, а ждать на главном потоке нельзя — асинхронный `appendMessage` этого же
 * процесса держит замок поверх `await`, и цикл событий, вставший на ожидании, не дал бы ему отпустить замок. Занято —
 * `JournalBusyError`; `updateStored` ждёт асинхронно и повторяет мутатор на свежем разборе карты.
 */

/** Замок журнала занят: попытку мутатора надо бросить и повторить после асинхронной паузы (`updateStored`). */
export class JournalBusyError extends Error {
  constructor(readonly lockFile: string) {
    super(`journal lock ${lockFile} is busy`);
    this.name = 'JournalBusyError';
  }
}

const MAX_TAIL_GARBAGE = 64;
const FIRST_WINDOW = 16 * 1024;

/** Замок журнала одной попыткой; занят — `JournalBusyError`, без ожидания. */
function tryAcquire(lockFile: string): number {
  try {
    return openSync(lockFile, 'wx', 0o666);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new JournalBusyError(lockFile);
    throw error;
  }
}

interface Tail {
  seq: number;
  id: string | null;
  endsWithNewline: boolean;
}

/** Номер и id последней целой строки журнала по хвосту файла (окно растёт, пока строка не найдена). Как `appendMessage`: оборванные строки пропускаются, нумерацию с нуля не начинаем. */
function readTail(file: string): Tail {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { seq: 0, id: null, endsWithNewline: true };
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return { seq: 0, id: null, endsWithNewline: true };
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    const endsWithNewline = last[0] === 0x0a;
    for (let window = FIRST_WINDOW; ; window *= 4) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      // Первая строка окна может быть оборвана слева, пока окно не дошло до начала файла.
      if (length < size) lines.shift();
      let seen = 0;
      for (let at = lines.length - 1; at >= 0; at -= 1) {
        const raw = lines[at] as string;
        if (raw === '') continue;
        const letter = parseLetter(raw);
        if (letter !== null) return { seq: letter.seq, id: letter.id, endsWithNewline };
        seen += 1;
        if (seen >= MAX_TAIL_GARBAGE) throw new Error(`journal ${file}: no parseable line among the last ${seen} lines, refusing to restart numbering`);
      }
      if (length >= size) {
        if (seen > 0) throw new Error(`journal ${file}: no parseable line among the last ${seen} lines, refusing to restart numbering`);
        return { seq: 0, id: null, endsWithNewline };
      }
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Письма журнала с хвоста: окно растёт вчетверо, пока `enough` не скажет «хватает» (по письмам окна, по порядку журнала)
 * или окно не дойдёт до начала файла. Возвращает письма последнего прочитанного окна. Файла нет — пусто.
 */
function tailLetters(file: string, enough: (letters: JournalLetter[]) => boolean): JournalLetter[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    for (let window = FIRST_WINDOW; ; window *= 4) {
      const length = Math.min(window, size);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      // Первая строка окна может быть оборвана слева, пока окно не дошло до начала файла.
      if (length < size) lines.shift();
      const letters: JournalLetter[] = [];
      for (const raw of lines) {
        if (raw === '') continue;
        const letter = parseLetter(raw);
        if (letter !== null) letters.push(letter);
      }
      if (length >= size || enough(letters)) return letters;
    }
  } finally {
    closeSync(fd);
  }
}

const asMessage = (letter: JournalLetter): Message => {
  const rest = { ...letter };
  delete (rest as { seq?: number }).seq;
  return { ...rest, readBy: {} };
};

interface JournalState {
  roomId: string | null;
  file: string;
  lockFile: string;
  fd: number | null;
  lastSeq: number;
  lastId: string | null;
  endsWithNewline: boolean;
  letters: JournalLetter[];
}

interface Entry {
  state: JournalState;
  letter: JournalLetter;
  message: Message;
}

const keyOf = (roomId: string | null): string => (roomId === null ? DIRECT_CURSOR_KEY : roomId);

export class JournalLetterSink implements LetterSink {
  private readonly paths: WorkPaths;
  private readonly states = new Map<string, JournalState>();
  private readonly entries: Entry[] = [];
  private readonly through: { roomId: string; sessions: readonly string[]; upToId: string }[] = [];
  private readonly dropped = new Set<string>();
  private readonly decisionAppends: unknown[] = [];
  private readonly decisionPatches: { match: (row: never) => boolean; patch: object }[] = [];
  /** Письма очереди как `Message`: карта мутатора показывает их рядом с письмами журналов. */
  readonly pending: Message[] = [];
  private merged = 0;

  constructor(
    private readonly projectPath: string,
    private readonly workId: string,
  ) {
    this.paths = workPaths(projectPath, workId);
  }

  /** Дописывает в `base` письма очереди, которых там ещё нет: чтение `map.messages` в мутаторе видит только что добавленное, как на v2. */
  mergePending(base: Message[]): void {
    while (this.merged < this.pending.length) base.push(this.pending[this.merged++] as Message);
  }

  get hasPending(): boolean {
    return this.states.size > 0 || this.decisionAppends.length > 0 || this.decisionPatches.length > 0;
  }

  private state(roomId: string | null): JournalState {
    const key = keyOf(roomId);
    const known = this.states.get(key);
    if (known !== undefined) return known;
    const file = journalFile(this.paths, roomId);
    mkdirSync(path.dirname(file), { recursive: true });
    const lockFile = path.join(path.dirname(file), 'messages.lock');
    let fd: number;
    try {
      fd = tryAcquire(lockFile);
    } catch (error) {
      // Что успели взять в этой попытке, отпускаем: ждать, держа часть замков, нельзя.
      this.release();
      throw error;
    }
    const state: JournalState = { roomId, file, lockFile, fd, lastSeq: 0, lastId: null, endsWithNewline: true, letters: [] };
    this.states.set(key, state);
    try {
      const tail = readTail(file);
      state.lastSeq = tail.seq;
      state.lastId = tail.id;
      state.endsWithNewline = tail.endsWithNewline;
    } catch (error) {
      this.release();
      throw error;
    }
    return state;
  }

  add(init: NewMessage, at: string): Message {
    const roomId = init.roomId ?? null;
    const state = this.state(roomId);
    const seq = state.lastSeq + 1;
    const letter: JournalLetter = {
      seq,
      id: letterId(roomId, seq),
      roomId,
      from: init.from,
      to: [...init.to],
      text: init.text,
      kind: init.kind ?? 'note',
      at,
      ...(init.replyTo === undefined ? {} : { replyTo: init.replyTo }),
    };
    const rest = { ...letter };
    delete (rest as { seq?: number }).seq;
    const message: Message = { ...rest, readBy: {} };
    this.entries.push({ state, letter, message });
    state.letters.push(letter);
    state.lastSeq = seq;
    state.lastId = letter.id;
    this.pending.push(message);
    return message;
  }

  readThrough(roomId: string, sessionIds: readonly string[]): void {
    const upToId = this.state(roomId).lastId;
    if (upToId !== null) this.through.push({ roomId, sessions: sessionIds, upToId });
  }

  dropRoom(roomId: string): void {
    this.state(roomId);
    this.dropped.add(roomId);
  }

  appendDecision(intent: unknown): void {
    this.decisionAppends.push(intent);
  }

  patchDecision(match: (row: never) => boolean, patch: object): void {
    this.decisionPatches.push({ match, patch });
  }

  find(roomId: string, id: string): Message | undefined {
    const queued = this.pending.find((message) => message.id === id && message.roomId === roomId);
    if (queued !== undefined) return queued;
    const letters = tailLetters(journalFile(this.paths, roomId), (window) => window.some((letter) => letter.id === id));
    const letter = letters.find((candidate) => candidate.id === id);
    return letter === undefined ? undefined : asMessage(letter);
  }

  recent(roomIds: readonly string[], sinceMs: number): Message[] {
    const found: Message[] = [];
    for (const roomId of [null, ...roomIds]) {
      const letters = tailLetters(journalFile(this.paths, roomId), (window) => {
        const oldest = window[0];
        return oldest !== undefined && Date.parse(oldest.at) <= sinceMs;
      });
      for (const letter of letters) if (Date.parse(letter.at) > sinceMs) found.push(asMessage(letter));
    }
    for (const message of this.pending) if (Date.parse(message.at) > sinceMs) found.push(message);
    return found;
  }

  roomLetters(roomId: string): Message[] {
    const file = journalFile(this.paths, roomId);
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return [...parseLetters(text, file).map(asMessage), ...this.pending.filter((message) => message.roomId === roomId)];
  }

  /** Снимает замки журналов; повторный вызов ничего не делает. Зовут и после удачной записи, и после отказа мутатора. */
  release(): void {
    for (const state of this.states.values()) {
      if (state.fd === null) continue;
      closeSync(state.fd);
      rmSync(state.lockFile, { force: true });
      state.fd = null;
    }
  }

  /**
   * Записывает очередь: строки журналов, решения, курсоры. Замки журналов снимаются до курсоров. Вызывает
   * `updateStored` под `map.lock` до записи индекса: упавшее письмо не оставляет индекс «отправленным». Журналы
   * удалённых комнат здесь НЕ удаляются: их убирает `afterCommit` после записи индекса.
   */
  async flush(): Promise<void> {
    try {
      for (const state of this.states.values()) {
        if (state.letters.length === 0 || (state.roomId !== null && this.dropped.has(state.roomId))) continue;
        appendFileSync(state.file, (state.endsWithNewline ? '' : '\n') + state.letters.map(journalLine).join(''));
      }
      this.flushDecisions();
    } finally {
      this.release();
    }
    await this.flushCursors();
  }

  /**
   * Убирает каталоги журналов удалённых комнат; `updateStored` зовёт после записи индекса без этих комнат. Раньше
   * (до индекса) `send_message`, прошедший проверку членства до удаления, пересоздавал `rooms/<id>/messages.jsonl`
   * для комнаты, которой уже нет в индексе, — бесхозный журнал. Теперь `appendMessage` под замком журнала видит
   * индекс без комнаты и отказывает, а каталог, созданный в окне до этого, уносится здесь.
   */
  afterCommit(): void {
    for (const roomId of this.dropped) rmSync(path.join(this.paths.rooms, roomId), { recursive: true, force: true });
  }

  private flushDecisions(): void {
    if (this.decisionAppends.length === 0 && this.decisionPatches.length === 0) return;
    let rows: unknown[] = [];
    try {
      const value: unknown = JSON.parse(readFileSync(this.paths.decisions, 'utf8'));
      if (Array.isArray(value)) rows = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const { match, patch } of this.decisionPatches) {
      const row = rows.find((candidate) => match(candidate as never));
      if (row !== undefined) Object.assign(row as object, patch);
    }
    rows.push(...this.decisionAppends);
    const tmp = `${this.paths.decisions}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rows)}\n`, 'utf8');
    renameSync(tmp, this.paths.decisions);
  }

  private async flushCursors(): Promise<void> {
    const bySession = new Map<string, Entry[]>();
    for (const entry of this.entries) {
      if (entry.letter.roomId !== null && this.dropped.has(entry.letter.roomId)) continue;
      for (const sessionId of Object.keys(entry.message.readBy)) bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), entry]);
    }
    const sessions = new Set<string>(bySession.keys());
    for (const op of this.through) if (!this.dropped.has(op.roomId)) for (const sessionId of op.sessions) sessions.add(sessionId);
    if (this.dropped.size > 0) {
      for (const name of readdirSyncOrEmpty(this.paths.cursors)) if (name.endsWith('.json')) sessions.add(name.slice(0, -'.json'.length));
    }
    for (const sessionId of sessions) {
      await withCursors(this.projectPath, this.workId, sessionId, async (cursors, state) => {
        let changed = false;
        for (const roomId of this.dropped) {
          if (cursors[roomId] !== undefined || state.marks[roomId] !== undefined) {
            delete cursors[roomId];
            delete state.marks[roomId];
            changed = true;
          }
        }
        // Явное «прочитано по письмо» (`readThrough`) — водораздел: так задумано, это действие над всей лентой комнаты.
        for (const op of this.through) {
          if (this.dropped.has(op.roomId) || !op.sessions.includes(sessionId)) continue;
          cursors[op.roomId] = op.upToId;
          delete state.marks[op.roomId];
          changed = true;
        }
        // Отметка `readBy`, поставленная мутатором письму, — РАЗРЕЖЕННАЯ отметка, а не водораздел: водораздел одним
        // id снял бы «непрочитано» со всех более ранних писем журнала (системная строка погасила бы человеку
        // вопросы агента). Отметка вплотную за водоразделом сворачивается в него (`normalizeMarks`), позади водораздела
        // не пишется.
        for (const { letter } of bySession.get(sessionId) ?? []) {
          if (addMark(state, keyOf(letter.roomId), letter.id)) changed = true;
        }
        return { changed, value: undefined };
      });
    }
  }
}

function readdirSyncOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Вешает приёмник на карту мутатора под ключом-символом: в JSON, `Object.keys` и `structuredClone` он не попадает, а
 * копия карты через `{ ...map }` (черновики планов) его уносит — письмо, добавленное в черновик, тоже уйдёт в журнал.
 */
export function attachSink(view: object, sink: JournalLetterSink): void {
  Object.defineProperty(view, LETTER_SINK, { value: sink, enumerable: true, configurable: true });
}

/**
 * Приёмник «примерки» (проход службы эффектов плана): письма и решения принимает только в память, ничего не берёт и не пишет —
 * ни замков журналов, ни строк. Читающие вызовы (`find`, `recent`, `roomLetters`) идут в настоящий приёмник, у которого очередь
 * всегда пуста: они читают хвосты журналов без замков. Примерка отвечает на вопрос «изменится ли что-нибудь», и карта с таким
 * приёмником выбрасывается; настоящая запись идёт через `updateMap`.
 */
export class PreviewLetterSink implements LetterSink {
  private readonly real: JournalLetterSink;
  private added = 0;
  readonly pending: Message[] = [];

  constructor(projectPath: string, workId: string) {
    this.real = new JournalLetterSink(projectPath, workId);
  }

  add(init: Parameters<LetterSink['add']>[0], at: string): Message {
    this.added += 1;
    const message: Message = {
      id: `m-preview-${this.added}`,
      roomId: init.roomId ?? null,
      from: init.from,
      to: [...init.to],
      text: init.text,
      kind: init.kind ?? 'note',
      at,
      readBy: {},
      ...(init.replyTo === undefined ? {} : { replyTo: init.replyTo }),
    };
    this.pending.push(message);
    return message;
  }

  readThrough(): void {}

  dropRoom(): void {}

  appendDecision(): void {}

  patchDecision(): void {}

  find(roomId: string, id: string): Message | undefined {
    return this.pending.find((message) => message.id === id && message.roomId === roomId) ?? this.real.find(roomId, id);
  }

  recent(roomIds: readonly string[], sinceMs: number): Message[] {
    return [...this.real.recent(roomIds, sinceMs), ...this.pending.filter((message) => Date.parse(message.at) > sinceMs)];
  }

  roomLetters(roomId: string): Message[] {
    return [...this.real.roomLetters(roomId), ...this.pending.filter((message) => message.roomId === roomId)];
  }
}

/** Вешает на карту приёмник примерки (`PreviewLetterSink`): см. его описание. */
export function attachPreviewSink(view: object, projectPath: string, workId: string): void {
  Object.defineProperty(view, LETTER_SINK, { value: new PreviewLetterSink(projectPath, workId), enumerable: true, configurable: true });
}
