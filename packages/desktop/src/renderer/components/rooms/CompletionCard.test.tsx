import { autonomousPlan } from '../../test-utils/autonomous-plan.js';
import { useHostStore } from '../../store/host.js';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RoomPlan } from "@parley/core";
import { CompletionCard } from "./CompletionCard.js";
import { createFakeBridge } from "../../test-utils/fake-bridge.js";
import { makeWork } from "../../test-utils/work-fixtures.js";
import { useUiStore } from "../../store/ui.js";
const plan: RoomPlan = {
  id: "pl-01",
  roomId: "r-01",
  rev: 4,
  mode: "verified",
  status: "completing",
  goal: "Release",
  items: [
    {
      id: 1,
      title: "Recovery",
      owner: "s-01",
      scope: "plain @skill text",
      after: [],
      criteria: ["Restart"],
      verifier: "human",
      status: "verified",
      evidence: { text: "Passed", artifacts: [] },
      note: "Checked",
      log: [],
    },
  ],
  backlog: [],
  acceptedAt: "x",
  completedAt: null,
  cancelledAt: null,
  completionSummary: "Done",
};
const props = () => ({
  plan,
  entry: makeWork("w-01"),
  bridge: createFakeBridge(),
  proposal: {
    id: "p-01",
    rev: 1,
    kind: "completion" as const,
    planId: "pl-01",
    planRev: 4,
    at: "x",
    text: "Ready to ship",
    from: "Lead",
    provider: "claude",
  },
  time: "now",
  labelOf: () => null,
  onOpenExternal: vi.fn(),
  canResolve: true,
  onResolve: vi.fn(async () => true),
  onLayout: vi.fn(),
});
afterEach(cleanup);

// Форма «Return for rework» живёт в decisionDrafts окна — между тестами её сбрасываем.
beforeEach(() => {
  useUiStore.setState({ decisionDrafts: {} });
});
it("shows current verified evidence and accepts once; Return remains a human proposal response", async () => {
  const p = props();
  render(<CompletionCard {...p} />);
  expect(screen.getByText("1/1 verified")).toBeTruthy();
  expect(screen.getByText("Passed")).toBeTruthy();
  fireEvent.click(screen.getByText("Accept"));
  fireEvent.click(screen.getByText("Accept"));
  await waitFor(() => expect(p.onResolve).toHaveBeenCalledTimes(1));
  expect(p.onResolve).toHaveBeenCalledWith("accept", "");
});
it("keeps Return note on conflict and disables accepting a completion whose plan revision no longer matches", async () => {
  const p = props();
  p.onResolve.mockResolvedValue(false);
  const view = render(<CompletionCard {...p} />);
  fireEvent.click(screen.getByText("Return for rework"));
  fireEvent.change(screen.getByLabelText("What should the lead change?"), {
    target: { value: "One more recovery test" },
  });
  fireEvent.click(screen.getByText("Send to lead"));
  await waitFor(() =>
    expect(p.onResolve).toHaveBeenCalledWith(
      "return",
      "One more recovery test",
    ),
  );
  expect(
    (
      screen.getByLabelText(
        "What should the lead change?",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("One more recovery test");
  view.rerender(<CompletionCard {...p} plan={{ ...plan, rev: 5 }} />);
  expect((screen.getByText("Send to lead") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    screen.getByText(
      "The plan changed. Review the current revision and try again.",
    ),
  ).toBeTruthy();
});

it("freezes a completion Return note while the submitted response is pending", async () => {
  const p = props();
  let finish!: (value: boolean) => void;
  p.onResolve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<CompletionCard {...p} />);
  fireEvent.click(screen.getByText("Return for rework"));
  const field = screen.getByLabelText("What should the lead change?");
  fireEvent.change(field, { target: { value: "Captured return note" } });
  fireEvent.click(screen.getByText("Send to lead"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(field).toHaveProperty("disabled", true);
  fireEvent.change(field, { target: { value: "Unsaved pending edit" } });
  expect(field).toHaveProperty("value", "Captured return note");
  await act(async () => finish(false));
  expect(field).toHaveProperty("disabled", false);
  expect(field).toHaveProperty("value", "Captured return note");
});

it('returns a selected autonomous item through plans.verify and never generic return', async () => {
  useHostStore.setState({ connections: 1, status: { state: 'connected', hostVersion: 'test', methods: ['plans.verify'] } });
  const p = props(); p.plan = { ...plan, mode: 'autonomous', autonomous: autonomousPlan() };
  p.bridge.setHandler('plans.verify', () => ({ messageId: null, effects: { queued: 0, pendingSnapshots: 0, pendingBacklog: 0, conflictCount: 0, conflicts: [] } }));
  render(<CompletionCard {...p} />);
  fireEvent.click(screen.getByText('Return for rework'));
  expect(screen.getByLabelText('Item to return')).toBeTruthy();
  expect((screen.getByText('Send to lead') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Item to return'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('What should the lead change?'), { target: { value: 'Late recovery failure' } });
  fireEvent.click(screen.getByText('Send to lead'));
  await waitFor(() => expect(p.bridge.calls).toHaveLength(1));
  expect(p.bridge.calls[0]).toMatchObject({ method: 'plans.verify', params: { projectPath: p.entry.projectPath, workId: 'w-01', planId: 'pl-01', rev: 4, item: 1, verdict: 'returned', note: 'Late recovery failure' } });
  expect(p.onResolve).not.toHaveBeenCalled();
});

it('keeps an autonomous item selection and note when the host rejects return', async () => {
  useHostStore.setState({ connections: 1, status: { state: 'connected', hostVersion: 'test', methods: ['plans.verify'] } });
  const p = props(); p.plan = { ...plan, mode: 'autonomous', autonomous: autonomousPlan() };
  const message = 'autonomous-completion-needs-item: select an item to return';
  p.bridge.setHandler('plans.verify', () => { throw { code: 'bad_request', message }; });
  render(<CompletionCard {...p} />);
  fireEvent.click(screen.getByText('Return for rework'));
  fireEvent.change(screen.getByLabelText('Item to return'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('What should the lead change?'), { target: { value: 'Keep this note' } });
  fireEvent.click(screen.getByText('Send to lead'));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByLabelText('Item to return')).toHaveProperty('value', '1');
  expect(screen.getByLabelText('What should the lead change?')).toHaveProperty('value', 'Keep this note');
  expect(p.onResolve).not.toHaveBeenCalled();
});
it('disables autonomous Return if the host does not advertise plans.verify', () => {
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'old', methods: [] } });
  const p = props(); p.plan = { ...plan, mode: 'autonomous', autonomous: autonomousPlan() };
  render(<CompletionCard {...p} />);
  expect(screen.getByText('Return for rework')).toHaveProperty('disabled', true);
});
