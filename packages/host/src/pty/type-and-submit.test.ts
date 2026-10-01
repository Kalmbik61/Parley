import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { fakePty } from '../../test/fake-pty.js';
import type { FakePty } from '../../test/fake-pty.js';
import { typeAndSubmit } from './type-and-submit.js';

const ref: SessionRef = { projectPath: '/tmp/project', workId: 'w-01', sessionId: 's-01' };

let pty: FakePty;

beforeEach(() => {
  vi.useFakeTimers();
  pty = fakePty();
});

afterEach(() => {
  vi.useRealTimers();
});

const deps = () => ({ pty: pty.manager, enterDelayMs: 500 });

describe('typeAndSubmit', () => {
  it('submit: false — typed сразу, одна запись', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', false);
    await expect(attempt.done).resolves.toBe('typed');
    expect(pty.writes).toEqual(['текст']);
  });

  it('submit: true без ввода — \\r через 500 мс, submitted', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true);
    expect(pty.writes).toEqual(['текст']);
    await vi.advanceTimersByTimeAsync(499);
    expect(pty.writes).toEqual(['текст']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.writes).toEqual(['текст', '\r']);
  });

  it('событие draft в окне ожидания — input, \\r нет', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true);
    pty.emitDraft(ref);
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('input');
    expect(pty.writes).toEqual(['текст']);
  });

  it('draft другой сессии ввода этой не считается', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true);
    pty.emitDraft({ ...ref, sessionId: 's-02' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
  });

  it('beforeEnter спрашивается перед самым Enter: false — blocked, \\r нет, черновик хоста остаётся (fix-final-b)', async () => {
    let blocked = false;
    const asked: number[] = [];
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, {
      hostDraft: true,
      beforeEnter: () => {
        asked.push(Date.now());
        return !blocked;
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    // Диалог появился за ожидание: до Enter предикат ещё не спрашивали.
    expect(asked).toHaveLength(0);
    blocked = true;
    await vi.advanceTimersByTimeAsync(200);
    await expect(attempt.done).resolves.toBe('blocked');
    expect(asked).toHaveLength(1);
    expect(pty.writes).toEqual(['текст']);
    expect(pty.hostDraft).toBe(true);
  });

  it('beforeEnter true — Enter как обычно', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { beforeEnter: () => true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.writes).toEqual(['текст', '\r']);
  });

  it('смена pid — restarted, \\r нет', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true);
    pty.pid = 101;
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('restarted');
    expect(pty.writes).toEqual(['текст']);
  });

  it('cancel() до Enter — cancelled, \\r нет и позже', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true);
    attempt.cancel();
    await expect(attempt.done).resolves.toBe('cancelled');
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual(['текст']);
  });

  it('hostDraft: черновик хоста ставится после печати и снимается своим Enter', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { hostDraft: true });
    expect(pty.hostDraftCalls).toEqual([true]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.hostDraftCalls).toEqual([true, false]);
  });

  it('hostDraft: при input черновик хоста остаётся', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { hostDraft: true });
    pty.emitDraft(ref);
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('input');
    expect(pty.hostDraftCalls).toEqual([true]);
  });

  it('hostDraft без submit: черновик хоста остаётся', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', false, { hostDraft: true });
    await expect(attempt.done).resolves.toBe('typed');
    expect(pty.hostDraftCalls).toEqual([true]);
  });

  it('без опции hostDraft setHostDraft не зовётся', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true);
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.hostDraftCalls).toEqual([]);
  });

  it('отложенный Enter бросил — done отклонён, а не исключение хоста', async () => {
    const write = pty.manager.write;
    pty.manager.write = (target, data) => {
      if (data === '\r') throw new Error('PTY закрыт');
      write(target, data);
    };
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { hostDraft: true });
    const settled = attempt.done.then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(settled).resolves.toEqual({ error: 'Error: PTY закрыт' });
    // Enter не ушёл — черновик хоста не снимается.
    expect(pty.hostDraftCalls).toEqual([true]);
  });

  it('delayMs перекрывает enterDelayMs: у Codex пауза десятки миллисекунд, а не полсекунды', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { delayMs: 60 });
    await vi.advanceTimersByTimeAsync(59);
    expect(pty.writes).toEqual(['текст']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.writes).toEqual(['текст', '\r']);
  });

  it('submitKey решает клавишу в момент отправки, а не при вставке: Tab занятому агенту (очередь)', async () => {
    let key = '\r';
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { submitKey: () => key });
    // Агент занялся за паузу — Enter вмешался бы в ход, уходит Tab.
    key = '\t';
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.writes).toEqual(['текст', '\t']);
  });

  it('без submitKey клавиша прежняя — Enter', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, { hostDraft: true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.writes).toEqual(['текст', '\r']);
    // Отправка клавишей, какой бы она ни была, снимает черновик хоста: поле после неё пусто.
    expect(pty.hostDraftCalls).toEqual([true, false]);
  });

  it('с Tab черновик хоста снимается так же: сообщение ушло в очередь, поле пусто', async () => {
    const attempt = typeAndSubmit(deps(), ref, 'текст', true, {
      hostDraft: true,
      submitKey: () => '\t',
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
    expect(pty.hostDraftCalls).toEqual([true, false]);
  });

  it('свои таймеры из deps', async () => {
    const setTimer = vi.fn(setTimeout);
    const attempt = typeAndSubmit({ ...deps(), setTimer: setTimer as unknown as typeof setTimeout }, ref, 'x', true);
    expect(setTimer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(attempt.done).resolves.toBe('submitted');
  });
});
