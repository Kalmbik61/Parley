import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { boardProjects } from './board-model.js';
import type { BoardSlot } from './board-store.js';
import { useBoardStore } from './board-store.js';
import { SuggestedStrip } from './SuggestedStrip.js';

const snap = (suggestions: BacklogSnapshot['suggestions']): BacklogSnapshot => ({
  projectPath: '/p', sharedProjectPath: '/p', version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'ask',
  diagnostics: [], suggestions, items: [],
});
const suggestion = { id: 's-001', title: 'Add retries', details: 'with backoff', why: 'Flaky network', workId: 'w-01', sessionId: 's-02' } as BacklogSnapshot['suggestions'][number];
const call = vi.fn();
const bridge = { call, on: vi.fn() };
const projects = () => boardProjects(new Map<string, BoardSlot>([['/p', { snapshot: snap([suggestion]), live: true }]]), null);

beforeEach(() => {
  useBoardStore.setState({ supported: true, slots: new Map([['/p', { snapshot: snap([suggestion]), live: true }]]), inboxPath: null, filter: { kind: 'all' } });
  call.mockReset();
  call.mockResolvedValue(snap([]));
});
afterEach(() => cleanup());

describe('SuggestedStrip', () => {
  it('показывает проект, текст, причину и автора', () => {
    render(<SuggestedStrip bridge={bridge} projects={projects()} />);
    expect(screen.getByText(S.backlog.suggested(1))).toBeTruthy();
    expect(screen.getByText('Add retries')).toBeTruthy();
    expect(screen.getByText('Flaky network')).toBeTruthy();
    expect(screen.getByText('w-01/s-02')).toBeTruthy();
  });

  it('без предложений — ничего', () => {
    const { container } = render(<SuggestedStrip bridge={bridge} projects={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('Add — accept с id', async () => {
    render(<SuggestedStrip bridge={bridge} projects={projects()} />);
    fireEvent.click(screen.getByRole('button', { name: S.backlog.add }));
    await waitFor(() => expect(useBoardStore.getState().slots.get('/p')!.snapshot!.suggestions).toHaveLength(0));
    expect(call).toHaveBeenCalledWith('backlog.suggestions.accept', { projectPath: '/p', id: 's-001' });
  });

  it('Edit & add — accept с правленым title и details', async () => {
    render(<SuggestedStrip bridge={bridge} projects={projects()} />);
    fireEvent.click(screen.getByRole('button', { name: S.backlog.editAdd }));
    fireEvent.change(screen.getByLabelText(S.backlog.titleField), { target: { value: 'Add retries v2' } });
    fireEvent.change(screen.getByLabelText(S.backlog.details), { target: { value: 'jitter' } });
    fireEvent.click(screen.getByRole('button', { name: S.backlog.add }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('backlog.suggestions.accept', { projectPath: '/p', id: 's-001', title: 'Add retries v2', details: 'jitter' });
  });

  it('Dismiss — dismiss с id', async () => {
    render(<SuggestedStrip bridge={bridge} projects={projects()} />);
    fireEvent.click(screen.getByRole('button', { name: S.backlog.dismiss }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('backlog.suggestions.dismiss', { projectPath: '/p', id: 's-001' });
  });
});
