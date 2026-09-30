/**
 * Значок провайдера агента (спека окна 2026-09-29, решение 6): у claude и codex — брендовые SVG из
 * `assets/providers/` (`codex-light.svg` — в тёмной теме), у прочих провайдеров — прежний буквенный
 * значок: первая буква id в верхнем регистре, `X`/`C` больше не подменяются.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useUiStore } from '../store/ui.js';
import { AgentIcon } from './AgentIcon.js';

beforeEach(() => useUiStore.setState({ dark: false }));
afterEach(cleanup);

const imageOf = (container: HTMLElement): HTMLImageElement | null => container.querySelector('img');

describe('AgentIcon — брендовые значки (решение 6)', () => {
  it('claude — claude.svg, без буквы', () => {
    const { container } = render(<AgentIcon provider="claude" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/claude\.svg$/);
    expect(container.textContent).toBe('');
  });

  it('codex — codex.svg в светлой теме и codex-light.svg в тёмной, тема переключается на лету', () => {
    const { container } = render(<AgentIcon provider="codex" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/codex\.svg$/);
    act(() => useUiStore.setState({ dark: true }));
    expect(imageOf(container)?.getAttribute('src')).toMatch(/codex-light\.svg$/);
  });

  it('claude одинаков в обеих темах', () => {
    useUiStore.setState({ dark: true });
    const { container } = render(<AgentIcon provider="claude" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/claude\.svg$/);
  });

  it('регистр id не важен: Codex, CLAUDE — тоже брендовые', () => {
    const codex = render(<AgentIcon provider="Codex" />);
    expect(imageOf(codex.container)?.getAttribute('src')).toMatch(/codex\.svg$/);
    codex.unmount();
    const claude = render(<AgentIcon provider="CLAUDE" />);
    expect(imageOf(claude.container)?.getAttribute('src')).toMatch(/claude\.svg$/);
  });

  it('размер — квадрат size на самом img (12 по умолчанию, 14 и 13 в строках), перетаскивать нельзя', () => {
    const small = render(<AgentIcon provider="claude" />);
    expect(imageOf(small.container)?.getAttribute('width')).toBe('12');
    expect(imageOf(small.container)?.getAttribute('height')).toBe('12');
    small.unmount();
    const large = render(<AgentIcon provider="claude" size={14} />);
    expect(imageOf(large.container)?.getAttribute('width')).toBe('14');
    expect(imageOf(large.container)?.getAttribute('draggable')).toBe('false');
  });

  it('подпись — только если её передали: рядом с названием значок декоративный (alt пустой)', () => {
    const plain = render(<AgentIcon provider="claude" />);
    expect(imageOf(plain.container)?.getAttribute('alt')).toBe('');
    plain.unmount();
    const labelled = render(<AgentIcon provider="claude" label="Claude Code" />);
    expect(imageOf(labelled.container)?.getAttribute('alt')).toBe('Claude Code');
  });
});

// Правки ревью куска 2: значок провайдера — `<img>`, и правило приглушения `dimmed.css` (значки .6 у done-карточки,
// .5 у закрытой строки) брало только `svg` и точку состояния — брендовый значок оставался при opacity 1. Правило
// берёт `[data-agent-icon]`: он на обоих видах значка (картинка и буква неизвестного провайдера).
describe('AgentIcon — метка для приглушения dimmed.css', () => {
  it('брендовая картинка несёт data-agent-icon', () => {
    const { container } = render(<AgentIcon provider="claude" />);
    expect(imageOf(container)?.hasAttribute('data-agent-icon')).toBe(true);
  });

  it('буква неизвестного провайдера несёт data-agent-icon', () => {
    const { container } = render(<AgentIcon provider="gemini" />);
    expect(container.querySelector('[data-agent-icon]')?.textContent).toBe('G');
  });
});

describe('AgentIcon — прочие провайдеры: буква (спека 4.6, решение 6)', () => {
  it('gemini → G, значка-картинки нет', () => {
    const { container } = render(<AgentIcon provider="gemini" />);
    expect(container.textContent).toBe('G');
    expect(imageOf(container)).toBeNull();
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
