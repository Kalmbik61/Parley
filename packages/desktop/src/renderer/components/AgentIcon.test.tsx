/**
 * Значок провайдера агента (спека окна 2026-09-29, решение 6): у claude и codex — брендовые SVG из
 * `assets/providers/` (`codex-light.svg` — в тёмной теме), у прочих провайдеров — прежний буквенный
 * значок: первая буква id в верхнем регистре, `X`/`C` больше не подменяются.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useProvidersStore, type ProviderInfo } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { AgentIcon } from './AgentIcon.js';

beforeEach(() => useUiStore.setState({ dark: false }));
afterEach(() => {
  cleanup();
  useProvidersStore.setState({ providers: [] });
});

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

describe('AgentIcon — свои провайдеры (спека 3.7)', () => {
  it('custom-* — parley.svg, glm по-прежнему буква G', () => {
    const { container } = render(<AgentIcon provider="custom-kimi" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/parley\.svg$/);
    cleanup();
    const glm = render(<AgentIcon provider="glm" />);
    expect(imageOf(glm.container)).toBeNull();
    expect(glm.container.textContent).toBe('G');
  });

  it('удалённый custom-id (нет в сторе) — всё равно значок Parley', () => {
    const { container } = render(<AgentIcon provider="custom-gone-1" size={20} />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/parley\.svg$/);
  });
});

// Аккаунт подписки (спека подписок 5.9): значок по семейству CLI из `providers.list`, а не по id. Своё место с адресом
// (`endpoint`) выбирает вендорский значок по пресету, а не по `family: 'claude'`.
describe('AgentIcon — аккаунты подписки (спека подписок 5.9)', () => {
  const row = (id: string, custom: Record<string, unknown>, family: 'claude' | null = 'claude'): ProviderInfo =>
    ({ id, label: id, available: true, family, version: null, limits: null, custom }) as ProviderInfo;
  const account = { kind: 'claude-account', link: true, folder: '/x', signedIn: true, signingIn: false };
  const endpoint = { preset: null, baseUrl: 'https://a.example.com', auth: 'bearer', models: {}, contextWindow: null, linkClaude: true, folder: '/x' };

  it('custom-claude-2 с family claude — значок Claude', () => {
    useProvidersStore.setState({ providers: [row('custom-claude-2', account)] });
    const { container } = render(<AgentIcon provider="custom-claude-2" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/claude\.svg$/);
  });

  it('свой провайдер с адресом (в том числе без kind у хоста до подписок) — значок Parley', () => {
    useProvidersStore.setState({ providers: [row('custom-kimi', endpoint), row('custom-glm2', { ...endpoint, kind: 'endpoint' })] });
    const kimi = render(<AgentIcon provider="custom-kimi" />);
    expect(imageOf(kimi.container)?.getAttribute('src')).toMatch(/parley\.svg$/);
    kimi.unmount();
    const other = render(<AgentIcon provider="custom-glm2" />);
    expect(imageOf(other.container)?.getAttribute('src')).toMatch(/parley\.svg$/);
  });

  it.each([undefined, 'endpoint'])('пресет Kimi — официальный знак в обеих темах, независимо от id и версии хоста (%s)', (kind) => {
    useProvidersStore.setState({ providers: [row('custom-work-2', { ...endpoint, kind, preset: 'kimi' })] });
    const { container } = render(<AgentIcon provider="custom-work-2" size={20} label="Kimi" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/kimi\.svg$/);
    expect(imageOf(container)?.getAttribute('alt')).toBe('Kimi');
    expect(imageOf(container)?.getAttribute('width')).toBe('20');
    act(() => useUiStore.setState({ dark: true }));
    expect(imageOf(container)?.getAttribute('src')).toMatch(/kimi-light\.svg$/);
    act(() => useProvidersStore.setState({ providers: [row('custom-work-2', endpoint)] }));
    expect(imageOf(container)?.getAttribute('src')).toMatch(/parley\.svg$/);
  });

  it('custom-* без записи в сторе — значок Parley, как раньше', () => {
    const { container } = render(<AgentIcon provider="custom-claude-2" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/parley\.svg$/);
  });

  it('значок следует за стором на лету: запись появилась — значок сменился', () => {
    const { container } = render(<AgentIcon provider="custom-claude-2" />);
    expect(imageOf(container)?.getAttribute('src')).toMatch(/parley\.svg$/);
    act(() => useProvidersStore.setState({ providers: [row('custom-claude-2', account)] }));
    expect(imageOf(container)?.getAttribute('src')).toMatch(/claude\.svg$/);
  });
});
