import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { PlanItem, RoomPlan, WorkEntry } from '@parley/core';
import { planRemaining } from '@parley/core/plan-state';
import { DecisionCard } from './DecisionCard.js';
import { PlanRemainingView } from './PlanRemainingView.js';
import type { ProposalModel } from './feed-model.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';

afterEach(cleanup);

/** Пункт принятого плана: поля по умолчанию, чтобы тест называл только то, что отличает пункт. */
const itemOf = (id: number, title: string, patch: Partial<PlanItem> = {}): PlanItem => ({
  id,
  title,
  owner: 's-01',
  scope: `src/${title}.ts`,
  after: [],
  criteria: ['Works'],
  verifier: 's-02',
  status: 'waiting',
  evidence: null,
  note: null,
  log: [],
  ...patch,
});

const planOf = (items: PlanItem[], patch: Partial<RoomPlan> = {}): RoomPlan => ({
  id: 'pl-01',
  roomId: 'r-01',
  rev: 2,
  mode: 'verified',
  status: 'active',
  goal: 'Ship safely',
  acceptedAt: 'x',
  completedAt: null,
  cancelledAt: null,
  completionSummary: null,
  backlog: [],
  items,
  ...patch,
});

/** Принятый план: два проверенных пункта, которые останутся, и по одному на каждый другой случай. */
const active = (): RoomPlan =>
  planOf([
    itemOf(1, 'Schema', { status: 'verified' }),
    itemOf(2, 'Api', { status: 'verified', after: [1] }),
    itemOf(3, 'Ui', { status: 'in_progress', after: [1] }),
    itemOf(4, 'Docs', { status: 'done' }),
    itemOf(5, 'Notes', { status: 'verified', after: [3] }),
    itemOf(6, 'Legacy cleanup', { status: 'in_progress' }),
    itemOf(7, 'Old report', { status: 'verified' }),
    itemOf(9, 'Perf', { status: 'in_progress' }),
  ]);

/** Поправка: `Ui` изменён (область), `Notes` зависит от него, `Telemetry` новый, `Legacy cleanup` и `Old report` убраны. */
const amendment = (): RoomPlan =>
  planOf(
    [
      itemOf(1, 'Schema'),
      itemOf(2, 'Api', { after: [1] }),
      itemOf(3, 'Ui', { after: [1], scope: 'src/ui/**' }),
      itemOf(4, 'Docs'),
      itemOf(5, 'Notes', { after: [3] }),
      itemOf(8, 'Telemetry', { after: [2] }),
      itemOf(9, 'Perf'),
    ],
    { rev: 3, status: 'proposed', acceptedAt: null },
  );

const renderView = (proposed = amendment(), activePlan: RoomPlan | undefined = active()) =>
  render(<PlanRemainingView remaining={planRemaining(activePlan, proposed)} plan={proposed} />);

const listed = (container: HTMLElement): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('[data-remaining-item]'));
const itemById = (container: HTMLElement, id: number): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-remaining-item="${id}"]`);
  if (!found) throw new Error(`нет пункта ${id} среди оставшихся`);
  return found;
};

it('поправка: сделанные пункты, что остаются сделанными, не перечисляются, а скрытые посчитаны', () => {
  const { container } = renderView();
  expect(listed(container).map((node) => node.getAttribute('data-remaining-item'))).toEqual(['3', '4', '5', '8', '9']);
  expect(container.querySelector('[data-plan-done-hidden]')?.textContent).toBe('2 done items hidden');
});

it('поправка: один скрытый сделанный пункт — в единственном числе', () => {
  const only = active();
  only.items = only.items.filter((item) => item.id !== 2);
  const draft = amendment();
  draft.items = draft.items.filter((item) => item.id !== 2).map((item) => (item.id === 8 ? { ...item, after: [1] } : item));
  const { container } = renderView(draft, only);
  expect(container.querySelector('[data-plan-done-hidden]')?.textContent).toBe('1 done item hidden');
});

it('поправка: неизменённый in_progress показан как In progress, а не Waiting черновика', () => {
  const { container } = renderView();
  expect(within(itemById(container, 9)).getByText('In progress')).toBeTruthy();
  expect(within(itemById(container, 9)).queryByText('Waiting')).toBeNull();
});

it('поправка: у каждого пункта статус, который будет после принятия, — и done на проверке виден', () => {
  const { container } = renderView();
  expect(within(itemById(container, 3)).getByText('Ready')).toBeTruthy();
  expect(within(itemById(container, 4)).getByText('Done')).toBeTruthy();
  expect(within(itemById(container, 5)).getByText('Waiting')).toBeTruthy();
  expect(within(itemById(container, 8)).getByText('Ready')).toBeTruthy();
});

it('поправка: новый пункт — значок New, изменённый — Changed, проверенный от изменённого — Will be redone, остальные без значка', () => {
  const { container } = renderView();
  expect(within(itemById(container, 8)).getByText('New')).toBeTruthy();
  expect(within(itemById(container, 3)).getByText('Changed')).toBeTruthy();
  expect(within(itemById(container, 5)).getByText('Will be redone')).toBeTruthy();
  expect(itemById(container, 4).querySelector('[data-plan-mark]')).toBeNull();
  expect(itemById(container, 9).querySelector('[data-plan-mark]')).toBeNull();
  expect(itemById(container, 5).querySelector('[data-plan-mark]')?.getAttribute('data-plan-mark')).toBe('redo');
});

it('поправка: убранный незавершённый пункт — одной строкой Removed, убранный сделанный не упомянут', () => {
  const { container } = renderView();
  const removed = container.querySelector('[data-plan-removed]');
  expect(removed?.textContent).toBe('Removed: #6 Legacy cleanup');
  expect(container.textContent).not.toContain('Old report');
});

it('поправка: нечего скрывать и убирать — строк нет', () => {
  const same = active();
  same.items = [itemOf(1, 'Schema', { status: 'in_progress' })];
  const draft = amendment();
  draft.items = [itemOf(1, 'Schema')];
  const { container } = renderView(draft, same);
  expect(container.querySelector('[data-plan-done-hidden]')).toBeNull();
  expect(container.querySelector('[data-plan-removed]')).toBeNull();
});

/** Раскрывает «Show the full plan»: черновик монтируется только открытым. */
const openFull = async (container: HTMLElement): Promise<HTMLDetailsElement> => {
  const full = container.querySelector<HTMLDetailsElement>('details[data-plan-full]')!;
  fireEvent.click(within(full).getByText('Show the full plan'));
  await waitFor(() => expect(full.querySelector('[data-plan-summary]')).not.toBeNull());
  return full;
};

it('поправка: шапка — цель, режим и ревизия; полный план лежит под раскрытием и закрытым не монтируется', async () => {
  const { container } = renderView();
  const header = container.querySelector('[data-plan-remaining-header]');
  expect(header?.textContent).toContain('Ship safely');
  expect(header?.textContent).toContain('Verified');
  expect(header?.textContent).toContain('Revision 3');
  const full = container.querySelector<HTMLDetailsElement>('details[data-plan-full]');
  expect(full).not.toBeNull();
  expect(full!.open).toBe(false);
  expect(within(full!).getByText('Show the full plan')).toBeTruthy();
  // Закрытым черновик не рисуется: цель на карточке одна, пунктов вне списка оставшихся нет.
  expect(full!.querySelector('[data-plan-summary]')).toBeNull();
  expect(within(container).getAllByText('Ship safely')).toHaveLength(1);
  // Раскрытие — весь черновик: и сделанные, и убранные из списка оставшихся пункты.
  await openFull(container);
  expect(full!.querySelectorAll('[data-plan-item]')).toHaveLength(7);
});

it('длинные названия пунктов (200+ знаков) переносятся и не режутся — и в пункте, и в строке Removed', () => {
  const long = 'Очень-длинное-название-без-пробелов-'.repeat(8);
  const english = 'long title '.repeat(25).trim();
  const base = active();
  base.items.push(itemOf(10, long, { status: 'in_progress' }));
  const draft = amendment();
  draft.items.push(itemOf(11, english));
  const { container } = renderView(draft, base);
  const title = itemById(container, 11).querySelector('[data-plan-item-title]')!;
  expect(title.textContent).toBe(`11. ${english}`);
  expect(title.className).toContain('break-words');
  const removed = container.querySelector('[data-plan-removed]')!;
  expect(removed.textContent).toContain(`#10 ${long}`);
  expect(removed.className).toContain('break-words');
  expect(container.querySelector('[data-plan-remaining]')!.className).toContain('min-w-0');
});

const decisionEntry = (plans: RoomPlan[] | undefined): WorkEntry => {
  const entry = makeWork('w-01', {
    projectPath: '/tmp/one',
    sessions: [makeSession('s-01', 'Builder'), makeSession('s-02', 'Checker')],
    rooms: [{ ...makeRoom('r-01', 'Delivery'), mode: 'verified', members: ['s-01', 's-02'], lead: 's-01' }],
  });
  if (plans) entry.map.plans = plans;
  return entry;
};

const proposalOf = (plan: RoomPlan): ProposalModel => ({
  kind: 'decision',
  plan,
  planId: plan.id,
  planRev: plan.rev,
  id: 'p-01',
  rev: 0,
  at: '2026-10-19T09:00:00.000Z',
  text: 'Only the UI changes.',
  from: 'S01 Builder',
  provider: 'claude',
});

const renderCard = (proposal: ProposalModel, entry: WorkEntry) =>
  render(
    <DecisionCard
      proposal={proposal}
      time="1m"
      labelOf={(id) => id}
      onOpenExternal={vi.fn()}
      canResolve
      onResolve={async () => true}
      onLayout={vi.fn()}
      entry={entry}
    />,
  );

it('карточка: у поправки к активному плану с тем же id — только несделанное, полный план под раскрытием', async () => {
  const { container } = renderCard(proposalOf(amendment()), decisionEntry([active()]));
  expect(container.querySelector('[data-plan-remaining]')).not.toBeNull();
  expect(listed(container).map((node) => node.getAttribute('data-remaining-item'))).toEqual(['3', '4', '5', '8', '9']);
  // `PlanSummary` появляется только внутри раскрытия.
  expect(container.querySelectorAll('[data-plan-summary]')).toHaveLength(0);
  await openFull(container);
  const summaries = container.querySelectorAll('[data-plan-summary]');
  expect(summaries).toHaveLength(1);
  expect(summaries[0]!.closest('details[data-plan-full]')).not.toBeNull();
});

it('карточка: поправка в плане на проверке (completing) тоже показывает только несделанное', () => {
  const completing = active();
  completing.status = 'completing';
  const { container } = renderCard(proposalOf(amendment()), decisionEntry([completing]));
  expect(container.querySelector('[data-plan-remaining]')).not.toBeNull();
});

it('карточка: первый план комнаты — как раньше, через PlanSummary', () => {
  const first = planOf([itemOf(1, 'Schema'), itemOf(2, 'Api', { after: [1] })], { rev: 0, status: 'proposed', acceptedAt: null });
  const { container } = renderCard(proposalOf(first), decisionEntry(undefined));
  expect(container.querySelector('[data-plan-remaining]')).toBeNull();
  expect(container.querySelector('[data-plan-done-hidden]')).toBeNull();
  const summary = container.querySelector('[data-plan-summary]');
  expect(summary).not.toBeNull();
  expect(summary!.closest('details')).toBeNull();
  expect(container.querySelectorAll('[data-plan-item]')).toHaveLength(2);
});

it('карточка: активный план другой комнаты или с другим id — не поправка, как раньше', () => {
  const otherRoom = active();
  otherRoom.roomId = 'r-99';
  const otherId = active();
  otherId.id = 'pl-02';
  otherId.status = 'completed';
  const { container } = renderCard(proposalOf(amendment()), decisionEntry([otherRoom, otherId]));
  expect(container.querySelector('[data-plan-remaining]')).toBeNull();
  expect(container.querySelector('[data-plan-summary]')).not.toBeNull();
});

it('карточка: закрытый (completed) план с тем же id не считается активным', () => {
  const closed = active();
  closed.status = 'completed';
  const { container } = renderCard(proposalOf(amendment()), decisionEntry([closed]));
  expect(container.querySelector('[data-plan-remaining]')).toBeNull();
});

it('карточка: без снимка работ (entry не передан) — как раньше', () => {
  const { container } = render(
    <DecisionCard
      proposal={proposalOf(amendment())}
      time="1m"
      labelOf={(id) => id}
      onOpenExternal={vi.fn()}
      canResolve
      onResolve={async () => true}
      onLayout={vi.fn()}
    />,
  );
  expect(container.querySelector('[data-plan-remaining]')).toBeNull();
  expect(container.querySelector('[data-plan-summary]')).not.toBeNull();
});
