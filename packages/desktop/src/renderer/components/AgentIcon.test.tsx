/**
 * Тест 5 куска 1.2 плана: буква провайдера — `claude` → C, `codex` → X, у
 * остальных провайдеров — первая буква id в верхнем регистре (спека 4.6;
 * логотипы вендоров решаются в куске 3.3).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentIcon } from './AgentIcon.js';

afterEach(cleanup);

describe('AgentIcon — тест 5', () => {
  it.each([
    ['claude', 'C'],
    ['codex', 'X'],
    ['gemini', 'G'],
  ] as const)('%s → %s', (provider, letter) => {
    const { container } = render(<AgentIcon provider={provider} />);
    expect(container.textContent).toBe(letter);
  });
});

describe('AgentIcon — раунд исправлений 1 (находки B №2 и №5)', () => {
  it('оверрайд не зависит от регистра: Codex → X, CLAUDE → C', () => {
    const codex = render(<AgentIcon provider="Codex" />);
    expect(codex.container.textContent).toBe('X');
    codex.unmount();

    const claude = render(<AgentIcon provider="CLAUDE" />);
    expect(claude.container.textContent).toBe('C');
  });

  it('провайдер с ведущим символом вне BMP — берёт весь code point, не половину суррогатной пары', () => {
    // "🤖" — суррогатная пара; `charAt(0)` вернул бы одинокий старший
    // суррогат, который рендерится как символ-заглушка, а не как эмодзи.
    const { container } = render(<AgentIcon provider="🤖bot" />);
    expect(container.textContent).toBe('🤖');
  });

  it('пустой provider — безопасный запасной символ, не падает', () => {
    const { container } = render(<AgentIcon provider="" />);
    expect(container.textContent).toBe('?');
  });
});
