/**
 * `Letter` — тест 5 куска 2.4 плана окна: `<script>` в теле письма показан
 * текстом и не исполняется, блок кода отрисован.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { LetterView } from '../../lib/mail-view.js';
import { Letter } from './Letter.js';

afterEach(cleanup);

function letter(partial: Partial<LetterView>): LetterView {
  return {
    id: 'm-1',
    time: '10:00',
    from: 'S01 (Opus 5.5)',
    to: 'S03 (Codex)',
    kind: 'note',
    text: '',
    unread: false,
    ...partial,
  };
}

describe('Letter (тест 5)', () => {
  it('<script> в теле показан текстом, скрипт не исполняется', () => {
    const { container } = render(
      <Letter letter={letter({ text: 'до <script>alert(1)</script> после' })} onOpenExternal={() => {}} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('блок кода отрисован', () => {
    const { container } = render(
      <Letter letter={letter({ text: '```js\nconsole.log(1)\n```' })} onOpenExternal={() => {}} />,
    );

    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('console.log(1)');
  });
});
