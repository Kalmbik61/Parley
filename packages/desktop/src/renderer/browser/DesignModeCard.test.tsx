/**
 * Тест 2 куска 9.3b: карточка выбранного элемента. Отправка — только выбором получателя человеком
 * (`SendMenu`), `pty.send` с блоком и `submit: true`; `Copy` пишет блок в буфер без `pty.send`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { PickResult } from '../../shared/browser-types.js';
import type { GroupNode } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { designBlock } from './design-block.js';
import { DesignModeCard } from './DesignModeCard.js';

vi.mock('sonner', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast: fn };
});

const ENTRY = makeWork('w-01', {
  projectPath: '/tmp/proj',
  sessions: [makeSession('s-01', 'planner'), makeSession('s-02', 'executor')],
});
const WORK_KEY = '/tmp/proj w-01';

const PICK: PickResult = {
  url: 'http://127.0.0.1:5173/',
  selector: 'body > button.save',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: { display: 'block' },
  imagePath: '/tmp/drops/a.png',
  thumbnail: 'data:image/png;base64,AAAA',
};

let bridge: FakeBridge;
let deps: SendWithToastDeps;

function setLayout(activeTerminal: string): void {
  const root: GroupNode = {
    type: 'group',
    id: 'g1',
    tabs: [
      { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' },
      { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' },
    ],
    activeTabId: `terminal:${activeTerminal}`,
  };
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root, activeGroupId: 'g1', closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

beforeEach(() => {
  bridge = createFakeBridge();
  deps = { bridge, session: () => null, openSession: vi.fn() };
  setLayout('s-02');
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(cleanup);

function renderCard(onPickAgain = vi.fn()): void {
  render(<DesignModeCard workKey={WORK_KEY} entry={ENTRY} result={PICK} sendDeps={deps} onPickAgain={onPickAgain} />);
}

function sends(): unknown[] {
  return bridge.calls.filter((call) => call.method === 'pty.send').map((call) => call.params);
}

function chooseRecipient(sessionId: string): void {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Choose recipient' }), { key: 'Enter' });
  const item = within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .find((candidate) => candidate.getAttribute('data-session-id') === sessionId);
  if (item === undefined) throw new Error(`нет ${sessionId} в меню`);
  fireEvent.click(item);
}

describe('DesignModeCard (тест 2)', () => {
  it('выбор сессии в Send to agent ▾ — pty.send с блоком и submit: true; монтирование ничего не шлёт', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderCard();
    expect(sends()).toEqual([]);
    chooseRecipient('s-01');
    await act(async () => {});
    expect(sends()).toEqual([{ ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' }, text: designBlock(PICK), submit: true }]);
    expect(toast).toHaveBeenCalledWith('Sent to S01', {});
  });

  it('ответ busy — тост с Retry; повтор — только кнопкой тоста', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    renderCard();
    chooseRecipient('s-02');
    await act(async () => {});
    expect(sends()).toHaveLength(1);
    const [text, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(text).toBe('S02 is busy with another message — retry in a second');
    expect((options as { action?: { label: string } }).action?.label).toBe('Retry');
  });

  it('по умолчанию в меню — focusedSessionOf работы', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /^Send to agent/ }).textContent).toContain('S02');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Choose recipient' }), { key: 'Enter' });
    const defaults = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .filter((item) => item.hasAttribute('data-default'))
      .map((item) => item.getAttribute('data-session-id'));
    expect(defaults).toEqual(['s-02']);
  });

  it('Copy пишет блок в буфер, pty.send нет', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(designBlock(PICK));
    expect(sends()).toEqual([]);
  });

  it('миниатюра — <img> с thumbnail; без неё картинки нет; селектор и текст видны; Pick again — onPickAgain', () => {
    const onPickAgain = vi.fn();
    renderCard(onPickAgain);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe(PICK.thumbnail);
    expect(screen.getByText(PICK.selector)).toBeTruthy();
    expect(screen.getByText(PICK.text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick again' }));
    expect(onPickAgain).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <DesignModeCard workKey={WORK_KEY} entry={ENTRY} result={{ ...PICK, thumbnail: null }} sendDeps={deps} onPickAgain={vi.fn()} />,
    );
    expect(document.querySelector('img')).toBeNull();
  });
});
