import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SenderAvatar } from './SenderAvatar.js';

afterEach(cleanup);

describe('SenderAvatar — кольцо цвета агента', () => {
  it('агент с известным провайдером — значок с кольцом', () => {
    const { container } = render(<SenderAvatar kind="agent" provider="claude" sessionId="s-5" />);
    expect(container.querySelector('[data-agent-colour="5"]')).toBeTruthy();
  });

  it('удалённая сессия s-N (провайдер null) — без кольца', () => {
    const { container } = render(<SenderAvatar kind="agent" provider={null} sessionId="s-5" />);
    expect(container.querySelector('[data-agent-colour]')).toBeNull();
  });

  it('человек, помощник и система — без кольца', () => {
    for (const props of [
      { kind: 'human' as const, via: null },
      { kind: 'human' as const, via: 'assistant' as const },
      { kind: 'system' as const, via: null },
    ]) {
      const { container } = render(<SenderAvatar {...props} provider={null} sessionId="s-5" />);
      expect(container.querySelector('[data-agent-colour]')).toBeNull();
      cleanup();
    }
  });
});
