/** Подсветка поиска: без CSS Custom Highlight API ничего не делает; с ним — все диапазоны и текущий. */

import { afterEach, describe, expect, it } from 'vitest';
import { applyFindHighlights, clearFindHighlights } from './highlight.js';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const g = globalThis as unknown as { CSS?: unknown; Highlight?: unknown };
const original = { css: g.CSS, highlight: g.Highlight };

afterEach(() => {
  g.CSS = original.css;
  g.Highlight = original.highlight;
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function stub(): Map<string, unknown> {
  const registry = new Map<string, unknown>();
  g.CSS = { highlights: registry };
  g.Highlight = FakeHighlight;
  return registry;
}

const rows = `
  <div data-feed-id="a"><p>Needle one and needle two</p></div>
  <div data-feed-id="b"><p>another NEEDLE</p><span data-tool-summary>needle in summary</span><div hidden>needle hidden</div></div>`;

describe('applyFindHighlights', () => {
  it('без CSS.highlights ничего не делает и не бросает', () => {
    g.CSS = undefined;
    g.Highlight = undefined;
    expect(() => applyFindHighlights(mount(rows), 'needle', null)).not.toThrow();
    expect(() => clearFindHighlights()).not.toThrow();
  });

  it('регистрирует все вхождения и текущее; сводку вызова и скрытое не берёт', () => {
    const registry = stub();
    applyFindHighlights(mount(rows), 'needle', { itemId: 'b', nth: 0 });
    expect((registry.get('chat-find') as FakeHighlight).ranges).toHaveLength(3);
    const active = (registry.get('chat-find-active') as FakeHighlight).ranges;
    expect(active).toHaveLength(1);
    expect(active[0]!.toString()).toBe('NEEDLE');
  });

  it('номер дальше найденных упирается в последнее вхождение строки', () => {
    const registry = stub();
    applyFindHighlights(mount(rows), 'needle', { itemId: 'a', nth: 5 });
    expect((registry.get('chat-find-active') as FakeHighlight).ranges[0]!.toString()).toBe('needle');
    expect(((registry.get('chat-find-active') as FakeHighlight).ranges[0]!.startContainer as Text).data).toContain('needle two');
  });

  it('пустой запрос и «ничего не нашли» снимают подсветку', () => {
    const registry = stub();
    const root = mount(rows);
    applyFindHighlights(root, 'needle', null);
    expect(registry.has('chat-find')).toBe(true);
    expect(registry.has('chat-find-active')).toBe(false);
    applyFindHighlights(root, 'zzz', null);
    expect(registry.size).toBe(0);
    applyFindHighlights(root, 'needle', null);
    clearFindHighlights();
    expect(registry.size).toBe(0);
  });
});
