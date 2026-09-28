/**
 * Кусок 8.2b, тесты 1–8 и 10: вкладка «Изменения» — главная кнопка, слияние, просьба агенту,
 * секции, pending, ошибки в теле, старый хост, «Discard worktree…», сессия шапки; перенос —
 * состояние после отброшенного worktree.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergeCheck, ProjectChanges, WorkEntry, WorktreeDiff } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { TabSpec } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, groups, openTab } from '../layout/tree.js';
import { BASELINE_METHODS, REQUIRED_METHODS } from '../lib/capabilities.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { ChangesPanel } from './ChangesPanel.js';
import { useReviewStore } from './store.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KEY = '/tmp/proj w-a';
const COMMIT = { hash: 'b'.repeat(40), subject: 'feat: add a', author: 'agent', at: '2026-09-27T09:00:00Z' };
const WORKTREE = { path: '/tmp/wt/s-02', branch: 'harnas/w-a/s02', base: 'master', createdAt: '2026-09-27T08:00:00Z' };

function diff(patch: Partial<WorktreeDiff> = {}): WorktreeDiff {
  return {
    patch: '',
    files: [],
    uncommitted: false,
    baseCheckout: '/tmp/proj',
    baseDirty: false,
    mergeBase: 'a'.repeat(40),
    stats: { additions: 0, deletions: 0 },
    commits: [],
    uncommittedPaths: [],
    ...patch,
  };
}

const file = (path: string, additions = 1, deletions = 0): WorktreeDiff['files'][number] => ({ path, status: 'M', oldPath: null, additions, deletions });

function project(patch: Partial<ProjectChanges> = {}): ProjectChanges {
  return { patch: '', files: [], stats: { additions: 0, deletions: 0 }, branch: 'master', ...patch };
}

function work(sessions = [
  makeSession('s-02', 'two', { worktree: WORKTREE }),
  makeSession('s-03', 'three', { worktree: { ...WORKTREE, path: '/tmp/wt/s-03', branch: 'harnas/w-a/s03' } }),
  makeSession('s-04', 'four'),
]): WorkEntry {
  return makeWork('w-a', { projectPath: '/tmp/proj', sessions });
}

const term = (sessionId: string): TabSpec => ({ kind: 'terminal', id: tabId.terminal(sessionId), sessionId });

let bridge: FakeBridge;
let sendDeps: SendWithToastDeps;

function count(method: string): number {
  return bridge.calls.filter((call) => call.method === method).length;
}

function params(method: string): unknown[] {
  return bridge.calls.filter((call) => call.method === method).map((call) => call.params);
}

/** Раскладка работы с терминалом сессии в фокусе. */
function focus(sessionId: string): void {
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: { [KEY]: openTab(emptyLayout(), term(sessionId)) },
    hydrated: { [KEY]: true },
  });
}

function renderPanel(entry: WorkEntry = work()): ReturnType<typeof render> {
  return render(<ChangesPanel bridge={bridge} workKey={KEY} entry={entry} sendDeps={sendDeps} />);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setWorking(sessionId: string): void {
  useActivityStore.setState({ byRef: activityMap([makeActivity({ projectPath: '/tmp/proj', workId: 'w-a', sessionId }, 'working')]) });
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

beforeEach(() => {
  bridge = createFakeBridge();
  sendDeps = { bridge, session: () => null, openSession: vi.fn() };
  bridge.setHandler('worktrees.diff', () => diff());
  bridge.setHandler('worktrees.mergeCheck', (): MergeCheck => ({ status: 'clean' }));
  bridge.setHandler('changes.project', () => project());
  bridge.setHandler('worktrees.commit', () => ({ commit: 'c'.repeat(40) }));
  bridge.setHandler('changes.commitProject', () => ({ commit: 'c'.repeat(40) }));
  bridge.setHandler('worktrees.discard', () => ({ ok: true as const }));
  useHostStore.getState().init(bridge);
  bridge.setHostMethods([...REQUIRED_METHODS]);
  useActivityStore.setState({ byRef: {} });
  useReviewStore.setState({ changesSession: {}, revealed: {}, discarded: {} });
  useUiStore.setState((state) => ({ dialogs: { ...state.dialogs, restartHost: false } }));
  useLayoutStore.setState({ activeWorkKey: KEY, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  focus('s-02');
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('PrimaryAction (тест 1)', () => {
  it('пустое сообщение — неактивна только кнопка коммита; Merge into master активна без поля', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    renderPanel();
    const commit = await screen.findByRole('button', { name: 'Commit' });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'fix' } });
    expect((commit as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts')] }));
    renderPanel();
    const merge = await screen.findByRole('button', { name: 'Merge into master' });
    expect((merge as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByPlaceholderText('Commit message')).toBeNull();
  });

  it('commit вне working — worktrees.commit без вопроса; затем worktrees.diff сразу, мимо дросселя', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    renderPanel();
    await screen.findByRole('button', { name: 'Commit' });
    expect(count('worktrees.diff')).toBe(1);
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: '  fix a  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(params('worktrees.commit')).toEqual([{ ref: { projectPath: '/tmp/proj', workId: 'w-a', sessionId: 's-02' }, message: 'fix a' }]);
    // Дроссель 2 с: waitFor ждёт 1 с — второй вызов пришёл только потому, что refresh() мимо него.
    await waitFor(() => expect(count('worktrees.diff')).toBe(2));
    expect((screen.getByPlaceholderText('Commit message') as HTMLTextAreaElement).value).toBe('');
  });

  it('⌘Enter в поле — тот же коммит', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    renderPanel();
    const field = await screen.findByPlaceholderText('Commit message');
    fireEvent.change(field, { target: { value: 'fix' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await flush();
    expect(count('worktrees.commit')).toBe(1);
  });

  it('двойной клик Commit (и ⌘Enter + клик) — один worktrees.commit, тоста ошибки нет; пока идёт запрос, кнопка неактивна (раунд 8, пункт 2)', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    // Как хост: второй коммит на чистом дереве — conflict.
    let commits = 0;
    let release: () => void = () => {};
    bridge.setHandler('worktrees.commit', async () => {
      commits += 1;
      if (commits > 1) throw { code: 'conflict', message: 'нет изменений для коммита' };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { commit: 'c'.repeat(40) };
    });
    renderPanel();
    const field = await screen.findByPlaceholderText('Commit message');
    fireEvent.change(field, { target: { value: 'fix' } });
    const button = screen.getByRole('button', { name: 'Commit' }) as HTMLButtonElement;
    // Оба нажатия — в одном такте, до перерисовки: защита не должна зависеть от disabled.
    act(() => {
      button.click();
      button.click();
    });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(button.disabled).toBe(true);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();
    expect(count('worktrees.commit')).toBe(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('commit в working — вопрос со строкой про агента; коммит только после подтверждения', async () => {
    setWorking('s-02');
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    renderPanel();
    fireEvent.change(await screen.findByPlaceholderText('Commit message'), { target: { value: 'fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    expect(within(dialog()).getByText('Commit to harnas/w-a/s02?')).toBeTruthy();
    expect(dialog().textContent).toContain('The agent is still working — changes may be incomplete');
    expect(count('worktrees.commit')).toBe(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Commit' }));
    await flush();
    expect(count('worktrees.commit')).toBe(1);
  });

  it('commit-project — вопрос всегда, с предупреждением про всю папку', async () => {
    focus('s-04');
    bridge.setHandler('changes.project', () => project({ files: [file('x.ts')] }));
    renderPanel();
    fireEvent.change(await screen.findByPlaceholderText('Commit message'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit all in folder' }));
    expect(dialog().textContent).toContain("A commit takes every change in the folder, not only this session's");
    expect(dialog().textContent).not.toContain('The agent is still working');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Commit all in folder' }));
    await flush();
    expect(params('changes.commitProject')).toEqual([{ ref: { projectPath: '/tmp/proj', workId: 'w-a', sessionId: 's-04' }, message: 'all' }]);
  });

  it('отказ коммита — тост по коду, сообщения хоста в DOM нет', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    bridge.setHandler('worktrees.commit', () => {
      throw { code: 'conflict', message: 'нет изменений для коммита' };
    });
    renderPanel();
    fireEvent.change(await screen.findByPlaceholderText('Commit message'), { target: { value: 'fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await flush();
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/^Couldn't commit: /);
    expect(document.body.textContent).not.toContain('нет изменений');
  });
});

describe('Слияние (тест 2)', () => {
  it('подтверждение с числами → worktrees.merge; conflict → тост и раскрытые Conflicts с файлами ответа', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts', 3, 1)], stats: { additions: 3, deletions: 1 } }));
    bridge.setHandler('worktrees.merge', () => ({ ok: false as const, reason: 'conflict' as const, files: ['src/x.ts'] }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into master' }));
    expect(within(dialog()).getByText('Merge harnas/w-a/s02 into master?')).toBeTruthy();
    expect(dialog().textContent).toContain('1 commit, +3 −1. master is checked out in /tmp/proj.');
    expect(count('worktrees.merge')).toBe(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Merge into master' }));
    await flush();
    expect(count('worktrees.merge')).toBe(1);
    expect(toast.error).toHaveBeenCalledWith('Merge conflict in src/x.ts');
    const conflicts = await screen.findByRole('region', { name: 'Conflicts' });
    expect(within(conflicts).getByText('src/x.ts')).toBeTruthy();
    expect(within(conflicts).getByRole('button', { name: /Conflicts/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('baseCheckout: null → тост, ни подтверждения, ни worktrees.merge', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts')], baseCheckout: null }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into master' }));
    await flush();
    expect(toast.error).toHaveBeenCalledWith("master isn't checked out anywhere — check it out in the project folder");
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(count('worktrees.merge')).toBe(0);
  });

  it('в working — подтверждение слияния со строкой про агента; успех — тост и обновление', async () => {
    setWorking('s-02');
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts')] }));
    bridge.setHandler('worktrees.merge', () => ({ ok: true as const, commit: 'd'.repeat(40) }) as never);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into master' }));
    expect(dialog().textContent).toContain('The agent is still working — changes may be incomplete');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Merge into master' }));
    await flush();
    expect(toast).toHaveBeenCalledWith('Merged into master');
    await waitFor(() => expect(count('worktrees.diff')).toBe(2));
  });
});

describe('AskAgentDialog (тест 3)', () => {
  const conflicted = (): void => {
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts')] }));
    bridge.setHandler('worktrees.mergeCheck', (): MergeCheck => ({ status: 'conflicts', files: ['a.ts', 'b.ts'] }));
  };

  it('Send зовёт pty.send с отредактированным текстом и submit: true; получатель — сессия worktree', async () => {
    conflicted();
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask agent to resolve' }));
    expect(within(dialog()).getByText('Ask S02 to resolve conflicts')).toBeTruthy();
    const field = within(dialog()).getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe(
      'Branch harnas/w-a/s02 has merge conflicts with master in:\n- a.ts\n- b.ts\nMerge master into your branch (git merge master), resolve the conflicts, commit, and tell me what you did.',
    );
    expect(count('pty.send')).toBe(0);
    fireEvent.change(field, { target: { value: 'please fix a.ts' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(params('pty.send')).toEqual([{ ref: { projectPath: '/tmp/proj', workId: 'w-a', sessionId: 's-02' }, text: 'please fix a.ts', submit: true }]);
    expect(toast).toHaveBeenCalledWith('Sent to S02', {});
  });

  it('двойной клик Send — один pty.send (раунд 8, пункт 3)', async () => {
    conflicted();
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask agent to resolve' }));
    const send = within(dialog()).getByRole('button', { name: 'Send' });
    // Кнопка живёт в DOM на время анимации закрытия — второй клик до перерисовки.
    act(() => {
      send.click();
      send.click();
    });
    await flush();
    expect(count('pty.send')).toBe(1);

    // Новое открытие — снова одна отправка.
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent to resolve' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(count('pty.send')).toBe(2);
  });

  it('ответ blocked — тост S02 is waiting for your answer', async () => {
    conflicted();
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' as const }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask agent to resolve' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe('S02 is waiting for your answer — text not inserted');
  });

  it('текст больше 64 КБ — тост Too long, pty.send нет', async () => {
    conflicted();
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask agent to resolve' }));
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'x'.repeat(65_537) } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(toast.error).toHaveBeenCalledWith('Too long for one message to the agent — 64 KB max');
    expect(count('pty.send')).toBe(0);
  });
});

describe('Секции (тест 4)', () => {
  it('worktree: файл из uncommittedPaths — в Uncommitted, прочие — в Branch changes; после коммита Uncommitted пуста', async () => {
    let dirty = true;
    bridge.setHandler('worktrees.diff', () =>
      diff({
        uncommitted: dirty,
        files: [file('a.ts', 2, 1), file('b.ts')],
        uncommittedPaths: dirty ? ['a.ts'] : [],
        commits: [COMMIT],
      }),
    );
    renderPanel();
    const uncommitted = await screen.findByRole('region', { name: 'Uncommitted' });
    const branch = screen.getByRole('region', { name: 'Branch changes' });
    expect(within(uncommitted).getByText('a.ts')).toBeTruthy();
    expect(within(uncommitted).queryByText('b.ts')).toBeNull();
    expect(within(branch).getByText('b.ts')).toBeTruthy();
    expect(within(uncommitted).getByText('M').getAttribute('title')).toBe('Modified');
    expect(within(uncommitted).getByText('+2')).toBeTruthy();

    dirty = false;
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'fix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Branch changes' })).getByText('a.ts')).toBeTruthy());
    expect(within(screen.getByRole('region', { name: 'Uncommitted' })).queryByText('a.ts')).toBeNull();
  });

  it('сессия без worktree — всё в Uncommitted, шапка «master (project folder)» и предупреждение', async () => {
    focus('s-04');
    bridge.setHandler('changes.project', () => project({ files: [file('x.ts'), file('y.ts')] }));
    renderPanel();
    const uncommitted = await screen.findByRole('region', { name: 'Uncommitted' });
    expect(within(uncommitted).getByText('x.ts')).toBeTruthy();
    expect(within(uncommitted).getByText('y.ts')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Branch changes' })).toBeNull();
    expect(screen.getByText('master (project folder)')).toBeTruthy();
    expect(screen.getByText("A commit takes every change in the folder, not only this session's")).toBeTruthy();
  });

  it('клик по файлу — вкладка diff сессии в активной группе и revealFile; клик по коммиту — diff с commit', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ files: [file('src/a.ts')], commits: [COMMIT] }));
    renderPanel();
    fireEvent.click(await screen.findByText('src/a.ts'));
    let layout = useLayoutStore.getState().layouts[KEY];
    expect(groups(layout ?? emptyLayout())[0]?.activeTabId).toBe('diff:s-02');
    expect(Object.values(useReviewStore.getState().revealed)).toEqual([{ path: 'src/a.ts', nonce: 1 }]);

    fireEvent.click(screen.getByText('feat: add a'));
    layout = useLayoutStore.getState().layouts[KEY];
    expect(groups(layout ?? emptyLayout())[0]?.activeTabId).toBe(`diff:s-02:${COMMIT.hash}`);
  });

  it('секция сворачивается заголовком', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ files: [file('b.ts')], commits: [COMMIT] }));
    renderPanel();
    const branch = await screen.findByRole('region', { name: 'Branch changes' });
    const header = within(branch).getByRole('button', { name: /Branch changes/ });
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(within(branch).queryByText('b.ts')).toBeNull();
  });
});

describe('pending (тест 5)', () => {
  it('worktree.createdAt: null → ни worktrees.diff, ни changes.project; текст и кнопка No changes', async () => {
    renderPanel(work([makeSession('s-02', 'two', { worktree: { ...WORKTREE, createdAt: null } })]));
    await flush();
    expect(screen.getByText('The worktree will be created when the session starts')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'No changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(count('worktrees.diff')).toBe(0);
    expect(count('changes.project')).toBe(0);
  });
});

describe('Ошибки в теле (тест 6)', () => {
  it.each([
    ['not-a-repo', 'This folder is not a git repository'],
    ['git-missing', 'Git not found'],
  ])('changes.project с причиной %s → %s; сообщения хоста в DOM нет', async (reason, text) => {
    focus('s-04');
    bridge.setHandler('changes.project', () => {
      throw { code: 'bad_request', message: 'fatal: не найден git репозиторий', data: { reason } };
    });
    renderPanel();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toContain('не найден');
  });
});

describe('Хост без методов 8.1 (тест 7)', () => {
  it('тело Host is outdated — restart, ни одного вызова; клик — подтверждение перезапуска', async () => {
    bridge.setHostMethods([...BASELINE_METHODS]);
    renderPanel();
    await flush();
    const button = screen.getByRole('button', { name: 'Host is outdated — restart' });
    expect(count('worktrees.diff')).toBe(0);
    expect(count('changes.project')).toBe(0);
    fireEvent.click(button);
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
  });
});

describe('Discard worktree… (тест 8)', () => {
  const REF = { projectPath: '/tmp/proj', workId: 'w-a', sessionId: 's-02' };

  async function openDiscard(): Promise<void> {
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Changes options' }), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByText('Discard worktree…'));
  }

  it('первый вопрос называет цену; чистый worktree — discard { force: false } после него; затем состояние worktreeDiscarded', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts')] }));
    renderPanel();
    await screen.findByRole('button', { name: 'Merge into master' });
    await openDiscard();
    expect(within(dialog()).getByText('Discard the worktree of S02?')).toBeTruthy();
    expect(dialog().textContent).toContain('The session will be stopped and closed. Its worktree folder and branch will be deleted.');
    expect(count('worktrees.discard')).toBe(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await flush();
    expect(params('worktrees.discard')).toEqual([{ ref: REF, force: false }]);
    // Перенос: после отбрасывания — своё состояние, а не ошибка git, и больше ни одного diff.
    expect(await screen.findByText('The worktree was discarded')).toBeTruthy();
    const before = count('worktrees.diff');
    await flush();
    expect(count('worktrees.diff')).toBe(before);
  });

  it('при uncommitted — второй вопрос, force: true только после него; отмена второго — вызова нет', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ uncommitted: true, files: [file('a.ts')], uncommittedPaths: ['a.ts'] }));
    renderPanel();
    await screen.findByRole('button', { name: 'Commit' });
    await openDiscard();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await flush();
    expect(within(dialog()).getByText('Uncommitted changes will be lost')).toBeTruthy();
    expect(count('worktrees.discard')).toBe(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(count('worktrees.discard')).toBe(0);

    await openDiscard();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await flush();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard anyway' }));
    await flush();
    expect(params('worktrees.discard')).toEqual([{ ref: REF, force: true }]);
  });

  it('у сессии без worktree и у pending пункта нет; Refresh — есть', async () => {
    focus('s-04');
    renderPanel();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Changes options' }), { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Refresh')).toBeTruthy();
    expect(within(menu).queryByText('Discard worktree…')).toBeNull();
    cleanup();

    focus('s-02');
    renderPanel(work([makeSession('s-02', 'two', { worktree: { ...WORKTREE, createdAt: null } })]));
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Changes options' }), { key: 'Enter' });
    expect(within(screen.getByRole('menu')).queryByText('Discard worktree…')).toBeNull();
  });

  it('хост ответил причиной worktree-missing (перезапуск окна, отброшен не из окна) — worktreeDiscarded, без повторных запросов', async () => {
    bridge.setHandler('worktrees.diff', () => {
      throw { code: 'bad_request', message: 'worktree отсутствует', data: { reason: 'worktree-missing' } };
    });
    renderPanel();
    expect(await screen.findByText('The worktree was discarded')).toBeTruthy();
    expect(screen.queryByText(/Couldn't load changes/)).toBeNull();
    expect(count('worktrees.diff')).toBe(1);
    // Ни событие работы, ни Refresh меню больше не зовут хост: загрузки для этой сессии нет.
    act(() => {
      bridge.emit('works.changed', { entries: [work([makeSession('s-02', 'two!', { worktree: WORKTREE })])], branches: {} });
    });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Changes options' }), { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('Discard worktree…')).toBeNull();
    fireEvent.click(within(menu).getByText('Refresh'));
    await flush();
    expect(count('worktrees.diff')).toBe(1);
    expect(useReviewStore.getState().discarded[refKey(REF)]).toBe(true);
  });

  it('отказ discard — тост Couldn\'t discard worktree: …', async () => {
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT], files: [file('a.ts')] }));
    bridge.setHandler('worktrees.discard', () => {
      throw { code: 'conflict', message: 'грязный' };
    });
    renderPanel();
    await screen.findByRole('button', { name: 'Merge into master' });
    await openDiscard();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await flush();
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/^Couldn't discard worktree: /);
    expect(screen.queryByText('The worktree was discarded')).toBeNull();
  });
});

describe('Шапка (тест 10)', () => {
  const picker = (): HTMLElement => screen.getByRole('combobox', { name: 'Session' });

  it('ветка → база, чип +a −d и число коммитов; длинная ветка — полный текст в title', async () => {
    const long = `harnas/${'b'.repeat(200)}`;
    bridge.setHandler('worktrees.diff', () => diff({ commits: [COMMIT, { ...COMMIT, hash: 'e'.repeat(40) }], files: [file('a.ts')], stats: { additions: 120, deletions: 34 } }));
    renderPanel(work([makeSession('s-02', 'two', { worktree: { ...WORKTREE, branch: long } })]));
    const heading = await screen.findByText(`${long} → master`);
    expect(heading.getAttribute('title')).toBe(`${long} → master`);
    expect(heading.className).toContain('truncate');
    expect(screen.getByText('+120 −34')).toBeTruthy();
    expect(screen.getByText('2 commits')).toBeTruthy();
  });

  it('активна вкладка почты — сессия последней записи entries() этой работы с вкладкой терминала', async () => {
    const mail: TabSpec = { kind: 'mail', id: 'mail' };
    useLayoutStore.setState({
      layouts: { [KEY]: openTab(openTab(openTab(emptyLayout(), term('s-02')), term('s-03')), mail) },
      history: {
        entries: [
          { workKey: KEY, tabId: tabId.terminal('s-02'), at: 1 },
          { workKey: KEY, tabId: tabId.terminal('s-03'), at: 2 },
          { workKey: KEY, tabId: 'mail', at: 3 },
        ],
        index: 2,
      },
    });
    renderPanel();
    await flush();
    expect(picker().textContent).toContain('S03');
    expect(params('worktrees.diff')[0]).toMatchObject({ ref: { sessionId: 's-03' } });
  });

  it('выбор S03 держится, когда фокус ушёл на S02; после смены работы и возврата — снова сессия в фокусе', async () => {
    const unbind = (await import('./store.js')).bindReviewToLayout();
    renderPanel();
    await flush();
    expect(picker().textContent).toContain('S02');
    act(() => useReviewStore.getState().selectChangesSession(KEY, 's-03'));
    expect(picker().textContent).toContain('S03');
    act(() => focus('s-02'));
    expect(picker().textContent).toContain('S03');

    act(() => useLayoutStore.getState().setActiveWork('/tmp/other w-b'));
    act(() => useLayoutStore.getState().setActiveWork(KEY));
    expect(picker().textContent).toContain('S02');
    unbind();
  });

  it('у работы без вкладок сессий — Choose a session to see its changes', async () => {
    useLayoutStore.setState({ layouts: { [KEY]: emptyLayout() } });
    renderPanel();
    await flush();
    expect(screen.getByText('Choose a session to see its changes')).toBeTruthy();
    expect(count('worktrees.diff')).toBe(0);
    expect(count('changes.project')).toBe(0);
  });
});
