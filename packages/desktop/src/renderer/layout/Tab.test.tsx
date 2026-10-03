/**
 * Тесты 2, 3, 11 куска 2.4: активная вкладка (`data-active`), крестик/средняя кнопка закрывают
 * вкладку, «Закрыть остальные»/«Закрыть справа» — одним вызовом `requestCloseTabs`.
 *
 * Облик Organic (спека окна 2026-09-29, 1.1): вкладка — пилюля 28px; активная — фон `neutral-100`,
 * `shadow-sm`, вес 600, крестик 18×18 (значок 10); у неактивных крестик появляется при наведении
 * или фокусе; подкраска `blocked` — `accent-200`, `unseen` — `accent-2-200`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GroupNode, TabSpec } from '../../shared/layout-types.js';
import { usePaletteStore } from '../palette/store.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { Tab } from './Tab.js';
import type { TabMeta } from './tab-meta.js';

const WORK_KEY = '/tmp/p w';

function tab(id: string): TabSpec {
  return { kind: 'terminal', id, sessionId: id };
}

function meta(title: string): TabMeta {
  return { title, icon: 'terminal', session: null, unread: false, needsYou: false, tint: null, dirty: false, favicon: null };
}

function setLayoutWithGroup(group: GroupNode): void {
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root: group, activeGroupId: group.id, closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

function remainingIds(): string[] {
  const root = useLayoutStore.getState().layouts[WORK_KEY]?.root;
  return root?.type === 'group' ? root.tabs.map((t) => t.id) : [];
}

afterEach(() => {
  cleanup();
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

describe('Tab — тест 2', () => {
  it('активная вкладка — пилюля: data-active="true", фон neutral-100, shadow-sm, вес 600, справа 5px, без нижней полосы', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive />);
    const el = screen.getByRole('tab');
    expect(el.getAttribute('data-active')).toBe('true');
    expect(el.className).toMatch(/\bh-7\b/);
    expect(el.className).toMatch(/\brounded-full\b/);
    expect(el.className).toMatch(/\bbg-neutral-100\b/);
    expect(el.className).toMatch(/\bshadow-sm\b/);
    expect(el.className).toMatch(/\bfont-semibold\b/);
    expect(el.className).toContain('pr-[5px]');
    expect(el.style.borderBottom).toBe('');
    expect(el.className).not.toMatch(/\bborder-r\b/);
  });

  it('неактивная вкладка: data-active="false", прозрачная, справа 11px, hover text 7%', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />);
    const el = screen.getByRole('tab');
    expect(el.getAttribute('data-active')).toBe('false');
    expect(el.className).toMatch(/\brounded-full\b/);
    expect(el.className).not.toMatch(/\bbg-neutral-100\b/);
    expect(el.className).not.toMatch(/\bshadow-sm\b/);
    expect(el.className).not.toMatch(/\bfont-semibold\b/);
    expect(el.className).toContain('pr-[11px]');
    expect(el.className).toContain('hover:bg-foreground/7');
    expect(el.style.borderBottom).toBe('');
  });

  it('размеры пилюли: до 200px, не уже 72px, зазор 7, 12px; заголовок с многоточием, а не за краем', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A' + 'я'.repeat(60))} dot={null} isActive />);
    const el = screen.getByRole('tab');
    expect(el.className).toContain('w-full');
    expect(el.className).toContain('gap-[7px]');
    expect(el.className).toMatch(/\btext-xs\b/);
    expect(el.querySelector('span.truncate')?.className).toContain('min-w-0');
    expect(el.className).not.toContain('max-w-40');
  });

  it('крестик зовёт requestCloseTabs с id вкладки — она закрыта', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive />);
    fireEvent.click(screen.getByLabelText('Close'));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['b']));
  });

  it('средняя кнопка (auxclick) тоже закрывает вкладку', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive />);
    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['b']));
  });
});

describe('Tab — тест 3', () => {
  it('«Закрыть остальные» — один вызов requestCloseTabs, остаётся текущая', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'b' };
    setLayoutWithGroup(group);
    const spy = vi.spyOn(useLayoutStore.getState(), 'requestCloseTabs');

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    fireEvent.click(screen.getByText('Close others'));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['b']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WORK_KEY, ['a', 'c']);
  });

  it('«Закрыть справа» — остаются вкладки слева и текущая', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'b' };
    setLayoutWithGroup(group);
    const spy = vi.spyOn(useLayoutStore.getState(), 'requestCloseTabs');

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    fireEvent.click(screen.getByText('Close to the right'));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['a', 'b']));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WORK_KEY, ['c']);
  });
});

describe('Tab — тест 11', () => {
  it('крестик 18×18 со значком 10 закрывает фоновую вкладку без её активации', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(
      <Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />,
    );
    const close = screen.getByLabelText('Close');
    expect(close.className).toContain('size-[18px]');
    expect(close.className).toContain('rounded-full');
    expect(close.querySelector('svg')?.classList.contains('size-2.5')).toBe(true);
    fireEvent.click(close);

    await vi.waitFor(() => expect(remainingIds()).toEqual(['a']));
    expect(useLayoutStore.getState().layouts[WORK_KEY]?.root).toMatchObject({ activeTabId: 'a' });
  });

  it('нажатие крестика не начинает перетаскивание, Enter/Space не активируют вкладку', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    const pointerDown = vi.fn();
    const keyDown = vi.fn();
    render(
      <div onPointerDown={pointerDown} onKeyDown={keyDown}>
        <Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />
      </div>,
    );
    const close = screen.getByLabelText('Close');
    fireEvent.pointerDown(close);
    fireEvent.keyDown(close, { key: 'Enter' });
    fireEvent.keyDown(close, { key: ' ' });

    expect(pointerDown).not.toHaveBeenCalled();
    expect(keyDown).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().layouts[WORK_KEY]?.root).toMatchObject({ activeTabId: 'a' });
  });

  it('неактивную вкладку по-прежнему закрывает средняя кнопка (auxclick)', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />);
    fireEvent(screen.getByRole('tab'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));

    await vi.waitFor(() => expect(remainingIds()).toEqual(['a']));
  });
});

describe('Tab — раунд исправлений 1: доступность (ревью A, Important №2)', () => {
  it('активная — aria-selected="true", tabIndex 0; неактивная — "false", -1 (roving tabindex)', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={null} isActive />);
    const active = screen.getByRole('tab');
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.tabIndex).toBe(0);
    cleanup();

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />);
    const inactive = screen.getByRole('tab');
    expect(inactive.getAttribute('aria-selected')).toBe('false');
    expect(inactive.tabIndex).toBe(-1);
  });

  it('Enter на неактивной вкладке фокусирует её (как клик)', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />);
    fireEvent.keyDown(screen.getByRole('tab'), { key: 'Enter' });

    await vi.waitFor(() => expect(useLayoutStore.getState().layouts[WORK_KEY]?.root).toMatchObject({ activeTabId: 'b' }));
  });

  it('Пробел на неактивной вкладке тоже фокусирует её', async () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);

    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />);
    fireEvent.keyDown(screen.getByRole('tab'), { key: ' ' });

    await vi.waitFor(() => expect(useLayoutStore.getState().layouts[WORK_KEY]?.root).toMatchObject({ activeTabId: 'b' }));
  });
});

// Кусок 4.2 (спека 7.3): отметки вкладки — data-unread и значок вопроса вместо точки.
describe('Tab — отметки внимания (кусок 4.2)', () => {
  it('needsYou: data-unread="true", подкраска accent-200 (и на hover) и значок вопроса вместо точки done', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    render(
      <Tab
        workKey={WORK_KEY}
        group={group}
        tab={tab('b')}
        meta={{ ...meta('B'), unread: true, needsYou: true, tint: 'accent' }}
        dot={{ state: 'done', lifecycle: 'active' }}
        isActive={false}
       
      />,
    );
    const el = screen.getByRole('tab');
    expect(el.getAttribute('data-unread')).toBe('true');
    expect(el.className).toContain('bg-accent-200');
    expect(el.className).toContain('hover:bg-accent-200');
    expect(el.className).not.toContain('amber');
    expect(el.querySelector('[data-testid="agent-state-dot"]')?.getAttribute('data-state')).toBe('blocked');
  });

  it('unseen: подкраска accent-2-200; без подкраски — прозрачная вкладка', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a'), tab('b')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={{ ...meta('B'), unread: true, tint: 'accent-2' }} dot={null} isActive={false} />);
    expect(screen.getByRole('tab').className).toContain('bg-accent-2-200');
    expect(screen.getByRole('tab').className).toContain('hover:bg-accent-2-200');
    cleanup();
    render(<Tab workKey={WORK_KEY} group={group} tab={tab('b')} meta={meta('B')} dot={null} isActive={false} />);
    expect(screen.getByRole('tab').className).not.toMatch(/bg-accent(-2)?-200/);
  });

  it('подкраска бьёт фон активной вкладки: активная с needsYou — accent-200, а не neutral-100', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={{ ...meta('A'), unread: true, needsYou: true, tint: 'accent' }} dot={null} isActive />);
    const el = screen.getByRole('tab');
    expect(el.className).toContain('bg-accent-200');
    expect(el.className).not.toContain('bg-neutral-100');
    expect(el.className).toContain('shadow-sm');
  });

  it('у вкладки терминала — только значок состояния, значка провайдера нет (снимки handoff)', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    render(
      <Tab
        workKey={WORK_KEY}
        group={group}
        tab={tab('a')}
        meta={{ ...meta('A'), session: makeSession('a', 'x') }}
        dot={{ state: 'working', lifecycle: 'active' }}
        isActive
      />,
    );
    const el = screen.getByRole('tab');
    expect(el.querySelector('img')).toBeNull();
    // Коробка значка состояния — 12px (`size-3`), а не прежние 10 у вкладки.
    expect(el.querySelector('[data-testid="agent-state-dot"]')?.classList.contains('size-3')).toBe(true);
  });

  it('значки вкладок других видов — 12px: почта, комната, дифф', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    for (const icon of ['mail', 'room', 'diff'] as const) {
      render(<Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={{ ...meta('A'), icon }} dot={null} isActive />);
      expect(screen.getByRole('tab').querySelector('svg')?.classList.contains('size-3'), icon).toBe(true);
      cleanup();
    }
  });

  it('без отметок — data-unread="false", точка как есть', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a')], activeTabId: 'a' };
    setLayoutWithGroup(group);
    render(
      <Tab workKey={WORK_KEY} group={group} tab={tab('a')} meta={meta('A')} dot={{ state: 'done', lifecycle: 'active' }} isActive />,
    );
    const el = screen.getByRole('tab');
    expect(el.getAttribute('data-unread')).toBe('false');
    expect(el.querySelector('[data-testid="agent-state-dot"]')?.getAttribute('data-state')).toBe('done');
  });
});

describe('Tab — «Split right/down» (кусок 6.2)', () => {
  it('группа вкладки становится активной, палитра открывается в режиме разделения', () => {
    const g1: GroupNode = { type: 'group', id: 'g1', tabs: [tab('a')], activeTabId: 'a' };
    const g2: GroupNode = { type: 'group', id: 'g2', tabs: [tab('b')], activeTabId: 'b' };
    useLayoutStore.setState({
      activeWorkKey: WORK_KEY,
      layouts: { [WORK_KEY]: { root: { type: 'split', id: 's1', direction: 'row', ratio: 0.5, children: [g1, g2] }, activeGroupId: 'g2', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    usePaletteStore.setState({ open: false, mode: 'default', query: '' });

    render(<Tab workKey={WORK_KEY} group={g1} tab={tab('a')} meta={meta('A')} dot={null} isActive />);
    fireEvent.contextMenu(screen.getByRole('tab'));
    fireEvent.click(screen.getByText('Split down'));

    expect(useLayoutStore.getState().layouts[WORK_KEY]?.activeGroupId).toBe('g1');
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'splitDown' });
  });
});

describe('Tab — вкладка файла (тест 9 куска 7.3a)', () => {
  const LONG = `${'f'.repeat(252)}.md`;
  const fileTab = (path: string): TabSpec => ({ kind: 'file', id: `file:p:${path}`, root: { kind: 'project' }, path });
  const fileMeta = (title: string, dirty: boolean): TabMeta => ({ ...meta(title), icon: 'file', dirty });

  it('точка «не сохранён» по meta.dirty; значок по виду файла; полный путь — в title', () => {
    const t = fileTab(`docs/${LONG}`);
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [t], activeTabId: t.id };
    setLayoutWithGroup(group);
    const { rerender } = render(<Tab workKey={WORK_KEY} group={group} tab={t} meta={fileMeta('x.md', true)} dot={null} isActive />);
    const el = screen.getByRole('tab');
    expect(el.querySelector('[data-dirty-dot]')).not.toBeNull();
    expect(el.querySelector('[data-file-kind]')?.getAttribute('data-file-kind')).toBe('markdown');
    // Раунд fix-live, D5: в подсказке всегда видно, из какого корня файл.
    expect(el.querySelector(`[title="docs/${LONG} · Project"]`)).not.toBeNull();

    rerender(<Tab workKey={WORK_KEY} group={group} tab={t} meta={fileMeta('x.md', false)} dot={null} isActive />);
    expect(screen.getByRole('tab').querySelector('[data-dirty-dot]')).toBeNull();
  });
});

describe('Tab — favicon вкладки браузера (тест 11 куска 9.2a)', () => {
  const browserTab: TabSpec = { kind: 'browser', id: 'browser:abc123', url: `https://example.com/${'a'.repeat(200)}` };
  const browserMeta = (favicon: string | null): TabMeta => ({ ...meta('Example'), icon: 'browser', favicon });

  it('favicon есть — <img> с data:, без него — значок Globe; адрес целиком в title', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [browserTab], activeTabId: browserTab.id };
    setLayoutWithGroup(group);
    const { rerender } = render(
      <Tab workKey={WORK_KEY} group={group} tab={browserTab} meta={browserMeta('data:image/png;base64,AA==')} dot={null} isActive />,
    );
    const element = screen.getByRole('tab');
    expect(element.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(element.querySelector('svg')?.classList.contains('lucide-globe')).not.toBe(true);
    expect(screen.getByText('Example').getAttribute('title')).toBe(browserTab.kind === 'browser' ? browserTab.url : '');

    rerender(<Tab workKey={WORK_KEY} group={group} tab={browserTab} meta={browserMeta(null)} dot={null} isActive />);
    expect(screen.getByRole('tab').querySelector('img')).toBeNull();
    expect(screen.getByRole('tab').querySelector('svg.lucide-globe')).not.toBeNull();
  });
});
