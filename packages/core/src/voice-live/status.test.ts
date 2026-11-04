import { describe, expect, it } from 'vitest';
import { createAckTracker } from './ack.js';
import { ageWords, clockOf, createStatusNotifier, statusContent, type StatusInput } from './status.js';

const NOON = new Date(2026, 10, 4, 14, 5, 0).getTime();

const input = (patch: Partial<StatusInput> = {}): StatusInput => ({
  requestId: 'req-1',
  text: 'what is waiting for me in the rooms',
  state: 'running',
  stale: false,
  createdAt: NOON - 40_000,
  delegationId: 'd1',
  ...patch,
});

function setup() {
  let now = NOON;
  const clock = { at: 0 };
  const ack = createAckTracker({ now: () => clock.at });
  const sent: Array<{ delegationId: string | null; content: string }> = [];
  let accept = true;
  const notifier = createStatusNotifier({
    now: () => now,
    canAppend: (delegationId, purpose) => ack.canAppend(delegationId, purpose),
    send: (message) => {
      if (!accept) return false;
      sent.push(message);
      return true;
    },
  });
  return {
    notifier,
    ack,
    sent,
    clock,
    setNow: (value: number) => void (now = value),
    refuse: () => void (accept = false),
    allow: () => void (accept = true),
  };
}

describe('statusContent', () => {
  it('называет время снимка, возраст и поручение; id и разметки нет', () => {
    const text = statusContent(input({ text: 'check r-3 and s-12' }), NOON);
    expect(text).toContain('14:05');
    expect(text).toContain('40 seconds');
    expect(text).not.toMatch(/\b[rs]-\d+\b|\[\[/);
  });

  it('очередь и работа звучат по-разному; кавычки в тексте не ломают формулировку', () => {
    expect(statusContent(input({ state: 'queued', text: 'say "hi"' }), NOON)).toContain('waiting in line');
    expect(statusContent(input({ state: 'queued', text: 'say "hi"' }), NOON)).toContain(`"say 'hi'"`);
    expect(statusContent(input({ state: 'running' }), NOON)).toContain('still working');
  });

  it('длинный текст сокращается, пустой заменяется общим словом', () => {
    expect(statusContent(input({ text: 'word '.repeat(80) }), NOON).length).toBeLessThan(220);
    expect(statusContent(input({ text: '' }), NOON)).toContain('the request,');
  });

  it('возраст: секунды, минуты, часы', () => {
    expect(ageWords(1000)).toBe('1 second');
    expect(ageWords(125_000)).toBe('2 minutes');
    expect(ageWords(3_900_000)).toBe('1 hour 5 minutes');
    expect(clockOf(NOON)).toBe('14:05');
  });
});

describe('StatusNotifier', () => {
  it('VA-06: открытый Request получает один статус со временем — модель ответит из него без нового job', () => {
    const { notifier, sent } = setup();
    notifier.observe([input()]);
    notifier.step();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delegationId).toBe('d1');
    expect(sent[0]?.content).toMatch(/14:05.*40 seconds/);
    // повторный опрос того же состояния ничего не шлёт
    notifier.observe([input()]);
    notifier.step();
    expect(sent).toHaveLength(1);
  });

  it('смена состояния — новый статус; терминальное состояние статуса не даёт (итог идёт очередью речи)', () => {
    const { notifier, sent } = setup();
    notifier.observe([input({ state: 'queued' })]);
    notifier.step();
    notifier.observe([input({ state: 'running' })]);
    notifier.step();
    notifier.observe([input({ state: 'completed' })]);
    notifier.step();
    expect(sent.map((message) => message.content.includes('waiting in line'))).toEqual([true, false]);
  });

  it('вытесненный Request статуса не получает, а уже подготовленный отменяется', () => {
    const { notifier, sent, ack } = setup();
    ack.open('other');
    notifier.observe([input({ delegationId: null })]);
    notifier.observe([input({ delegationId: null, stale: true })]);
    ack.modelPlaying(true);
    notifier.step();
    expect(sent).toEqual([]);
  });

  it('правило подтверждений: прогресс своей делегации идёт сразу', () => {
    const { notifier, sent, ack } = setup();
    ack.open('d1');
    notifier.observe([input({ delegationId: 'd1' })]);
    notifier.step();
    expect(sent).toHaveLength(1);
  });

  it('правило подтверждений: статус чужой делегации ждёт подтверждения, но не дольше срока', () => {
    const { notifier, sent, ack, clock } = setup();
    ack.open('d2');
    notifier.observe([input({ requestId: 'req-1', delegationId: 'd1' })]);
    notifier.step();
    expect(sent).toEqual([]);
    clock.at = 2400;
    notifier.step();
    expect(sent).toEqual([]);
    clock.at = 2500;
    notifier.step();
    expect(sent).toHaveLength(1);
  });

  it('правило подтверждений: подтверждение прозвучало — отложенный статус уходит сразу', () => {
    const { notifier, sent, ack } = setup();
    ack.open('d2');
    notifier.observe([input({ delegationId: null })]);
    notifier.step();
    expect(sent).toEqual([]);
    ack.modelPlaying(true);
    notifier.step();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.delegationId).toBeNull();
  });

  it('Live не принял append (канал закрыт): статус остаётся и уходит позже, один раз', () => {
    const { notifier, sent, refuse, allow } = setup();
    refuse();
    notifier.observe([input()]);
    notifier.step();
    expect(sent).toEqual([]);
    allow();
    notifier.step();
    notifier.step();
    expect(sent).toHaveLength(1);
  });

  it('время в статусе берётся на момент отправки', () => {
    const { notifier, sent, ack, clock, setNow } = setup();
    ack.open('d2');
    notifier.observe([input({ delegationId: null })]);
    notifier.step();
    clock.at = 2500;
    setNow(NOON + 2500);
    notifier.step();
    expect(sent[0]?.content).toMatch(/14:05.*43 seconds/);
  });

  it('новая сессия: статусы открытых Request нужны заново', () => {
    const { notifier, sent } = setup();
    notifier.observe([input()]);
    notifier.step();
    notifier.reset();
    notifier.observe([input({ delegationId: null })]);
    notifier.step();
    expect(sent).toHaveLength(2);
  });
});
