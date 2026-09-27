/**
 * Тесты 3, 4, 5 куска 4.3 плана worktree:
 * 3. «Влить» неактивна при `baseDirty` и при `uncommitted`, подсказка называет причину.
 * 4. «Поручить агенту» шлёт письмо с именами файлов.
 * 5. «Отбросить» грязного worktree требует двух подтверждений и шлёт `force: true`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorktreeDiff } from '@harnas/core';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { ChangesPanel } from './ChangesPanel.js';

afterEach(cleanup);

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-02' };

function baseDiff(overrides: Partial<WorktreeDiff> = {}): WorktreeDiff {
  return {
    patch: '',
    files: [{ path: 'a.ts', status: 'M' }],
    uncommitted: false,
    baseCheckout: '/tmp/proj',
    baseDirty: false,
    ...overrides,
  };
}

describe('ChangesPanel — тест 3: «Влить» неактивна с причиной', () => {
  it('baseDirty — кнопка неактивна, подсказка называет базу', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff({ baseDirty: true }));
    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);

    const button = (await screen.findByText('Merge into main')).closest('button');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toMatch(/Base is dirty/);
  });

  it('uncommitted — кнопка неактивна, подсказка называет незакоммиченное', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff({ uncommitted: true }));
    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);

    const button = (await screen.findByText('Merge into main')).closest('button');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toMatch(/uncommitted/);
  });

  it('ни baseDirty, ни uncommitted — кнопка активна', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff());
    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);

    const button = (await screen.findByText('Merge into main')).closest('button');
    expect(button?.disabled).toBe(false);
  });
});

describe('ChangesPanel — тест 4: «Поручить агенту»', () => {
  it('конфликт слияния — «Поручить агенту» шлёт rooms.send с именами файлов', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff());
    bridge.setHandler('worktrees.merge', async () => ({
      ok: false,
      reason: 'conflict',
      files: ['a.ts', 'b.ts'],
    }));
    bridge.setHandler('rooms.send', async () => ({ messageId: 'm-01' }));

    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);

    fireEvent.click(await screen.findByText('Merge into main'));
    fireEvent.click(await screen.findByText('Assign to agent'));

    const sent = await screen.findByText('Message sent');
    expect(sent).toBeTruthy();

    const call = bridge.calls.find((item) => item.method === 'rooms.send');
    expect(call?.params).toMatchObject({
      projectPath: ref.projectPath,
      workId: ref.workId,
      roomId: null,
      to: [ref.sessionId],
      kind: 'question',
    });
    const text = (call?.params as { text: string }).text;
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('S02');
  });
});

describe('ChangesPanel — тест 5: «Отбросить» грязного worktree', () => {
  it('два подтверждения, второе шлёт force: true', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff({ uncommitted: true }));
    bridge.setHandler('worktrees.discard', async () => ({ ok: true as const }));

    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);
    await screen.findByText('Merge into main');

    fireEvent.click(screen.getByText('Discard'));
    expect(await screen.findByText('Discard "S02"?')).toBeTruthy();

    // Первое подтверждение у грязного worktree не отбрасывает сразу — открывает второе.
    fireEvent.click(screen.getAllByText('Discard')[1] as HTMLElement);
    expect(bridge.calls.some((item) => item.method === 'worktrees.discard')).toBe(false);

    expect(await screen.findByText('Uncommitted changes will be lost')).toBeTruthy();
    fireEvent.click(screen.getByText('Discard anyway'));

    const call = bridge.calls.find((item) => item.method === 'worktrees.discard');
    expect(call?.params).toMatchObject({ ref, force: true });
  });

  it('чистый worktree — одно подтверждение, force: false', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff({ uncommitted: false }));
    bridge.setHandler('worktrees.discard', async () => ({ ok: true as const }));

    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);
    await screen.findByText('Merge into main');

    fireEvent.click(screen.getByText('Discard'));
    expect(await screen.findByText('Discard "S02"?')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Discard')[1] as HTMLElement);

    const call = bridge.calls.find((item) => item.method === 'worktrees.discard');
    expect(call?.params).toMatchObject({ ref, force: false });
  });
});

describe('ChangesPanel — раунд исправлений 1 куска 1.4 (ревью B, находка «текст destructive-кнопки нечитаем в тёмной теме»)', () => {
  it('«Отбросить» — белый текст на destructive, в тёмной теме заливка на 60% прозрачности (тот же приём, что ui/button variant="destructive")', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('worktrees.diff', async () => baseDiff());
    render(<ChangesPanel bridge={bridge} sessionRef={ref} base="main" />);

    const discard = await screen.findByText('Discard');
    expect(discard.className).toContain('text-white');
    expect(discard.className).toContain('dark:bg-destructive/60');
    expect(discard.className).not.toContain('text-destructive-foreground');
  });
});
