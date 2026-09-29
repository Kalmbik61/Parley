/**
 * `Letter` — тест 5 куска 2.4 плана окна: `<script>` в теле письма показан
 * текстом и не исполняется, блок кода отрисован.
 *
 * Облик Organic (спека окна 2026-09-29, 1.8, «Почта»): карточка до 640px — тег вида, `S03 ревью → you`,
 * время, точка `accent-600` у непрочитанного и текст 14px.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

describe('Letter — карточка Organic (1.8)', () => {
  it('карточка до 640px на фоне окна: радиус 32, отступ 18 20', () => {
    const { container } = render(<Letter letter={letter({ text: 'привет' })} onOpenExternal={() => {}} />);
    const card = container.querySelector('[data-letter-id]') as HTMLElement;
    expect(card.className).toContain('max-w-[640px]');
    expect(card.className).toContain('bg-background');
    expect(card.className).toMatch(/\brounded-xl\b/);
    expect(card.className).toMatch(/\bpy-\[18px\]/);
    expect(card.className).toMatch(/\bpx-5\b/);
  });

  it('тег вида: question — accent, decision — accent-2, note — neutral; слова строчными', () => {
    for (const [kind, cls] of [
      ['question', 'bg-accent-100'],
      ['decision', 'bg-accent-2-100'],
      ['note', 'bg-neutral-100'],
    ] as const) {
      render(<Letter letter={letter({ kind })} onOpenExternal={() => {}} />);
      const tag = screen.getByText(kind);
      expect(tag.className, kind).toContain(cls);
      expect(tag.className, kind).toMatch(/\brounded-full\b/);
      cleanup();
    }
  });

  it('мета: отправитель вес 600 основным цветом → адресат, время; текст письма 14px', () => {
    const { container } = render(<Letter letter={letter({ from: 'S03 ревью', to: 'You', time: '10:05', text: 'текст' })} onOpenExternal={() => {}} />);
    const sender = screen.getByText('S03 ревью');
    expect(sender.className).toContain('font-semibold');
    expect(sender.className).toContain('text-foreground');
    expect(container.textContent).toContain('→ You');
    expect(container.textContent).toContain('10:05');
    expect(container.querySelector('[data-letter-body]')?.className).toContain('text-sm');
  });

  it('непрочитанное — точка 8px accent-600 с подписью unread; прочитанное — без точки и без прежнего ▤', () => {
    const { container, rerender } = render(<Letter letter={letter({ unread: true })} onOpenExternal={() => {}} />);
    const dot = screen.getByLabelText('unread');
    expect(dot.className).toContain('size-2');
    expect(dot.className).toContain('rounded-full');
    expect(dot.className).toContain('bg-accent-600');
    expect(container.textContent).not.toContain('▤');
    rerender(<Letter letter={letter({ unread: false })} onOpenExternal={() => {}} />);
    expect(screen.queryByLabelText('unread')).toBeNull();
  });

  it('длинное имя отправителя и адресатов переносится, а не выталкивает карточку', () => {
    const { container } = render(<Letter letter={letter({ from: 'я'.repeat(120), to: 'x'.repeat(120) })} onOpenExternal={() => {}} />);
    const card = container.querySelector('[data-letter-id]') as HTMLElement;
    expect(card.className).toContain('min-w-0');
    expect(container.querySelector('[data-letter-meta]')?.className).toContain('flex-wrap');
    expect(container.querySelector('[data-letter-body]')?.className).toContain('break-words');
  });
});
