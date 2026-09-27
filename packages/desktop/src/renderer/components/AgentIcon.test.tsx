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
