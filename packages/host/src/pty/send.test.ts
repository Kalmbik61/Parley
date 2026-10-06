import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import { HostError } from '../errors.js';
import { fakePty } from '../../test/fake-pty.js';
import type { FakePty } from '../../test/fake-pty.js';
import { createSender, sanitizeForSend } from './send.js';

const ref: SessionRef = { projectPath: '/tmp/project', workId: 'w-01', sessionId: 's-01' };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HostError ? error.code : 'not-host-error';
  }
}

describe('sanitizeForSend', () => {
  it('\\r\\n → \\n', () => {
    expect(sanitizeForSend('a\r\nb')).toBe('a\nb');
    expect(sanitizeForSend('a\rb')).toBe('a\nb');
  });

  it('ESC-последовательности вырезаны', () => {
    expect(sanitizeForSend('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('\\x07 и \\x7f вырезаны, \\t и \\n остались', () => {
    expect(sanitizeForSend('a\x07b\x7fc\td\ne')).toBe('abc\td\ne');
  });

  it('OSC 52 вырезается целиком, тело не остаётся мусором', () => {
    expect(sanitizeForSend('\x1b]52;c;aGVsbG8=\x07rest')).toBe('rest');
    expect(sanitizeForSend('a\x1b]0;title\x1b\\b')).toBe('ab');
  });

  it('только ESC — bad_request', () => {
    expect(codeOf(() => sanitizeForSend('\x1b[31m\x1b'))).toBe('bad_request');
    expect(() => sanitizeForSend('\x1b[31m\x1b')).toThrow(/^empty text$/);
  });

  it('64 КиБ ровно проходит, 64 КиБ + 1 байт (кириллица) — bad_request', () => {
    const half = 'я'.repeat(32 * 1024); // 2 байта UTF-8 на символ
    expect(codeOf(() => sanitizeForSend(half))).toBe(null);
    expect(codeOf(() => sanitizeForSend(`${half}a`))).toBe('bad_request');
    expect(() => sanitizeForSend(`${half}a`)).toThrow(/^text is longer than 64 KiB$/);
  });
});

describe('createSender', () => {
  let pty: FakePty;
  let activityState: string;
  /** Последнее событие хуков; по умолчанию — после запуска процесса (fake: startedAt 0). */
  let lastEventAt: string | null;
  let wakeInFlight: boolean;
  /** Замок смены модели и effort этой сессии занят (`SessionsService.exclusive.held`). */
  let switching: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    switching = false;
    pty = fakePty();
    activityState = 'idle';
    lastEventAt = new Date(1000).toISOString();
    wakeInFlight = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sender() {
    const activity = {
      get: () => ({ activity: { activity: activityState, lastEventAt } }),
    } as unknown as ActivityService;
    return createSender({
      pty: pty.manager,
      activity,
      wake: { inFlight: () => wakeInFlight, enterDelayMs: 500 },
      switching: () => switching,
    });
  }

  it('сессии без PTY — not_found', async () => {
    pty.live = false;
    await expect(sender()({ ref, text: 'hi', submit: true })).rejects.toMatchObject({
      code: 'not_found',
      message: 'session is not running',
    });
  });

  it('blocked — ни одной записи, текст не вставлен', async () => {
    activityState = 'blocked';
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'blocked',
    });
    expect(pty.writes).toEqual([]);
  });

  it('на экране открытый ползунок /effort (поздний, после Esc хоста) — blocked, ни одной записи: Enter сохранил бы уровень умолчанием', async () => {
    pty.screen = ['  ◐ Effort', '  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'];
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'blocked',
    });
    await expect(sender()({ ref, text: 'hi', submit: false })).resolves.toMatchObject({ reason: 'blocked' });
    expect(pty.writes).toEqual([]);
  });

  it('замок смены модели и effort взят — blocked, ни одной записи: текст попал бы в открытый ползунок', async () => {
    switching = true;
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'blocked',
    });
    expect(pty.writes).toEqual([]);
  });

  it('без подсказки ползунка на экране и без замка отправка идёт как раньше', async () => {
    pty.screen = ['● Готово', '> '];
    const sent = sender()({ ref, text: 'hi', submit: false });
    await expect(sent).resolves.toEqual({ inserted: true, submitted: false, reason: null });
    expect(pty.writes).toEqual(['hi']);
  });

  it('ни одного хука с запуска процесса (вопрос доверия к папке) — blocked, ни одной записи (fix-final-b)', async () => {
    lastEventAt = null;
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'blocked',
    });
    // И без submit: вставленные символы прочитал бы сам диалог.
    await expect(sender()({ ref, text: 'hi', submit: false })).resolves.toMatchObject({ reason: 'blocked' });
    expect(pty.writes).toEqual([]);
  });

  it('хуки только прошлого процесса — blocked (fix-final-b)', async () => {
    pty.startedAt = 5000;
    lastEventAt = new Date(4999).toISOString();
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toMatchObject({ reason: 'blocked' });
    expect(pty.writes).toEqual([]);
  });

  it('стал blocked в ожидании Enter — вставлен без Enter, blocked-before-enter, \\r нет (fix-final-b)', async () => {
    const result = sender()({ ref, text: 'hi', submit: true });
    await vi.advanceTimersByTimeAsync(300);
    activityState = 'blocked';
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: 'blocked-before-enter' });
    expect(pty.writes).toEqual(['hi']);
    // Текст остался в поле ввода — черновик хоста держит будильник.
    expect(pty.hostDraft).toBe(true);
  });

  it('будильник в полёте — busy, ни одной записи', async () => {
    wakeInFlight = true;
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'busy',
    });
    expect(pty.writes).toEqual([]);
  });

  it('многострочный текст без режима вставки — no-paste-mode, записей нет', async () => {
    await expect(sender()({ ref, text: 'a\nb', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'no-paste-mode',
    });
    expect(pty.writes).toEqual([]);
  });

  it('с режимом вставки — запись в маркерах ESC[200~…ESC[201~', async () => {
    pty.paste = true;
    const result = sender()({ ref, text: 'a\nb', submit: false });
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: null });
    expect(pty.writes).toEqual(['\x1b[200~a\nb\x1b[201~']);
  });

  it('submit: false — вставлен без \\r, черновик хоста стоит', async () => {
    await expect(sender()({ ref, text: 'hi', submit: false })).resolves.toEqual({
      inserted: true,
      submitted: false,
      reason: null,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual(['hi']);
    expect(pty.hostDraft).toBe(true);
  });

  it('черновик человека до вставки — draft, без \\r', async () => {
    pty.humanDraft = true;
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: true,
      submitted: false,
      reason: 'draft',
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual(['hi']);
  });

  it('ввод человека в ожидании Enter — input', async () => {
    const result = sender()({ ref, text: 'hi', submit: true });
    pty.emitDraft(ref);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: 'input' });
    expect(pty.writes).toEqual(['hi']);
  });

  it('процесс сменился за ожидание — restarted', async () => {
    const result = sender()({ ref, text: 'hi', submit: true });
    pty.pid = 101;
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: 'restarted' });
  });

  it('запись Enter бросила — pty.send отклонён, следующий вызов не busy', async () => {
    const write = pty.manager.write;
    pty.manager.write = (target, data) => {
      if (data === '\r') throw new Error('PTY закрыт');
      write(target, data);
    };
    const send = sender();
    const settled = send({ ref, text: 'hi', submit: true }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(settled).resolves.toEqual({ error: 'Error: PTY закрыт' });
    pty.hostDraft = false;
    await expect(send({ ref, text: 'x', submit: false })).resolves.toEqual({
      inserted: true,
      submitted: false,
      reason: null,
    });
  });

  it('всё чисто — submitted, последняя запись \\r, черновик хоста снят', async () => {
    const result = sender()({ ref, text: 'hi', submit: true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ inserted: true, submitted: true, reason: null });
    expect(pty.writes).toEqual(['hi', '\r']);
    expect(pty.hostDraft).toBe(false);
  });

  it('после вставки без Enter следующая submit: true — draft без \\r (черновик хоста)', async () => {
    const send = sender();
    await send({ ref, text: 'path ', submit: false });
    const result = send({ ref, text: 'hi', submit: true });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: 'draft' });
    expect(pty.writes).toEqual(['path ', 'hi']);
  });

  for (const submit of [true, false]) {
    it(`второй вызов (submit: ${submit}) в ожидании Enter первого — busy, в PTY только первый и один \\r`, async () => {
      const send = sender();
      const first = send({ ref, text: 'first', submit: true });
      await expect(send({ ref, text: 'second', submit })).resolves.toEqual({
        inserted: false,
        submitted: false,
        reason: 'busy',
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(first).resolves.toEqual({ inserted: true, submitted: true, reason: null });
      expect(pty.writes).toEqual(['first', '\r']);

      // Enter первого ушёл — сессия снова свободна.
      const third = send({ ref, text: 'third', submit: true });
      await vi.advanceTimersByTimeAsync(500);
      await expect(third).resolves.toMatchObject({ submitted: true });
    });
  }

  it('вставка без await после проверок: запись видна сразу после вызова', () => {
    void sender()({ ref, text: 'hi', submit: true });
    expect(pty.writes).toEqual(['hi']);
    expect(pty.hostDraft).toBe(true);
  });

  it('пустой после очистки текст — bad_request, записей нет', async () => {
    await expect(sender()({ ref, text: '\x1b[31m', submit: true })).rejects.toMatchObject({ code: 'bad_request' });
    expect(pty.writes).toEqual([]);
  });
});

describe('createSender: codex (спека комнат Organic, 3.6, «Ввод»)', () => {
  let pty: FakePty;
  let activityState: string;
  let lastEventAt: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    pty = fakePty();
    pty.provider = 'codex';
    // Codex включает bracketed paste при старте TUI: без режима писать в него нечего.
    pty.paste = true;
    activityState = 'unseen';
    lastEventAt = new Date(1000).toISOString();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sender() {
    const activity = {
      get: () => ({ activity: { activity: activityState, lastEventAt } }),
    } as unknown as ActivityService;
    return createSender({
      pty: pty.manager,
      activity,
      wake: { inFlight: () => false, enterDelayMs: 500 },
    });
  }

  const PASTE = (text: string): string => `\x1b[200~${text}\x1b[201~`;

  it('у приглашения: вставка в маркерах, пауза десятки миллисекунд, Enter', async () => {
    const result = sender()({ ref, text: 'привет', submit: true });
    expect(pty.writes).toEqual([PASTE('привет')]);
    await vi.advanceTimersByTimeAsync(59);
    expect(pty.writes).toEqual([PASTE('привет')]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ inserted: true, submitted: true, reason: null });
    expect(pty.writes).toEqual([PASTE('привет'), '\r']);
    expect(pty.hostDraft).toBe(false);
  });

  it('и однострочный текст идёт вставкой (у Claude он шёл бы просто буквами)', async () => {
    void sender()({ ref, text: 'одна строка', submit: false });
    expect(pty.writes).toEqual([PASTE('одна строка')]);
  });

  it('агент работает — Tab (очередь), а не Enter (вмешательство в ход)', async () => {
    activityState = 'working';
    const result = sender()({ ref, text: 'письмо занятому', submit: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({ inserted: true, submitted: true, reason: null });
    expect(pty.writes).toEqual([PASTE('письмо занятому'), '\t']);
    expect(pty.hostDraft).toBe(false);
  });

  it('клавиша решается на отправке: ход кончился за паузу — Enter, начался — Tab', async () => {
    activityState = 'working';
    const first = sender()({ ref, text: 'а', submit: true });
    activityState = 'unseen';
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(pty.writes.at(-1)).toBe('\r');

    activityState = 'unseen';
    const second = sender()({ ref, text: 'б', submit: true });
    activityState = 'working';
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(pty.writes.at(-1)).toBe('\t');
  });

  it('текст санитизируется: «/», «!», «$» в начале и токен меню на конце', async () => {
    const send = sender();
    void send({ ref, text: '/Users/me/a.png', submit: false });
    expect(pty.writes).toEqual([PASTE('- /Users/me/a.png ')]);
    pty.hostDraft = false;
    void send({ ref, text: 'посмотри @README.md', submit: false });
    expect(pty.writes.at(-1)).toBe(PASTE('посмотри @README.md '));
  });

  it('blocked («нужен ты») — ни вставки, ни клавиши: диалог отвечать нельзя', async () => {
    activityState = 'blocked';
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'blocked',
    });
    expect(pty.writes).toEqual([]);
  });

  it('ни одного известного сигнала с запуска (экран входа или доверия) — blocked, ни байта', async () => {
    lastEventAt = null;
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toMatchObject({ reason: 'blocked' });
    expect(pty.writes).toEqual([]);
  });

  it('стал blocked за паузу — вставлен без клавиши, blocked-before-enter', async () => {
    const result = sender()({ ref, text: 'hi', submit: true });
    await vi.advanceTimersByTimeAsync(30);
    activityState = 'blocked';
    await vi.advanceTimersByTimeAsync(60);
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: 'blocked-before-enter' });
    expect(pty.writes).toEqual([PASTE('hi')]);
  });

  it('режима вставки нет (TUI не поднялся) — no-paste-mode, ни байта', async () => {
    pty.paste = false;
    await expect(sender()({ ref, text: 'hi', submit: true })).resolves.toEqual({
      inserted: false,
      submitted: false,
      reason: 'no-paste-mode',
    });
    expect(pty.writes).toEqual([]);
  });

  it('ввод человека в паузе — input, клавиши нет', async () => {
    const result = sender()({ ref, text: 'hi', submit: true });
    pty.emitDraft(ref);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({ inserted: true, submitted: false, reason: 'input' });
    expect(pty.writes).toEqual([PASTE('hi')]);
  });

  it('не codex (claude) тем же отправителем — прежнее поведение: 500 мс и Enter, без вставки', async () => {
    pty.provider = 'claude';
    pty.paste = false;
    const result = sender()({ ref, text: 'hi', submit: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(pty.writes).toEqual(['hi']);
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toMatchObject({ submitted: true });
    expect(pty.writes).toEqual(['hi', '\r']);
  });

  it('не codex занятому: Enter, как и раньше (Tab — только у Codex)', async () => {
    pty.provider = 'claude';
    pty.paste = false;
    activityState = 'working';
    const result = sender()({ ref, text: 'hi', submit: true });
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(pty.writes).toEqual(['hi', '\r']);
  });
});
