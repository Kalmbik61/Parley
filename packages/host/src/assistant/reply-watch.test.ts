import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { createReplyWatch, WATCH_MAX_COUNT, WATCH_MAX_MS, WATCH_SETTLE_MS, type ReplyWatch, type WatchActivity, type WatchEvent } from './reply-watch.js';

const ref = (sessionId: string, workId = 'w-1'): SessionRef => ({ projectPath: '/p', workId, sessionId });
const idle: WatchActivity = { need: null };
const needOf = (kind: string, since: string): WatchActivity => ({ need: { kind, since, detail: null } });

let clock = 0;
let timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
let events: WatchEvent[] = [];
let notes: string[] = [];
let watch: ReplyWatch;

/** Часы подставные: время идёт только через `advance`, таймеры срабатывают по порядку срока. */
function advance(ms: number): void {
  const until = clock + ms;
  for (;;) {
    const next = timers.filter((timer) => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0];
    if (next === undefined) break;
    clock = next.at;
    next.live = false;
    next.fn();
  }
  clock = until;
}

beforeEach(() => {
  clock = 1_000_000;
  timers = [];
  events = [];
  notes = [];
  watch = createReplyWatch({
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    onEvent: (event) => events.push(event),
    onNote: (note) => notes.push(note),
  });
});

/** Слежение за письмом: поставлено, свой ход начат записью `prompt` через секунду. */
function armed(sessionId = 's-01', workId = 'w-1'): { r: SessionRef; id: string } {
  const r = ref(sessionId, workId);
  const id = watch.arm({ ref: r, name: `Agent ${sessionId}`, kind: 'prompt', since: clock });
  advance(1000);
  watch.onPrompt(r, clock);
  return { r, id };
}

describe('reply-watch: события', () => {
  it('RW-04: одно событие активности дважды — один вызов; ключ — turn:<конец>', () => {
    const { r } = armed();
    const end = clock + 500;
    watch.onActivity(r, idle, end);
    watch.onActivity(r, idle, end);
    advance(WATCH_SETTLE_MS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'turn-end', key: `turn:${end}`, turnEndedAt: end });
    watch.onActivity(r, idle, end);
    advance(WATCH_SETTLE_MS);
    expect(events).toHaveLength(1);
  });

  it('RW-04: сессия s-01 двух работ — разные события', () => {
    const a = armed('s-01', 'w-1');
    const b = armed('s-01', 'w-2');
    watch.onActivity(a.r, idle, clock + 1);
    watch.onActivity(b.r, idle, clock + 1);
    advance(WATCH_SETTLE_MS);
    expect(events.map((event) => event.ref.workId).sort()).toEqual(['w-1', 'w-2']);
  });

  it('RW-04: два разрешения в одном ходе — два события «ждёт человека»; повтор того же — нет', () => {
    const { r } = armed();
    const first = new Date(clock + 100).toISOString();
    const second = new Date(clock + 200).toISOString();
    watch.onActivity(r, needOf('permission', first), null);
    watch.onActivity(r, needOf('permission', first), null);
    watch.onActivity(r, needOf('permission', second), null);
    expect(events.map((event) => event.key)).toEqual([`need:permission:${first}`, `need:permission:${second}`]);
    expect(events.every((event) => event.event === 'needs-human')).toBe(true);
  });

  it('RW-05: конец хода и новая работа через секунду — события нет, слежение стоит', () => {
    const { r } = armed();
    watch.onActivity(r, idle, clock + 1);
    advance(1000);
    watch.onActivity(r, idle, null);
    advance(WATCH_SETTLE_MS * 2);
    expect(events).toEqual([]);
    expect(watch.watching(r)).toBe(true);
    watch.onActivity(r, idle, clock + 1);
    advance(WATCH_SETTLE_MS);
    expect(events).toHaveLength(1);
    expect(watch.watching(r)).toBe(false);
  });

  it('RW-06: слежения ставятся по шагам; остановка плана не снимает первые два; ответ до конца плана выдан', () => {
    const one = armed('s-01');
    const two = armed('s-02');
    // Третий шаг упал: слежения не ставилось, первые два на месте.
    expect(watch.refs()).toEqual([one.r, two.r]);
    watch.onActivity(one.r, idle, clock + 1);
    advance(WATCH_SETTLE_MS);
    expect(events.map((event) => event.ref.sessionId)).toEqual(['s-01']);
    expect(watch.watching(two.r)).toBe(true);
  });

  it('RW-07: onClosing через секунду после конца хода — событие сразу, слежение снято', () => {
    const { r } = armed();
    watch.onActivity(r, idle, clock + 1);
    advance(1000);
    watch.onClosing(r);
    expect(events).toHaveLength(1);
    expect(watch.watching(r)).toBe(false);
    advance(WATCH_SETTLE_MS);
    expect(events).toHaveLength(1);
  });

  it('onClosing без готового конца хода — слежение снято молча', () => {
    const { r } = armed();
    watch.onClosing(r);
    expect(events).toEqual([]);
    expect(watch.watching(r)).toBe(false);
  });

  it('RW-20: конец прежнего хода события не даёт; конец хода после onPrompt — даёт', () => {
    const r = ref('s-01');
    const oldEnd = clock - 5000;
    watch.arm({ ref: r, name: 'A', kind: 'prompt', since: clock });
    watch.onActivity(r, idle, oldEnd);
    advance(WATCH_SETTLE_MS);
    expect(events).toEqual([]);
    // Запись prompt, что появилась до постановки, — не свой ход.
    watch.onPrompt(r, clock - WATCH_SETTLE_MS - 1);
    watch.onActivity(r, idle, clock + 500);
    advance(WATCH_SETTLE_MS);
    expect(events).toEqual([]);
    advance(1000);
    watch.onPrompt(r, clock);
    watch.onActivity(r, idle, clock + 200);
    advance(WATCH_SETTLE_MS);
    expect(events).toHaveLength(1);
  });

  it('RW-02: «ждёт человека» → arm resume → «конец хода» на том же слежении', () => {
    const { r, id } = armed();
    const since = new Date(clock + 100).toISOString();
    watch.onActivity(r, needOf('permission', since), null);
    expect(events.map((event) => event.event)).toEqual(['needs-human']);
    advance(2000);
    expect(watch.arm({ ref: r, name: 'Agent s-01', kind: 'resume', since: clock })).toBe(id);
    watch.onActivity(r, idle, clock + 300);
    advance(WATCH_SETTLE_MS);
    expect(events.map((event) => event.event)).toEqual(['needs-human', 'turn-end']);
    expect(watch.watching(r)).toBe(false);
  });

  it('resume на сессии без слежения: граница — since, события привязаны к нему', () => {
    const r = ref('s-09');
    watch.arm({ ref: r, name: 'A', kind: 'resume', since: clock });
    watch.onActivity(r, idle, clock - 100);
    advance(WATCH_SETTLE_MS);
    expect(events).toEqual([]);
    watch.onActivity(r, idle, clock + 100);
    advance(WATCH_SETTLE_MS);
    expect(events).toHaveLength(1);
  });

  it('«ждёт человека» до начала своего хода не выдаётся', () => {
    const r = ref('s-01');
    watch.arm({ ref: r, name: 'A', kind: 'prompt', since: clock });
    watch.onActivity(r, needOf('permission', new Date(clock + 10).toISOString()), null);
    expect(events).toEqual([]);
  });
});

describe('reply-watch: пределы и выключение', () => {
  it('21-е слежение снимает старейшее с заметкой', () => {
    const first = ref('s-00');
    watch.arm({ ref: first, name: 'First', kind: 'prompt', since: clock });
    for (let index = 1; index <= WATCH_MAX_COUNT; index += 1) watch.arm({ ref: ref(`s-${index}`), name: `A${index}`, kind: 'prompt', since: clock });
    expect(watch.refs()).toHaveLength(WATCH_MAX_COUNT);
    expect(watch.watching(first)).toBe(false);
    expect(notes).toEqual(['Stopped waiting for a reply from First']);
  });

  it('через 2 часа слежение снимается с заметкой', () => {
    const { r } = armed();
    advance(WATCH_MAX_MS);
    expect(watch.watching(r)).toBe(false);
    expect(notes).toEqual(['Stopped waiting for a reply from Agent s-01']);
    expect(events).toEqual([]);
  });

  it('clear() снимает все слежения без заметок и событий', () => {
    const one = armed('s-01');
    armed('s-02');
    watch.onActivity(one.r, idle, clock);
    watch.clear();
    advance(WATCH_MAX_MS);
    expect(watch.refs()).toEqual([]);
    expect(notes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('recent() — последние три сессии, новые первыми, без повторов', () => {
    for (const id of ['s-01', 's-02', 's-03', 's-01', 's-04']) watch.arm({ ref: ref(id), name: id, kind: 'prompt', since: clock });
    expect(watch.recent().map((item) => item.ref.sessionId)).toEqual(['s-04', 's-01', 's-03']);
  });
});
