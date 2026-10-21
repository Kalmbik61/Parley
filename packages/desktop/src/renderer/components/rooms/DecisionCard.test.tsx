import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DecisionCard, decisionDraftKey, type DecisionCardProps } from './DecisionCard.js';
import { useUiStore } from '../../store/ui.js';
import { S } from '../../../shared/strings.js';

const proposal = (id: string, rev = 1): DecisionCardProps['proposal'] => ({
  id,
  rev,
  kind: 'decision',
  at: 'x',
  text: 'Ship it',
  from: 'Lead',
  provider: 'claude',
});

const props = (over: Partial<DecisionCardProps> = {}): DecisionCardProps => ({
  proposal: proposal('p-01'),
  time: 'now',
  labelOf: () => null,
  onOpenExternal: vi.fn(),
  canResolve: true,
  onResolve: vi.fn(async () => true),
  onLayout: vi.fn(),
  ...over,
});

const noteField = (): HTMLTextAreaElement => screen.getByPlaceholderText(S.rooms.returnPlaceholder) as HTMLTextAreaElement;
const openForm = (): void => {
  fireEvent.click(screen.getByRole('button', { name: S.rooms.returnForRework }));
};

beforeEach(() => {
  useUiStore.setState({ decisionDrafts: {} });
});
afterEach(cleanup);

it('с draftKey форма и заметка переживают размонтирование', () => {
  const first = render(<DecisionCard {...props({ draftKey: 'w/r-01' })} />);
  openForm();
  fireEvent.change(noteField(), { target: { value: 'rework this' } });
  first.unmount();
  render(<DecisionCard {...props({ draftKey: 'w/r-01' })} />);
  expect(noteField().value).toBe('rework this');
});

it('Cancel закрывает форму, но заметка остаётся для повторного открытия', () => {
  render(<DecisionCard {...props({ draftKey: 'w/r-01' })} />);
  openForm();
  fireEvent.change(noteField(), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: S.common.cancel }));
  expect(screen.queryByPlaceholderText(S.rooms.returnPlaceholder)).toBeNull();
  openForm();
  expect(noteField().value).toBe('keep me');
});

it('успешный ответ чистит запись в сторе', async () => {
  const onResolve = vi.fn(async () => true);
  render(<DecisionCard {...props({ draftKey: 'w/r-01', onResolve })} />);
  openForm();
  fireEvent.change(noteField(), { target: { value: 'note' } });
  expect(Object.keys(useUiStore.getState().decisionDrafts)).toEqual([decisionDraftKey('w/r-01', 'p-01')]);
  fireEvent.click(screen.getByRole('button', { name: S.rooms.sendToLead }));
  await waitFor(() => expect(useUiStore.getState().decisionDrafts).toEqual({}));
  expect(onResolve).toHaveBeenCalledWith('return', 'note');
});

it('отказ хоста оставляет заметку в сторе', async () => {
  const onResolve = vi.fn(async () => false);
  render(<DecisionCard {...props({ draftKey: 'w/r-01', onResolve })} />);
  openForm();
  fireEvent.change(noteField(), { target: { value: 'note' } });
  fireEvent.click(screen.getByRole('button', { name: S.rooms.sendToLead }));
  await waitFor(() => expect(onResolve).toHaveBeenCalled());
  expect(useUiStore.getState().decisionDrafts[decisionDraftKey('w/r-01', 'p-01')]).toEqual({ open: true, note: 'note' });
});

it('у разных решений заметки не общие, новый rev того же решения заметку держит', () => {
  const view = render(<DecisionCard {...props({ draftKey: 'w/r-01' })} />);
  openForm();
  fireEvent.change(noteField(), { target: { value: 'first' } });
  view.rerender(<DecisionCard {...props({ draftKey: 'w/r-01', proposal: proposal('p-01', 2) })} />);
  expect(noteField().value).toBe('first');
  view.unmount();
  render(<DecisionCard {...props({ draftKey: 'w/r-01', proposal: proposal('p-02') })} />);
  expect(screen.queryByPlaceholderText(S.rooms.returnPlaceholder)).toBeNull();
});

it('без draftKey состояние локальное и стор не трогается', () => {
  const first = render(<DecisionCard {...props()} />);
  openForm();
  fireEvent.change(noteField(), { target: { value: 'local' } });
  expect(noteField().value).toBe('local');
  expect(useUiStore.getState().decisionDrafts).toEqual({});
  first.unmount();
  render(<DecisionCard {...props()} />);
  expect(screen.queryByPlaceholderText(S.rooms.returnPlaceholder)).toBeNull();
});
