/**
 * Пути к файлам в тексте ленты (`remarkFilePaths` + `FilePathText`): ссылка только с ⌘/Ctrl, только под указателем и
 * только найденная main в корне работы; клик с модификатором — редактор на строке и колонке, каталог — приложение по
 * умолчанию.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Located } from '../../../shared/files-types.js';
import { activatePathLink } from '../../terminal/LinkMenu.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { FilePathLinksContext } from './FilePathText.js';
import { RoomMarkdown } from './RoomMarkdown.js';

vi.mock('../../terminal/LinkMenu.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/LinkMenu.js')>()),
  activatePathLink: vi.fn(),
}));

afterEach(() => {
  // Отпустить модификатор: состояние у окна одно на все тесты.
  fireEvent.keyUp(window, { key: 'Control' });
  fireEvent.keyUp(window, { key: 'Meta' });
  cleanup();
  vi.mocked(activatePathLink).mockClear();
});

const WORK = 'w';
const fileAt = (relPath: string): Located => ({
  root: { workKey: WORK, spec: { kind: 'project' } },
  relPath,
  stat: { kind: 'file', size: 1, mtimeMs: 0 },
});

function mount(text: string, bridge: FakeBridge | null): HTMLElement {
  const markdown = <RoomMarkdown text={text} labelOf={() => null} onOpenExternal={() => {}} />;
  const { container } = render(
    bridge === null ? markdown : <FilePathLinksContext.Provider value={{ bridge, workKey: WORK, cwd: '/proj' }}>{markdown}</FilePathLinksContext.Provider>,
  );
  return container;
}

/** ⌘ и Ctrl разом: модификатор окна зависит от платформы. */
const MODIFIER = { metaKey: true, ctrlKey: true };

async function holdModifier(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'Control', ...MODIFIER });
  });
}

/** Указатель над каждым кандидатом по очереди (в тесте все остаются «под указателем»). */
async function hoverAll(container: HTMLElement): Promise<void> {
  await act(async () => {
    for (const span of Array.from(container.querySelectorAll('[data-file-path]'))) fireEvent.mouseEnter(span);
  });
}

const links = (container: HTMLElement): string[] => Array.from(container.querySelectorAll('[data-file-link]'), (el) => el.textContent ?? '');

describe('FilePathText — пути к файлам ссылками по ⌘/Ctrl', () => {
  it('без модификатора путь — текст, main не спрашивают; с ним — ссылка с подчёркиванием под указателем, только найденные main', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated(WORK, '/proj/src/a.ts', fileAt('src/a.ts'));
    bridge.setLocated(WORK, '/proj/src/b.ts', fileAt('src/b.ts'));
    const container = mount('см. src/a.ts:12:3, `src/b.ts:4` и missing/c.ts', bridge);
    expect(container.textContent).toBe('см. src/a.ts:12:3, src/b.ts:4 и missing/c.ts');
    expect(links(container)).toEqual([]);
    expect(bridge.locateCalls).toEqual([]);

    await holdModifier();
    // Модификатор без указателя над путём — main не спрашивают, ничего не подчёркнуто (⌘C в поле ввода).
    expect(bridge.locateCalls).toEqual([]);
    expect(links(container)).toEqual([]);
    await act(async () => {
      fireEvent.mouseEnter(container.querySelector('[data-file-path]') as HTMLElement);
    });
    expect(links(container)).toEqual(['src/a.ts:12:3']);
    expect(bridge.locateCalls.flatMap((call) => call.absPaths)).toEqual(['/proj/src/a.ts']);
    fireEvent.mouseLeave(container.querySelector('[data-file-link]') as HTMLElement);
    expect(links(container)).toEqual([]);
    await hoverAll(container);
    expect(links(container)).toEqual(['src/a.ts:12:3', 'src/b.ts:4']);
    const link = container.querySelector('[data-file-link]') as HTMLElement;
    expect(link.className).toContain('underline');
    expect(link.className).toContain('cursor-pointer');
    expect(container.querySelector('code [data-file-link]')?.textContent).toBe('src/b.ts:4');

    fireEvent.keyUp(window, { key: 'Control' });
    expect(links(container)).toEqual([]);
  });

  it('клик с модификатором — редактор на строке и колонке; без модификатора — ничего', async () => {
    const bridge = createFakeBridge();
    const located = fileAt('src/a.ts');
    bridge.setLocated(WORK, '/proj/src/a.ts', located);
    const container = mount('src/a.ts:12:3', bridge);
    await holdModifier();
    await hoverAll(container);
    const link = container.querySelector('[data-file-link]') as HTMLElement;
    fireEvent.click(link);
    expect(activatePathLink).not.toHaveBeenCalled();
    fireEvent.click(link, MODIFIER);
    expect(activatePathLink).toHaveBeenCalledWith(bridge, { kind: 'path', absPath: '/proj/src/a.ts', located, line: 12, col: 3 });
  });

  it('каталог — то же единое действие ⌘-клика, что в терминале (activatePathLink)', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated(WORK, '/proj/src/lib', { ...fileAt('src/lib'), stat: { kind: 'dir', size: 0, mtimeMs: 0 } });
    const container = mount('см. /proj/src/lib', bridge);
    await holdModifier();
    await hoverAll(container);
    fireEvent.click(container.querySelector('[data-file-link]') as HTMLElement, MODIFIER);
    expect(activatePathLink).toHaveBeenCalledWith(bridge, expect.objectContaining({ absPath: '/proj/src/lib' }));
  });

  it('корень чужой работы и путь вне окружения (нет FilePathLinksContext) — не ссылки', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated(WORK, '/proj/src/a.ts', { ...fileAt('src/a.ts'), root: { workKey: 'other', spec: { kind: 'project' } } });
    const container = mount('src/a.ts', bridge);
    const bare = mount('src/a.ts', null);
    await holdModifier();
    await hoverAll(container);
    await hoverAll(bare);
    expect(links(container)).toEqual([]);
    expect(links(bare)).toEqual([]);
  });

  it('путь в адресе ссылки и в блоке кода не кандидат; окно потеряло фокус — модификатор отпущен', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated(WORK, '/proj/src/a.ts', fileAt('src/a.ts'));
    const container = mount('[src/x.ts](https://example.com/src/x.ts)\n\n```\nsrc/y.ts\n```\n\nsrc/a.ts', bridge);
    await holdModifier();
    await hoverAll(container);
    expect(bridge.locateCalls.flatMap((call) => call.absPaths)).toEqual(['/proj/src/a.ts']);
    expect(links(container)).toEqual(['src/a.ts']);
    fireEvent.blur(window);
    expect(links(container)).toEqual([]);
  });
});
