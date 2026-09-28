/**
 * Отправка окна агенту (кусок 5.4, спека 8.6): исход `pty.send`, тост по таблице 8.6 и его кнопки.
 * Тосты — подменённый `toast` sonner: кнопки берутся из `action` и `cancel` вызова.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { SendResult, SessionRef } from '@harnas/protocol';
import type { WorkSession } from '@harnas/core';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import { canResume, sendToAgent, sendToast, sendWithToast, type SendOutcome, type SendWithToastDeps } from './send.js';

vi.mock('sonner', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast: fn };
});

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-02' };
const ok = (inserted: boolean, submitted: boolean, reason: SendResult['reason']): SendResult => ({ inserted, submitted, reason });

describe('sendToast (тест 4): таблица 8.6', () => {
  const rows: Array<[string, SendOutcome, boolean, { text: string; actions: string[]; error: boolean } | null]> = [
    ['submitted', ok(true, true, null), false, { text: 'Sent to S02', actions: [], error: false }],
    ['submit: false, reason: null', ok(true, false, null), false, null],
    ['draft', ok(true, false, 'draft'), false, { text: 'Inserted into S02 without Enter — your draft is in the input', actions: [], error: false }],
    ['input', ok(true, false, 'input'), false, { text: 'Inserted into S02 without Enter — you were typing in the terminal', actions: [], error: false }],
    ['restarted', ok(true, false, 'restarted'), false, { text: 'Inserted into S02 without Enter — the session restarted', actions: [], error: false }],
    [
      'blocked-before-enter (fix-final-b)',
      ok(true, false, 'blocked-before-enter'),
      false,
      { text: 'Inserted into S02 without Enter — S02 is waiting for your answer in the terminal', actions: ['open'], error: false },
    ],
    ['blocked', ok(false, false, 'blocked'), false, { text: 'S02 is waiting for your answer — text not inserted', actions: ['copy', 'open'], error: true }],
    ['busy', ok(false, false, 'busy'), false, { text: 'S02 is busy with another message — retry in a second', actions: ['retry'], error: true }],
    ['no-paste-mode', ok(false, false, 'no-paste-mode'), false, { text: "S02 doesn't accept multi-line paste", actions: ['copy'], error: true }],
    ['not_found, resumable', { error: 'not_found', message: 'm' }, true, { text: "S02 isn't running", actions: ['resume'], error: true }],
    ['not_found, не resumable', { error: 'not_found', message: 'm' }, false, { text: "S02 isn't running", actions: [], error: true }],
    ['failed', { error: 'failed', message: 'm' }, true, { text: "Couldn't send to agent: failed.", actions: [], error: true }],
  ];
  for (const [name, outcome, resumable, expected] of rows) {
    it(name, () => {
      expect(sendToast(outcome, 'S02', resumable)).toEqual(expected);
    });
  }
});

describe('canResume', () => {
  const cases: Array<[string, Partial<WorkSession>, boolean]> = [
    ['sleeping без итога (exited)', { lifecycle: 'sleeping' }, true],
    ['sleeping, done', { lifecycle: 'sleeping', result: 'done' }, true],
    ['sleeping, failed', { lifecycle: 'sleeping', result: 'failed' }, true],
    ['active', { lifecycle: 'active' }, false],
    ['pending', { lifecycle: 'pending' }, false],
    ['closed', { lifecycle: 'closed' }, false],
    ['closed, done', { lifecycle: 'closed', result: 'done' }, false],
  ];
  for (const [name, patch, expected] of cases) {
    it(name, () => {
      expect(canResume(makeSession('s-02', 'x', patch))).toBe(expected);
    });
  }
});

describe('sendToAgent (тест 7)', () => {
  let bridge: FakeBridge;
  beforeEach(() => {
    bridge = createFakeBridge();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('успех — SendResult хоста, вызов с ref, text, submit', async () => {
    bridge.setHandler('pty.send', () => ok(true, false, null));
    expect(await sendToAgent(bridge, ref, 'x', false)).toEqual(ok(true, false, null));
    expect(bridge.calls).toEqual([{ method: 'pty.send', params: { ref, text: 'x', submit: false } }]);
  });

  it('отказ моста с not_found (encodeIpcError) → { error: not_found }', async () => {
    bridge.setHandler('pty.send', () => {
      throw encodeIpcError({ code: 'not_found', message: 'сессия не запущена' });
    });
    expect(await sendToAgent(bridge, ref, 'x', true)).toEqual({ error: 'not_found', message: 'сессия не запущена' });
  });

  it('прочая ошибка → failed', async () => {
    bridge.setHandler('pty.send', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'пустой текст' });
    });
    expect(await sendToAgent(bridge, ref, 'x', true)).toEqual({ error: 'failed', message: 'пустой текст' });
    bridge.setHandler('pty.send', () => {
      throw new Error('boom');
    });
    expect(await sendToAgent(bridge, ref, 'x', true)).toEqual({ error: 'failed', message: 'boom' });
  });
});

interface Button {
  label: string;
  onClick: (event: unknown) => void;
}

/** Последний тост и его кнопки: `action` и `cancel` вызова sonner. */
function lastToast(): { kind: 'toast' | 'error'; text: string; buttons: Button[] } {
  const all = [
    ...vi.mocked(toast).mock.calls.map((call, index) => ({ kind: 'toast' as const, call, order: vi.mocked(toast).mock.invocationCallOrder[index] ?? 0 })),
    ...vi.mocked(toast.error).mock.calls.map((call, index) => ({
      kind: 'error' as const,
      call,
      order: vi.mocked(toast.error).mock.invocationCallOrder[index] ?? 0,
    })),
  ].sort((a, b) => a.order - b.order);
  const last = all.at(-1);
  if (last === undefined) throw new Error('тоста нет');
  const options = (last.call[1] ?? {}) as { action?: Button; cancel?: Button };
  const buttons = [options.action, options.cancel].filter((button): button is Button => button !== undefined);
  return { kind: last.kind, text: String(last.call[0]), buttons };
}

function button(label: string): Button {
  const found = lastToast().buttons.find((item) => item.label === label);
  if (found === undefined) throw new Error(`нет кнопки ${label}`);
  return found;
}

describe('sendWithToast (тест 8)', () => {
  let bridge: FakeBridge;
  let session: WorkSession | null;
  let deps: SendWithToastDeps & { openSession: ReturnType<typeof vi.fn>; onOutcome: ReturnType<typeof vi.fn> };
  const writeText = vi.fn((text: string) => Promise.resolve(void text));

  beforeEach(() => {
    vi.mocked(toast).mockClear();
    vi.mocked(toast.error).mockClear();
    writeText.mockClear();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge = createFakeBridge();
    session = makeSession('s-02', 'x', { lifecycle: 'sleeping' });
    deps = { bridge, session: () => session, openSession: vi.fn(), onOutcome: vi.fn() };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('успех submit: false — тоста нет, исход в onOutcome и в ответе', async () => {
    bridge.setHandler('pty.send', () => ok(true, false, null));
    expect(await sendWithToast(deps, ref, 'p ', false)).toEqual(ok(true, false, null));
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(deps.onOutcome.mock.calls).toEqual([[ok(true, false, null)]]);
  });

  it('blocked → тост с Copy и Open S02: Copy кладёт исходный текст в буфер, Open зовёт openSession(ref)', async () => {
    bridge.setHandler('pty.send', () => ok(false, false, 'blocked'));
    await sendWithToast(deps, ref, 'исходный\nтекст', true);
    expect(lastToast().text).toBe('S02 is waiting for your answer — text not inserted');
    expect(lastToast().buttons.map((item) => item.label).sort()).toEqual(['Copy', 'Open S02']);
    button('Copy').onClick({});
    expect(writeText).toHaveBeenCalledWith('исходный\nтекст');
    button('Open S02').onClick({});
    expect(deps.openSession).toHaveBeenCalledWith(ref);
    // Вставки не было и нет: Copy и Open агенту ничего не шлют.
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toHaveLength(1);
  });

  it('busy → Retry повторяет вызов; onOutcome получает busy, затем submitted; ответ — исход первой попытки', async () => {
    const answers = [ok(false, false, 'busy'), ok(true, true, null)];
    bridge.setHandler('pty.send', () => answers.shift() ?? ok(true, true, null));
    expect(await sendWithToast(deps, ref, 'hi', true)).toEqual(ok(false, false, 'busy'));
    expect(lastToast().buttons.map((item) => item.label)).toEqual(['Retry']);
    button('Retry').onClick({});
    await vi.waitFor(() => expect(deps.onOutcome).toHaveBeenCalledTimes(2));
    expect(deps.onOutcome.mock.calls).toEqual([[ok(false, false, 'busy')], [ok(true, true, null)]]);
    expect(bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params)).toEqual([
      { ref, text: 'hi', submit: true },
      { ref, text: 'hi', submit: true },
    ]);
    expect(lastToast().text).toBe('Sent to S02');
  });

  it('toastId — id тоста sonner; своя retry заменяет повтор тем же вызовом (раунд fix-8.4b, п. 3)', async () => {
    bridge.setHandler('pty.send', () => ok(false, false, 'busy'));
    const retry = vi.fn();
    await sendWithToast({ ...deps, toastId: 'notes-send:x', retry }, ref, 'hi', true);
    expect((vi.mocked(toast.error).mock.calls.at(-1)?.[1] as { id?: string } | undefined)?.id).toBe('notes-send:x');
    button('Retry').onClick({});
    expect(retry).toHaveBeenCalledTimes(1);
    expect(bridge.calls.filter((call) => call.method === 'pty.send')).toHaveLength(1);
  });

  it('not_found у сессии exited → Resume зовёт sessions.resume', async () => {
    bridge.setHandler('pty.send', () => {
      throw encodeIpcError({ code: 'not_found', message: 'm' });
    });
    bridge.setHandler('sessions.resume', () => ({ ok: true }) as never);
    await sendWithToast(deps, ref, 'hi', true);
    expect(lastToast()).toMatchObject({ kind: 'error', text: "S02 isn't running" });
    button('Resume').onClick({});
    expect(bridge.calls.filter((call) => call.method === 'sessions.resume').map((call) => call.params)).toEqual([{ ref }]);
  });

  it('not_found у закрытой сессии — кнопки Resume нет', async () => {
    session = makeSession('s-02', 'x', { lifecycle: 'closed' });
    bridge.setHandler('pty.send', () => {
      throw encodeIpcError({ code: 'not_found', message: 'm' });
    });
    await sendWithToast(deps, ref, 'hi', true);
    expect(lastToast().buttons).toEqual([]);
  });

  it('not_found, а сессии нет в снимке — кнопки Resume нет', async () => {
    session = null;
    bridge.setHandler('pty.send', () => {
      throw encodeIpcError({ code: 'not_found', message: 'm' });
    });
    await sendWithToast(deps, ref, 'hi', true);
    expect(lastToast().buttons).toEqual([]);
  });

  it('ошибка вызова — Couldn’t send to agent: failed., без кнопок, сообщение в консоль', async () => {
    bridge.setHandler('pty.send', () => {
      throw new Error('сокет закрыт');
    });
    await sendWithToast(deps, ref, 'hi', true);
    expect(lastToast()).toEqual({ kind: 'error', text: "Couldn't send to agent: failed.", buttons: [] });
    expect(console.warn).toHaveBeenCalled();
  });
});
