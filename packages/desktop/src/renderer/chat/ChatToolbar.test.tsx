// packages/desktop/src/renderer/chat/ChatToolbar.test.tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatToolbar } from './ChatToolbar.js';

afterEach(cleanup);

describe('ChatToolbar — кнопка микрофона вида Terminal (спека 3.2)', () => {
  it('micTargetId — кнопка микрофона в тулбаре; без него — нет', () => {
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="claude" micTargetId="terminal:x" />);
    expect(screen.getByTestId('mic').dataset.target).toBe('terminal:x');
    rerender(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="claude" />);
    expect(screen.queryByTestId('mic')).toBeNull();
  });
});

describe('ChatToolbar — расход токенов сессии (спека расхода токенов, 3.4)', () => {
  it('metrics — значок в тулбаре; без них — нет', () => {
    const metrics = { tokensIn: 10, tokensOut: 2, durationMs: null, unread: 0, subagents: 0, model: null };
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={metrics} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('↑10 ↓2');
    rerender(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={null} />);
    expect(screen.queryByTestId('chat-usage-chip')).toBeNull();
  });
});
