/**
 * Оценка высоты строк виртуальной ленты до замера (`FeedList`, `estimateSize`): вызов с рядом миниатюр выше обычной
 * строки. jsdom высот не мерит (все строки «0 px»), поэтому виртуализатор подсматривается: проверяется сама оценка,
 * которую лента ему отдаёт.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { FeedItem, FeedTool } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { ChatEnvContext } from './chat-env.js';
import { FeedList } from './FeedList.js';

const seen = vi.hoisted(() => ({ estimateSize: null as null | ((index: number) => number) }));

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      seen.estimateSize = options.estimateSize as (index: number) => number;
      return actual.useVirtualizer(options);
    },
  };
});

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-01T00:00:00.000Z';
const ROW = 56;
const LINE = 128;

const text: FeedItem = {
  id: 'a',
  at: AT,
  kind: 'text',
  messageId: 'a',
  text: 'hello',
  streaming: false,
};
const shots = (id: string, count: number): FeedTool => ({
  id,
  at: AT,
  kind: 'tool',
  toolUseId: id,
  name: 'mcp__chrome-devtools__take_screenshot',
  input: {},
  status: 'done',
  response: {
    text: '',
    size: 0,
    truncated: false,
    ...(count === 0
      ? {}
      : {
          images: Array.from({ length: count }, (_, at) => ({
            path: `/f/${id}${at}.png`,
            mime: 'image/png',
          })),
        }),
  },
});

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
beforeEach(() => {
  seen.estimateSize = null;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'chat-feed' ? 600 : 0;
    },
  });
});
afterEach(() => {
  cleanup();
  if (originalOffsetHeight !== undefined)
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

describe('FeedList — оценка высоты строк до замера', () => {
  it('вызов с картинками выше обычной строки на ряды миниатюр (по две в строке), прочие строки — 56 px', () => {
    const queued = [{ id: 'q1', text: 'next' }];
    render(
      <ChatEnvContext.Provider value={{ bridge: createFakeBridge(), sessionRef: REF }}>
        <FeedList
          items={[text, shots('one', 1), shots('three', 3), shots('six', 6), shots('none', 0)]}
          queued={queued}
          note={null}
        />
      </ChatEnvContext.Provider>,
    );

    const estimate = seen.estimateSize;
    expect(estimate).not.toBeNull();
    // 0 — текст; 1, 2, 3 — вызовы с 1, 3 и 6 картинками; 4 — вызов без картинок; 5 — серое сообщение очереди; 99 — строки нет.
    expect([0, 1, 2, 3, 4, 5, 99].map((index) => estimate?.(index))).toEqual([
      ROW,
      ROW + LINE,
      ROW + 2 * LINE,
      ROW + 3 * LINE,
      ROW,
      ROW,
      ROW,
    ]);
  });
});
