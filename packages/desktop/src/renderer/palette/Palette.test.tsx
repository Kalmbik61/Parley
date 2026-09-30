/**
 * Тест 6 куска 6.2 (спека 9.3–9.4): палитра ⌘J — выбор строки, ⌘Enter, ⌘1–9, «Create
 * workspace …», фокус после закрытия и рамка: выбор гасит нажатие, в pty ничего не уходит.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups, openTab, splitGroup } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { Palette } from './Palette.js';
import { usePaletteStore } from './store.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let bridge: FakeBridge;
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

function keyOf(entry: WorkEntry): string {
  return workKey(entry.projectPath, entry.map.work.id);
}

function term(sessionId: string) {
  return { kind: 'terminal' as const, id: tabId.terminal(sessionId), sessionId };
}

/** Работы в сторе, первая — активна и гидрирована с раскладкой `layout`. */
function setup(works: WorkEntry[], layout = emptyLayout()): void {
  useWorksStore.setState({ entries: works, branches: {}, loading: false, error: null });
  const first = works[0];
  if (first === undefined) return;
  const key = keyOf(first);
  const hydrated = Object.fromEntries(works.map((entry) => [keyOf(entry), true as const]));
  const layouts = Object.fromEntries(works.map((entry) => [keyOf(entry), emptyLayout()]));
  useLayoutStore.setState({ activeWorkKey: key, layouts: { ...layouts, [key]: layout }, hydrated });
}

function renderPalette(): void {
  render(<Palette bridge={bridge} run={() => {}} />);
}

function input(): HTMLElement {
  return screen.getByRole('combobox');
}

function selectedOption(): HTMLElement | undefined {
  return screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true');
}

async function type(value: string): Promise<void> {
  fireEvent.change(input(), { target: { value } });
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  bridge = createFakeBridge();
  vi.mocked(toast).mockClear();
  usePaletteStore.setState({ open: false, mode: 'default', query: '' });
  useActivityStore.setState({ byRef: {} });
  useSidebarSectionsStore.setState({ sections: [], attention: {}, entries: null });
  useUiStore.setState({
    dialogs: {
      newWork: { open: false, projectPath: null, title: '' },
      newSession: { open: false, work: null, room: false },
      settings: false,
      mergeRoom: null,
      restartHost: false,
    },
  });
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rectSpy?.mockRestore();
  rectSpy = null;
});

function mockNonZeroRects(): void {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('Palette (тест 6)', () => {
  it('выделенная строка — токены --palette-selected*, без прежних bg-accent и смеси 13 % (кусок 6.3, ревью 6.2-B)', async () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'план')] });
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('S01');

    const row = selectedOption();
    expect(row?.className).toContain('data-[selected=true]:bg-palette-selected');
    expect(row?.className).toContain('[&[data-selected=true]_.text-muted-foreground]:text-palette-selected-muted');
    // Край выделения (раунд main-r2, п. 3): светлая заливка сама по себе не видна на фоне палитры.
    expect(row?.className).toContain('data-[selected=true]:ring-palette-selected-edge');
    expect(row?.className).toContain('data-[selected=true]:ring-1');
    expect(row?.className).toContain('data-[selected=true]:ring-inset');
    expect(row?.className).not.toContain('bg-accent');
    expect(row?.className).not.toContain('13%');
  });

  it('ввод S02 — первая строка сессия; Enter открывает её вкладку, палитра закрыта', async () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'план'), makeSession('s-02', 'бэкенд')] });
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('S02');

    expect(screen.getAllByRole('option')[0]?.textContent).toContain('S02 бэкенд');
    expect(selectedOption()?.textContent).toContain('S02 бэкенд');
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(async () => {});

    expect(usePaletteStore.getState().open).toBe(false);
    const layout = useLayoutStore.getState().layouts[keyOf(w)];
    expect(layout && groups(layout)[0]?.activeTabId).toBe(tabId.terminal('s-02'));
  });

  it('⌘Enter — в новой группе справа, обычное открытие не выполнено', async () => {
    mockNonZeroRects();
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'план'), makeSession('s-02', 'бэкенд')] });
    setup([w], openTab(emptyLayout(), term('s-01')));
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('S02');

    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await act(async () => {});

    expect(usePaletteStore.getState().open).toBe(false);
    const layout = useLayoutStore.getState().layouts[keyOf(w)];
    if (layout === undefined) throw new Error('нет раскладки');
    const all = groups(layout);
    expect(all.map((group) => group.tabs.map((tab) => tab.id))).toEqual([[tabId.terminal('s-01')], [tabId.terminal('s-02')]]);
    expect(layout.root.type === 'split' && layout.root.direction).toBe('row');
  });

  it('две работы с сессией S01: ↓ выделяет вторую строку S01, а не первую', async () => {
    const a = makeWork('w-01', { projectPath: '/tmp/a', title: 'Альфа', sessions: [makeSession('s-01', 'план')] });
    const b = makeWork('w-02', { projectPath: '/tmp/b', title: 'Бета', sessions: [makeSession('s-01', 'план')] });
    setup([a, b]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('S01');

    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('S01 план');
    expect(options[1]?.textContent).toContain('S01 план');
    expect(selectedOption()).toBe(options[0]);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    await act(async () => {});
    expect(selectedOption()).toBe(screen.getAllByRole('option')[1]);
  });

  it('нет совпадений — строка Create workspace открывает форму с названием запроса; works.create и sessions.create не вызваны', async () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая' });
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('zzqq');

    fireEvent.click(screen.getByRole('option', { name: 'Create workspace “zzqq”' }));
    await act(async () => {});

    expect(usePaletteStore.getState().open).toBe(false);
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: null, title: 'zzqq' });
    expect(bridge.calls.filter((call) => call.method === 'works.create' || call.method === 'sessions.create')).toEqual([]);
  });

  it('pickRow(1) (⌘2) выбирает вторую строку', async () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'план'), makeSession('s-02', 'план')] });
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('план');
    expect(screen.getAllByRole('option')[1]?.textContent).toContain('S02 план');
    expect(screen.getAllByRole('option')[1]?.textContent).toContain('⌘2');

    act(() => usePaletteStore.getState().pickRow(1));
    await act(async () => {});

    expect(usePaletteStore.getState().open).toBe(false);
    const layout = useLayoutStore.getState().layouts[keyOf(w)];
    expect(layout && groups(layout)[0]?.activeTabId).toBe(tabId.terminal('s-02'));
  });

  it('Enter на строке сессии — нажатие погашено, pty.input нет, фокус не вернулся на кнопку; Esc без выбора — вернулся', async () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-02', 'бэкенд')] });
    setup([w]);
    render(
      <>
        <button type="button" onClick={() => usePaletteStore.getState().openWith('default')}>
          opener
        </button>
        <Palette bridge={bridge} run={() => {}} />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    await type('S02');

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      input().dispatchEvent(enter);
    });
    await act(async () => {});

    expect(enter.defaultPrevented).toBe(true);
    expect(usePaletteStore.getState().open).toBe(false);
    expect(bridge.notified.filter((note) => note.method === 'pty.input')).toEqual([]);
    // Radix отдаёт фокус после размонтирования таймером — подождать его.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).not.toBe(opener);

    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    fireEvent.keyDown(input(), { key: 'Escape' });
    await act(async () => {});
    expect(usePaletteStore.getState().open).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('splitRight при восьми группах — тост No more than 8 groups per workspace', async () => {
    mockNonZeroRects();
    const sessions = Array.from({ length: 9 }, (_, i) => makeSession(`s-0${i + 1}`, `session ${i + 1}`));
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions });
    let layout = openTab(emptyLayout(), term('s-01'));
    for (let i = 1; i < 8; i += 1) {
      const sizes = Object.fromEntries(groups(layout).map((group) => [group.id, { width: 800, height: 600 }]));
      const result = splitGroup(layout, layout.activeGroupId, 'row', term(`s-0${i + 1}`), sizes);
      layout = result.layout;
    }
    expect(groups(layout)).toHaveLength(8);
    setup([w], layout);
    act(() => usePaletteStore.getState().openWith('splitRight'));
    renderPalette();

    expect(screen.getByText('Open in new group')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /S09 session 9/ }));
    await act(async () => {});

    expect(vi.mocked(toast)).toHaveBeenCalledWith('No more than 8 groups per workspace');
    const after = useLayoutStore.getState().layouts[keyOf(w)];
    expect(after && groups(after)).toHaveLength(8);
  });

  it('длинное название работы — строка обрезается многоточием, а не распирает палитру', async () => {
    const title = `layout-check-${'W'.repeat(107)}`;
    const w = makeWork('w-01', { projectPath: '/private/var/folders/xy/abcdef/T/project', title, sessions: [makeSession('s-01', 'план', { task: 'x'.repeat(5000) })] });
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('план');

    // Подпись сессии — «работа · слово · провайдер» (1.9): длинное название стоит в её начале.
    const titleNode = screen.getAllByText((text) => text.startsWith(title))[0];
    expect(titleNode?.className).toContain('truncate');
    expect(screen.getAllByRole('option')[0]?.className).toContain('min-w-0');
  });

  it('длинные название, подпись и «Create workspace …» — полный текст в тултипе (title)', async () => {
    const title = `layout-check-${'W'.repeat(107)}`;
    const projectPath = `/private/var/folders/${'p'.repeat(120)}/project`;
    const w = makeWork('w-01', { projectPath, title });
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('layout-check');

    const row = screen.getAllByRole('option')[0];
    const titleNode = screen.getAllByText(title)[0];
    expect(titleNode?.getAttribute('title')).toBe(title);
    const subtitleNode = row?.querySelector('span.text-muted-foreground');
    expect(subtitleNode?.textContent).not.toBe('');
    expect(subtitleNode?.getAttribute('title')).toBe(subtitleNode?.textContent);

    const query = 'q'.repeat(120);
    await type(query);
    const create = screen.getByText(`Create workspace “${query}”`);
    expect(create.getAttribute('title')).toBe(`Create workspace “${query}”`);
  });
});

// Облик Organic (спека окна 2026-09-29, 1.9): затемнение neutral-900 45 % (тёмная — --scrim) и blur 2px; панель 720,
// радиус 28, фон neutral-100, shadow-lg; поле — пилюля 48px на фоне окна; секции — 11px капсом; пункты — радиус 16;
// ⌘1…⌘9 — пилюли; подвал на `bg`.
describe('Palette — облик Organic (1.9)', () => {
  const open = async (query = ''): Promise<void> => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'план'), makeSession('s-02', 'бэкенд')] });
    setup([w], openTab(emptyLayout(), term('s-01')));
    // Без запроса палитра показывает последние вкладки и работы из истории переходов.
    useLayoutStore.setState({
      history: { entries: [{ workKey: keyOf(w), tabId: tabId.terminal('s-01'), at: Date.now() }], index: 0 },
    });
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    if (query !== '') await type(query);
    await act(async () => {});
  };

  it('затемнение — neutral-900 45 %, в тёмной --scrim, blur 2px', async () => {
    await open();
    const overlay = document.querySelector('[data-palette]')?.previousElementSibling as HTMLElement;
    expect(overlay.className).toContain('color-mix(in_srgb,var(--color-neutral-900)_45%,transparent)');
    expect(overlay.className).toContain('dark:bg-scrim');
    expect(overlay.className).toContain('backdrop-blur-[2px]');
    expect(overlay.className).not.toContain('bg-black/55');
  });

  it('панель: 720px, радиус 28, фон neutral-100 (popover), shadow-lg, без рамки и полупрозрачности', async () => {
    await open();
    const panel = document.querySelector('[data-palette]') as HTMLElement;
    expect(panel.className).toContain('w-[720px]');
    expect(panel.className).toMatch(/\brounded-lg\b/);
    expect(panel.className).toMatch(/\bbg-popover\b/);
    expect(panel.className).toMatch(/\bshadow-lg\b/);
    expect(panel.className).toContain('top-[min(10%,4rem)]');
    expect(panel.className).not.toMatch(/\bborder\b/);
    expect(panel.className).not.toContain('backdrop-blur-xl');
    expect(panel.className).not.toContain('/96');
  });

  it('поле — пилюля 48px на фоне окна с значком поиска 16 и подсказкой по handoff', async () => {
    await open();
    const field = input();
    expect(field.getAttribute('placeholder')).toBe('Search workspaces, sessions, tabs and actions');
    expect(field.className).toContain('text-[15px]');
    const pill = field.parentElement as HTMLElement;
    expect(pill.className).toMatch(/\bh-12\b/);
    expect(pill.className).toMatch(/\brounded-full\b/);
    expect(pill.className).toMatch(/\bbg-background\b/);
    expect(pill.querySelector('svg')?.classList.contains('size-4')).toBe(true);
  });

  it('без запроса секция вкладок — «Open tabs», с запросом — «Tabs»; заголовок 11px капсом', async () => {
    await open();
    const heading = document.querySelector('[cmdk-group-heading]') as HTMLElement;
    expect(heading.textContent).toBe('Open tabs');
    expect(heading.parentElement?.className).toContain('[&_[cmdk-group-heading]]:uppercase');
    expect(heading.parentElement?.className).toContain('[&_[cmdk-group-heading]]:text-[11px]');
    await type('S01');
    expect([...document.querySelectorAll('[cmdk-group-heading]')].map((node) => node.textContent)).toContain('Tabs');
    expect([...document.querySelectorAll('[cmdk-group-heading]')].map((node) => node.textContent)).not.toContain('Open tabs');
  });

  it('пункт — радиус 16, отступ 9 12; ⌘1…⌘9 — пилюля 10px на neutral-200', async () => {
    await open();
    const row = screen.getAllByRole('option')[0] as HTMLElement;
    expect(row.className).toMatch(/\brounded-md\b/);
    expect(row.className).toContain('py-[9px]');
    expect(row.className).toMatch(/\bpx-3\b/);
    const shortcut = [...row.querySelectorAll('span')].find((node) => node.textContent === '⌘1') as HTMLElement;
    expect(shortcut.className).toMatch(/\brounded-full\b/);
    expect(shortcut.className).toContain('bg-neutral-200');
    expect(shortcut.className).toContain('text-neutral-800');
    expect(shortcut.className).toContain('text-[10px]');
    expect(shortcut.className).not.toContain('opacity-60');
  });

  it('подвал 11px на фоне bg: ↑↓ select, Enter open, ⌘Enter open to the side, ⌘1–9 pick, Esc close', async () => {
    await open();
    const footer = screen.getByText('↑↓ select').parentElement as HTMLElement;
    expect(footer.className).toContain('text-[11px]');
    expect(footer.className).toContain('bg-(--color-bg)');
    expect([...footer.children].map((node) => node.textContent)).toEqual(['↑↓ select', 'Enter open', '⌘Enter open to the side', '⌘1–9 pick', 'Esc close']);
    expect(footer.className).not.toMatch(/\bborder-t\b/);
  });

  it('пункт «New session or room» — есть среди действий палитры и открывает диалог ⌘T (run(session.new))', async () => {
    const ran: string[] = [];
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'план')] });
    setup([w], openTab(emptyLayout(), term('s-01')));
    act(() => usePaletteStore.getState().openWith('default'));
    render(<Palette bridge={bridge} run={(id) => ran.push(id)} />);
    await type('new session');

    const row = screen.getByRole('option', { name: /New session or room/ });
    expect(row).toBeTruthy();
    fireEvent.click(row);
    await act(async () => {});
    expect(ran).toEqual(['session.new']);
  });
});

describe('Palette — файлы: ⌘P и префикс / (тест 5 куска 7.4)', () => {
  const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Первая', sessions: [makeSession('s-01', 'main')] });
  const root = { workKey: keyOf(w), spec: { kind: 'project' as const } };

  function headings(): string[] {
    return [...document.querySelectorAll('[cmdk-group-heading]')].map((node) => node.textContent ?? '');
  }

  it('ввод /main — секция Files с src/main.ts, других секций нет', async () => {
    setup([w]);
    bridge.setLsFiles(root, { paths: ['docs/main-notes/x.md', 'src/main.ts', 'README.md'], truncated: false });
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('/main');
    await waitFor(() => expect(headings()).toEqual(['Files']));
    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('main.ts');
    expect(options[0]?.textContent).toContain('src/main.ts');
    expect(options).toHaveLength(2);
    expect(bridge.lsFilesCalls).toEqual([root]);
  });

  it('/нетакого — No matching files, строки Create workspace нет', async () => {
    setup([w]);
    bridge.setLsFiles(root, { paths: ['src/main.ts'], truncated: false });
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('/нетакого');
    await waitFor(() => expect(screen.getByText('No matching files')).toBeTruthy());
    expect(screen.queryByText(/Create workspace/)).toBeNull();
  });

  it('пока lsFiles не ответил — Loading files…', async () => {
    setup([w]);
    bridge.files.lsFiles = () => new Promise(() => {});
    act(() => usePaletteStore.getState().openWith('files'));
    renderPalette();
    await act(async () => {});
    expect(screen.getByText('Loading files…')).toBeTruthy();
    expect(screen.queryByText('No matching files')).toBeNull();
  });

  it('truncated: true — строка Showing first N files; truncated: false — её нет', async () => {
    setup([w]);
    bridge.setLsFiles(root, { paths: ['a.ts', 'b.ts', 'c.ts'], truncated: true });
    act(() => usePaletteStore.getState().openWith('files'));
    renderPalette();
    await waitFor(() => expect(screen.getByText('Showing first 3 files')).toBeTruthy());
    cleanup();

    bridge.setLsFiles(root, { paths: ['a.ts', 'b.ts', 'c.ts'], truncated: false });
    act(() => usePaletteStore.getState().openWith('files'));
    renderPalette();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.queryByText(/Showing first/)).toBeNull();
  });

  it('режим files: 60 путей — 50 строк и Refine your query вместо «ещё N»; шестидесятый — по имени', async () => {
    setup([w]);
    const paths = [...Array.from({ length: 59 }, (_, index) => `dir/file-${index}.ts`), 'deep/zeta-last.ts'];
    bridge.setLsFiles(root, { paths, truncated: false });
    act(() => usePaletteStore.getState().openWith('files'));
    renderPalette();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(50));
    expect(screen.getByText('Refine your query')).toBeTruthy();
    expect(screen.queryByText(/more$/)).toBeNull();
    await type('zeta');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('zeta-last.ts')]);
    expect(screen.queryByText('Refine your query')).toBeNull();
  });

  it('Enter открывает вкладку файла, палитра закрыта', async () => {
    setup([w]);
    bridge.setLsFiles(root, { paths: ['src/main.ts'], truncated: false });
    act(() => usePaletteStore.getState().openWith('files'));
    renderPalette();
    await type('main');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(async () => {});
    expect(usePaletteStore.getState().open).toBe(false);
    const layout = useLayoutStore.getState().layouts[keyOf(w)];
    expect(layout && groups(layout)[0]?.activeTabId).toBe(tabId.file({ kind: 'project' }, 'src/main.ts'));
  });

  it('отказ lsFiles — тост Couldn’t read folder', async () => {
    setup([w]);
    bridge.setLsFiles(root, { code: 'failed', message: 'boom' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => usePaletteStore.getState().openWith('files'));
    renderPalette();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't read folder: failed."));
    expect(screen.queryByText('Loading files…')).toBeNull();
    warn.mockRestore();
  });

  it('обычный запрос без / файлов не ищет и lsFiles не зовёт', async () => {
    setup([w]);
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('main');
    expect(bridge.lsFilesCalls).toEqual([]);
    expect(headings()).not.toContain('Files');
  });
});
