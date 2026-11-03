import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useBoardStore } from '../board/board-store.js';
import { BoardNavItem } from './BoardNavItem.js';

const snapshot = (states: Array<'backlog' | 'review'>): BacklogSnapshot =>
  ({
    projectPath: '/p', sharedProjectPath: '/p', version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
    diagnostics: [], suggestions: [],
    items: states.map((state, index) => ({ id: `b-00${index + 1}`, title: `Item ${index}`, details: '', checked: false, section: null, state })),
  }) as unknown as BacklogSnapshot;

const setBoard = (states: Array<'backlog' | 'review'>, supported = true): void => {
  useBoardStore.setState({
    supported,
    inboxPath: null,
    filter: { kind: 'all' },
    slots: new Map([['/p', { snapshot: snapshot(states), live: true }]]),
  });
};

beforeEach(() => {
  useBoardStore.setState({ supported: false, slots: new Map(), inboxPath: null, filter: { kind: 'all' } });
});
afterEach(cleanup);

it('пункт Board показывает число Review и открывает доску', () => {
  setBoard(['review', 'backlog', 'review']);
  const onOpen = vi.fn();
  render(<BoardNavItem onOpen={onOpen} className="row" />);
  const badge = screen.getByLabelText(S.board.reviewWaiting(2));
  expect(badge.textContent).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(S.board.title) }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('нет карточек в Review — нет бейджа', () => {
  setBoard(['backlog']);
  render(<BoardNavItem onOpen={() => {}} className="row" />);
  expect(screen.getByText(S.board.title)).toBeTruthy();
  expect(screen.queryByLabelText(S.board.reviewWaiting(1))).toBeNull();
});

it('хост без доски — пункт есть, бейджа нет', () => {
  setBoard(['review'], false);
  render(<BoardNavItem onOpen={() => {}} className="row" />);
  expect(screen.getByText(S.board.title)).toBeTruthy();
  expect(screen.queryByLabelText(S.board.reviewWaiting(1))).toBeNull();
});
