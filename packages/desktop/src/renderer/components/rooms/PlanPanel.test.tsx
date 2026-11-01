import { autonomousPlan } from '../../test-utils/autonomous-plan.js';
import { MODES } from '../dialogs/agent-rows.js';
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { RoomPlan, WindowWorkEntry } from "@parley/core";
import { PlanPanel, RoomModeControl, ownerLabel } from "./PlanPanel.js";
import { useHostStore } from "../../store/host.js";
import { createFakeBridge } from "../../test-utils/fake-bridge.js";
import {
  makeRoom,
  makeSession,
  makeWork,
} from "../../test-utils/work-fixtures.js";
const methods = [
  "plans.submit",
  "plans.verify",
  "plans.cancel",
  "plans.update",
  "plans.retryEffects",
  "rooms.setMode",
];
const planOf = (patch: Partial<RoomPlan> = {}): RoomPlan => ({
  id: "pl-01",
  roomId: "r-01",
  rev: 2,
  mode: "verified",
  status: "active",
  goal: "Ship safely",
  acceptedAt: "x",
  completedAt: null,
  cancelledAt: null,
  completionSummary: null,
  backlog: [],
  items: [
    {
      id: 1,
      title: "Test recovery",
      owner: "s-01",
      scope: "src/skills/**/*.ts",
      after: [],
      criteria: ["Restarts preserve state"],
      verifier: "human",
      status: "done",
      evidence: { text: "Restart passed", artifacts: ["../report.txt"] },
      note: null,
      log: [],
    },
  ],
  ...patch,
});
const entryOf = (plan = planOf()): WindowWorkEntry => {
  const entry = makeWork("w-01", {
    projectPath: "/tmp/one",
    sessions: [makeSession("s-01", "Builder")],
    rooms: [
      {
        ...makeRoom("r-01", "Delivery"),
        mode: plan.mode,
        members: ["s-01"],
        lead: "s-01",
      },
    ],
  });
  entry.map.plans = [plan];
  return entry;
};
const result = {
  messageId: null,
  effects: {
    queued: 0,
    pendingSnapshots: 0,
    pendingBacklog: 0,
    conflictCount: 0,
    conflicts: [],
  },
};
beforeEach(() =>
  useHostStore.setState({
    connections: 1,
    status: { state: "connected", hostVersion: "test", methods },
  }),
);
afterEach(cleanup);
it("returns an item, preserves the reason on conflict, and resubmits then verifies the current revision", async () => {
  const bridge = createFakeBridge();
  const entry = entryOf();
  bridge.setHandler("plans.verify", () => {
    throw { code: "conflict", message: "fixture" };
  });
  const view = render(
    <PlanPanel entry={entry} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.click(screen.getByText("Return item"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Missing restart case" },
  });
  fireEvent.click(screen.getByText("Confirm return"));
  await screen.findByText(
    "The plan changed. Review the current revision and try again.",
  );
  expect(
    (screen.getByLabelText("Verification note") as HTMLTextAreaElement).value,
  ).toBe("Missing restart case");
  bridge.setHandler("plans.verify", () => result);
  fireEvent.click(screen.getByText("Confirm return"));
  await waitFor(() =>
    expect(screen.queryByLabelText("Verification note")).toBeNull(),
  );
  const returned = planOf({ rev: 3 });
  returned.items[0]!.status = "returned";
  const next = entryOf(returned);
  view.rerender(<PlanPanel entry={next} roomId="r-01" bridge={bridge} />);
  bridge.setHandler("plans.submit", () => result);
  fireEvent.click(screen.getByText("Submit evidence"));
  fireEvent.change(screen.getByLabelText("Evidence"), {
    target: { value: "Restart verified again" },
  });
  fireEvent.click(screen.getByText("Confirm submission"));
  await waitFor(() => expect(screen.queryByLabelText("Evidence")).toBeNull());
  expect(
    bridge.calls.filter((c) => c.method === "plans.submit").at(-1)?.params,
  ).toMatchObject({
    planId: "pl-01",
    rev: 3,
    item: 1,
    evidence: { text: "Restart verified again", artifacts: [] },
  });
  const done = planOf({ rev: 3 });
  view.rerender(
    <PlanPanel entry={entryOf(done)} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.click(screen.getByText("Verify item"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Independent restart passed" },
  });
  fireEvent.click(screen.getByText("Confirm verification"));
  await waitFor(() =>
    expect(screen.queryByLabelText("Verification note")).toBeNull(),
  );
});
it("Checklist Done submits evidence and never invents verification for accepted Checklist basis", async () => {
  const plan = planOf({ mode: "checklist" });
  plan.items[0]!.status = "ready";
  const bridge = createFakeBridge();
  bridge.setHandler("plans.submit", () => result);
  const view = render(
    <PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.click(screen.getByText("Mark done"));
  fireEvent.change(screen.getByLabelText("Evidence"), {
    target: { value: "Checked manually" },
  });
  fireEvent.click(screen.getByText("Confirm submission"));
  await waitFor(() =>
    expect(bridge.calls.some((c) => c.method === "plans.submit")).toBe(true),
  );
  const promoted = planOf();
  promoted.items[0]!.acceptedChecklistRevision = 1;
  view.rerender(
    <PlanPanel entry={entryOf(promoted)} roomId="r-01" bridge={bridge} />,
  );
  expect(
    screen.getByText("Done in Checklist · human accepted revision 1"),
  ).toBeTruthy();
  expect(
    screen.getByText("0/1 verified · 1 accepted from Checklist"),
  ).toBeTruthy();
});
it("disables old-host actions and preserves forms when a late reply belongs to another connection", async () => {
  const bridge = createFakeBridge();
  let finish!: (value: typeof result) => void;
  bridge.setHandler(
    "plans.verify",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const entry = entryOf();
  const view = render(
    <PlanPanel entry={entry} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.click(screen.getByText("Verify item"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Keep my note" },
  });
  fireEvent.click(screen.getByText("Confirm verification"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => useHostStore.setState({ connections: 2 }));
  await act(async () => finish(result));
  expect(
    (screen.getByLabelText("Verification note") as HTMLTextAreaElement).value,
  ).toBe("Keep my note");
  act(() =>
    useHostStore.setState({
      status: { state: "connected", hostVersion: "old", methods: [] },
    }),
  );
  view.rerender(<PlanPanel entry={entry} roomId="r-01" bridge={bridge} />);
  expect(
    (screen.getByText("Confirm verification") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Update or restart the host to use plan actions."),
  ).toBeTruthy();
});
it("mode downgrade and active-plan cancellation require explicit reason and confirmation", async () => {
  const entry = entryOf();
  const bridge = createFakeBridge();
  bridge.setHandler("rooms.setMode", () => result);
  const view = render(
    <RoomModeControl entry={entry} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.change(screen.getByLabelText("Room mode"), {
    target: { value: "checklist" },
  });
  expect(bridge.calls).toHaveLength(0);
  expect(
    screen.getByText("Lowering the mode removes verification requirements."),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Reason for mode change"), {
    target: { value: "Human review outside room" },
  });
  fireEvent.click(screen.getByText("Confirm mode change"));
  await waitFor(() => expect(bridge.calls).toHaveLength(1));
  expect(bridge.calls[0]?.params).toMatchObject({
    mode: "checklist",
    reason: "Human review outside room",
  });
  view.rerender(
    <RoomModeControl entry={entry} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.change(screen.getByLabelText("Room mode"), {
    target: { value: "free" },
  });
  expect(
    screen.getByText("Switching to Free cancels the active plan."),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Reason for mode change"), {
    target: { value: "Stop this plan" },
  });
  fireEvent.click(screen.getByText("Confirm mode change"));
  await waitFor(() => expect(bridge.calls).toHaveLength(2));
  expect(bridge.calls[1]?.params).toMatchObject({
    mode: "free",
    confirmCancel: true,
  });
});
it("shows captured pending exports and deliveries independently without displaying captured Markdown", () => {
  const entry = entryOf();
  entry.map.planExports = [
    {
      file: "captured.md",
      planId: "pl-01",
      rev: 1,
      event: "accepted",
      content: "PRIVATE_CAPTURE",
      status: "pending",
    },
  ];
  entry.map.planEffects = [
    {
      key: "x",
      roomId: "r-01",
      planId: "pl-01",
      rev: 1,
      item: 1,
      kind: "ready",
      occurrence: "x",
      target: "s-01",
      text: "private",
      createdAt: "x",
      status: "queued",
      messageId: null,
    },
  ];
  entry.map.planBacklogIntents = [
    {
      key: "b",
      planId: "pl-01",
      rev: 1,
      backlogId: "b-001",
      completedAt: "x",
      status: "conflict",
      code: "backlog-conflict",
    },
  ];
  render(<PlanPanel entry={entry} roomId="r-01" bridge={createFakeBridge()} />);
  expect(
    screen.getByText(
      "1 queued · 1 pending snapshot · 0 pending backlog · 1 conflict",
    ),
  ).toBeTruthy();
  expect(screen.getByText("accepted · revision 1 · pending")).toBeTruthy();
  expect(screen.queryByText("PRIVATE_CAPTURE")).toBeNull();
  expect(screen.getByText("../report.txt")).toBeTruthy();
});
it("a revision change during verification retains the note and a deliberate retry uses the new revision", async () => {
  const bridge = createFakeBridge();
  let reject!: (error: unknown) => void;
  bridge.setHandler(
    "plans.verify",
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const view = render(
    <PlanPanel entry={entryOf()} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.click(screen.getByText("Verify item"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Reviewed recovery" },
  });
  fireEvent.click(screen.getByText("Confirm verification"));
  await waitFor(() => expect(reject).toBeTypeOf("function"));
  view.rerender(
    <PlanPanel
      entry={entryOf(planOf({ rev: 3 }))}
      roomId="r-01"
      bridge={bridge}
    />,
  );
  await act(async () =>
    reject({ code: "conflict", message: "PRIVATE_RAW_ERROR" }),
  );
  expect(
    (screen.getByLabelText("Verification note") as HTMLTextAreaElement).value,
  ).toBe("Reviewed recovery");
  bridge.setHandler("plans.verify", () => result);
  fireEvent.click(screen.getByText("Confirm verification"));
  await waitFor(() =>
    expect(
      bridge.calls.filter((c) => c.method === "plans.verify"),
    ).toHaveLength(2),
  );
  expect(
    bridge.calls.filter((c) => c.method === "plans.verify").at(-1)?.params,
  ).toMatchObject({ rev: 3, note: "Reviewed recovery" });
  expect(screen.queryByText("PRIVATE_RAW_ERROR")).toBeNull();
});
it("cancellation has a separate human confirmation and retries preserve captured work intents", async () => {
  const entry = entryOf();
  entry.map.planExports = [
    {
      file: "old.md",
      planId: "pl-01",
      rev: 1,
      event: "accepted",
      content: "old bytes",
      status: "pending",
    },
  ];
  const bridge = createFakeBridge();
  bridge.setHandler("plans.cancel", () => result);
  bridge.setHandler("plans.retryEffects", () => ({
    ...result,
    effects: {
      ...result.effects,
      pendingSnapshots: 1,
      conflictCount: 1,
      conflicts: [
        { planId: "pl-01", rev: 1, code: "snapshot-conflict" as const },
      ],
    },
  }));
  render(<PlanPanel entry={entry} roomId="r-01" bridge={bridge} />);
  fireEvent.click(screen.getByText("Cancel plan…"));
  expect(bridge.calls).toHaveLength(0);
  fireEvent.click(screen.getByText("Confirm cancellation"));
  await waitFor(() => expect(bridge.calls).toHaveLength(1));
  expect(bridge.calls[0]?.params).toMatchObject({ planId: "pl-01", rev: 2 });
  fireEvent.click(screen.getByText("Retry pending deliveries"));
  await screen.findByText(
    /Workspace delivery status: 0 queued · 1 pending snapshot · 0 pending backlog · 1 conflict/,
  );
  expect(entry.map.planExports[0]).toMatchObject({
    rev: 1,
    content: "old bytes",
    status: "pending",
  });
  expect(bridge.calls.at(-1)?.params).toEqual({
    projectPath: "/tmp/one",
    workId: "w-01",
  });
});

it("peer: archived workspace rejects plan mutation controls before an RPC is sent", async () => {
  const bridge = createFakeBridge();
  bridge.setHandler("plans.verify", () => result);
  const entry = entryOf();
  entry.map.work.status = "archived";
  render(<PlanPanel entry={entry} roomId="r-01" bridge={bridge} />);
  const button = screen.getByText("Verify item") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

it("peer: late success cannot delete a newer note typed while verification is in flight", async () => {
  const bridge = createFakeBridge();
  let finish!: (value: typeof result) => void;
  bridge.setHandler(
    "plans.verify",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<PlanPanel entry={entryOf()} roomId="r-01" bridge={bridge} />);
  fireEvent.click(screen.getByText("Verify item"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Captured first note" },
  });
  fireEvent.click(screen.getByText("Confirm verification"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Newer human draft" },
  });
  await act(async () => finish(result));
  expect(screen.getByLabelText("Verification note")).toHaveProperty(
    "value",
    "Newer human draft",
  );
});

it("preserves newer evidence and artifact drafts after an older submission succeeds", async () => {
  const bridge = createFakeBridge();
  let finish!: (value: typeof result) => void;
  bridge.setHandler(
    "plans.submit",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const plan = planOf();
  plan.items[0]!.status = "ready";
  render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={bridge} />);
  fireEvent.click(screen.getByText("Submit evidence"));
  fireEvent.change(screen.getByLabelText("Evidence"), {
    target: { value: "Submitted evidence" },
  });
  fireEvent.change(screen.getByLabelText("Artifact references"), {
    target: { value: "first.txt" },
  });
  fireEvent.click(screen.getByText("Confirm submission"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Evidence"), {
    target: { value: "Newer evidence" },
  });
  fireEvent.change(screen.getByLabelText("Artifact references"), {
    target: { value: "newer.txt" },
  });
  await act(async () => finish(result));
  expect(screen.getByLabelText("Evidence")).toHaveProperty(
    "value",
    "Newer evidence",
  );
  expect(screen.getByLabelText("Artifact references")).toHaveProperty(
    "value",
    "newer.txt",
  );
  expect(bridge.calls.at(-1)?.params).toMatchObject({
    evidence: { text: "Submitted evidence", artifacts: ["first.txt"] },
  });
});
it("preserves a newer mode reason while the captured mode change settles", async () => {
  const bridge = createFakeBridge();
  let finish!: (value: typeof result) => void;
  bridge.setHandler(
    "rooms.setMode",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<RoomModeControl entry={entryOf()} roomId="r-01" bridge={bridge} />);
  fireEvent.change(screen.getByLabelText("Room mode"), {
    target: { value: "checklist" },
  });
  fireEvent.change(screen.getByLabelText("Reason for mode change"), {
    target: { value: "First reason" },
  });
  fireEvent.click(screen.getByText("Confirm mode change"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.change(screen.getByLabelText("Reason for mode change"), {
    target: { value: "Newer reason" },
  });
  await act(async () => finish(result));
  expect(screen.getByLabelText("Reason for mode change")).toHaveProperty(
    "value",
    "Newer reason",
  );
  expect(bridge.calls.at(-1)?.params).toMatchObject({ reason: "First reason" });
});
it("keeps archived pending delivery Retry available while mode and item mutations are disabled", async () => {
  const entry = entryOf();
  entry.map.work.status = "archived";
  entry.map.planExports = [
    {
      file: "old.md",
      planId: "pl-01",
      rev: 1,
      event: "accepted",
      content: "captured",
      status: "pending",
    },
  ];
  const bridge = createFakeBridge();
  bridge.setHandler("plans.retryEffects", () => result);
  render(
    <>
      <RoomModeControl entry={entry} roomId="r-01" bridge={bridge} />
      <PlanPanel entry={entry} roomId="r-01" bridge={bridge} />
    </>,
  );
  expect(screen.getByLabelText("Room mode")).toHaveProperty("disabled", true);
  expect(screen.getByText("Cancel plan…")).toHaveProperty("disabled", true);
  expect(screen.getByText("Return item")).toHaveProperty("disabled", true);
  expect(screen.getByText("Retry pending deliveries")).toHaveProperty(
    "disabled",
    false,
  );
  fireEvent.click(screen.getByText("Retry pending deliveries"));
  await waitFor(() => expect(bridge.calls).toHaveLength(1));
  expect(bridge.calls[0]?.method).toBe("plans.retryEffects");
});
it("does not settle a verification after the same work is archived", async () => {
  const bridge = createFakeBridge();
  let finish!: (value: typeof result) => void;
  bridge.setHandler(
    "plans.verify",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const entry = entryOf();
  const view = render(
    <PlanPanel entry={entry} roomId="r-01" bridge={bridge} />,
  );
  fireEvent.click(screen.getByText("Verify item"));
  fireEvent.change(screen.getByLabelText("Verification note"), {
    target: { value: "Retained note" },
  });
  fireEvent.click(screen.getByText("Confirm verification"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const archived = entryOf();
  archived.map.work.status = "archived";
  view.rerender(<PlanPanel entry={archived} roomId="r-01" bridge={bridge} />);
  await act(async () => finish(result));
  expect(screen.getByLabelText("Verification note")).toHaveProperty(
    "value",
    "Retained note",
  );
  expect(screen.getByText("Confirm verification")).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByText("Saved.")).toBeNull();
});

it('offers autonomous fourth and treats verified as a downgrade', () => {
  const entry = entryOf(planOf({ mode: 'autonomous', autonomous: autonomousPlan() }));
  render(<RoomModeControl entry={entry} roomId="r-01" bridge={createFakeBridge()} />);
  expect(Array.from((screen.getByLabelText('Room mode') as HTMLSelectElement).options).map(o => o.value)).toEqual(['free', 'checklist', 'verified', 'autonomous']);
  expect(MODES).toEqual(['free', 'checklist', 'verified', 'autonomous']);
  fireEvent.change(screen.getByLabelText('Room mode'), { target: { value: 'verified' } });
  expect(screen.getByText('Lowering the mode removes verification requirements.')).toBeTruthy();
});
it('shows the latest autonomous attempt and check, hiding agent forms', () => {
  const plan = planOf({ mode: 'autonomous', autonomous: autonomousPlan() });
  plan.items[0]!.status = 'ready';
  render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={createFakeBridge()} />);
  expect(screen.getByText('Attempt 2 · Returned · verifier:0 → fail · Restart still fails')).toBeTruthy();
  expect(screen.queryByText('Submit evidence')).toBeNull();
  expect(screen.queryByText('Verify item')).toBeNull();
  expect(screen.queryByText('Return item')).toBeNull();
});
it('allows human return of an autonomous verified item after completion', async () => {
  const plan = planOf({ mode: 'autonomous', status: 'completed', autonomous: autonomousPlan() });
  plan.items[0]!.status = 'verified';
  const bridge = createFakeBridge(); bridge.setHandler('plans.verify', () => result);
  render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={bridge} />);
  expect(screen.queryByText('Verify item')).toBeNull();
  fireEvent.click(screen.getByText('Return item'));
  fireEvent.change(screen.getByLabelText('Verification note'), { target: { value: 'Late defect' } });
  fireEvent.click(screen.getByText('Confirm return'));
  await waitFor(() => expect(bridge.calls.at(-1)).toMatchObject({ method: 'plans.verify', params: { planId: plan.id, rev: plan.rev, item: 1, verdict: 'returned', note: 'Late defect' } }));
});

it('hides a previously open agent form when the plan becomes autonomous', () => {
  const bridge = createFakeBridge(); const plan = planOf();
  const view = render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={bridge} />);
  fireEvent.click(screen.getByText('Verify item'));
  expect(screen.getByLabelText('Verification note')).toBeTruthy();
  view.rerender(<PlanPanel entry={entryOf({ ...plan, mode: 'autonomous', autonomous: autonomousPlan() })} roomId="r-01" bridge={bridge} />);
  expect(screen.queryByLabelText('Verification note')).toBeNull();
});
it('selects the highest attempt number and latest check without showing an older attempt verdict', () => {
  const autonomous = autonomousPlan();
  autonomous.attempts.push({ ...autonomous.attempts[0]!, id: 'at-01', n: 1 });
  const current = autonomous.ops[0]!.result!.checkResult as import('@parley/core').CheckResult;
  autonomous.ops.push({ ...autonomous.ops[0]!, key: 'op-02', result: { checkResult: { ...current, id: 'ck-02', specId: 'unit', at: '2026-10-25T10:01:00Z', verdict: 'pass', summary: 'newest\n' + 'x'.repeat(200) } } });
  autonomous.attempts[0]!.checks.push('ck-02');
  render(<PlanPanel entry={entryOf(planOf({ mode: 'autonomous', autonomous }))} roomId="r-01" bridge={createFakeBridge()} />);
  const line = screen.getByText(/^Attempt 2/);
  expect(line.textContent).toContain('unit → pass · newest ');
  expect(line.textContent).toMatch(/…$/);
  expect(line.textContent).not.toContain('Restart still fails');
});

const NEEDS_GIT = /^Autonomous mode needs a Git repository at the project root\./;
it('autonomous room in a non-git project shows the git hint; git project and other modes do not', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('worktrees.available', () => ({ available: false, gitRoot: false }));
  const view = render(<RoomModeControl entry={entryOf(planOf({ mode: 'autonomous', autonomous: autonomousPlan() }))} roomId="r-01" bridge={bridge} />);
  expect(await screen.findByText(NEEDS_GIT)).toBeTruthy();
  expect(bridge.calls).toEqual([{ method: 'worktrees.available', params: { projectPath: '/tmp/one' } }]);
  view.unmount();

  const git = createFakeBridge(); git.setHandler('worktrees.available', () => ({ available: true, gitRoot: true }));
  render(<RoomModeControl entry={entryOf(planOf({ mode: 'autonomous', autonomous: autonomousPlan() }))} roomId="r-01" bridge={git} />);
  await waitFor(() => expect(git.calls).toHaveLength(1));
  await act(async () => {});
  expect(screen.queryByText(NEEDS_GIT)).toBeNull();
  cleanup();

  const other = createFakeBridge(); other.setHandler('worktrees.available', () => ({ available: false, gitRoot: false }));
  render(<RoomModeControl entry={entryOf()} roomId="r-01" bridge={other} />);
  await act(async () => {});
  expect(other.calls).toHaveLength(0);
  expect(screen.queryByText(NEEDS_GIT)).toBeNull();
});
it('picking Autonomous in the selector asks about git once and shows the hint for a non-git project', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('worktrees.available', () => ({ available: false, gitRoot: false }));
  render(<RoomModeControl entry={entryOf()} roomId="r-01" bridge={bridge} />);
  fireEvent.change(screen.getByLabelText('Room mode'), { target: { value: 'autonomous' } });
  expect(await screen.findByText(NEEDS_GIT)).toBeTruthy();
  expect(bridge.calls.filter((call) => call.method === 'worktrees.available')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Room mode'), { target: { value: 'checklist' } });
  expect(screen.queryByText(NEEDS_GIT)).toBeNull();
});
it('autonomous room in a subfolder of a git repository shows the git hint', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('worktrees.available', () => ({ available: true, gitRoot: false }));
  render(<RoomModeControl entry={entryOf(planOf({ mode: 'autonomous', autonomous: autonomousPlan() }))} roomId="r-01" bridge={bridge} />);
  expect(await screen.findByText(NEEDS_GIT)).toBeTruthy();
});
it('autonomous room at a git root shows no hint', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('worktrees.available', () => ({ available: true, gitRoot: true }));
  render(<RoomModeControl entry={entryOf(planOf({ mode: 'autonomous', autonomous: autonomousPlan() }))} roomId="r-01" bridge={bridge} />);
  await waitFor(() => expect(bridge.calls).toHaveLength(1));
  await act(async () => {});
  expect(screen.queryByText(NEEDS_GIT)).toBeNull();
});
it('an old host without gitRoot is unknown: no hint', async () => {
  const bridge = createFakeBridge(); bridge.setHandler('worktrees.available', () => ({ available: false }));
  render(<RoomModeControl entry={entryOf(planOf({ mode: 'autonomous', autonomous: autonomousPlan() }))} roomId="r-01" bridge={bridge} />);
  await waitFor(() => expect(bridge.calls).toHaveLength(1));
  await act(async () => {});
  expect(screen.queryByText(NEEDS_GIT)).toBeNull();
});

// Кто должен действовать, почему пункт ждёт и последние позиции участников (план 2026-10-19, P5).
const itemWith = (
  id: number,
  patch: Partial<RoomPlan["items"][number]> = {},
): RoomPlan["items"][number] => ({
  id,
  title: `Item ${id}`,
  owner: "s-01",
  scope: "src/**",
  after: [],
  criteria: ["Works"],
  verifier: "s-02",
  status: "waiting",
  evidence: null,
  note: null,
  log: [],
  ...patch,
});
const dutyEntry = (plan: RoomPlan, lead: string | null = "s-01"): WindowWorkEntry => {
  const entry = makeWork("w-01", {
    projectPath: "/tmp/one",
    sessions: [makeSession("s-01", "Builder"), makeSession("s-02", "Checker")],
    rooms: [
      {
        ...makeRoom("r-01", "Delivery"),
        mode: plan.mode,
        members: ["s-01", "s-02"],
        lead,
      },
    ],
  });
  entry.map.plans = [plan];
  return entry;
};
const itemNode = (container: HTMLElement, id: number): HTMLElement => {
  const found = container.querySelector<HTMLElement>(
    `[data-plan-item="${id}"]`,
  );
  if (!found) throw new Error(`нет пункта ${id}`);
  return found;
};
const dutiesOf = (node: HTMLElement): string[] =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-plan-duty]")).map(
    (duty) => duty.textContent ?? "",
  );

it("показывает, кто должен действовать, и причину ожидания по таблице planItemDuties", () => {
  const plan = planOf({
    items: [
      itemWith(1, { status: "ready" }),
      itemWith(2, { status: "in_progress" }),
      itemWith(3, { status: "waiting", after: [1, 2] }),
      itemWith(4, { status: "done" }),
      itemWith(5, { status: "blocked", note: "Need the API key" }),
      itemWith(6, { status: "returned" }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(dutiesOf(itemNode(container, 1))).toEqual([
    "Owner S01 Builder must start",
    "Verifier S02 Checker: Waiting for S01 Builder to submit",
  ]);
  expect(dutiesOf(itemNode(container, 2))).toEqual([
    "Owner S01 Builder must continue",
    "Verifier S02 Checker: Waiting for S01 Builder to submit",
  ]);
  expect(
    within(itemNode(container, 3)).getByText("Waiting for #1, #2"),
  ).toBeTruthy();
  expect(dutiesOf(itemNode(container, 4))).toEqual([
    "Owner S01 Builder: Awaiting verification by S02 Checker",
    "Verifier S02 Checker must verify",
  ]);
  expect(dutiesOf(itemNode(container, 5))).toEqual([
    "Owner S01 Builder: Blocked: Need the API key",
    "Verifier S02 Checker: Waiting for S01 Builder to submit",
    "Lead S01 Builder must resolve the block",
  ]);
  expect(dutiesOf(itemNode(container, 6))[0]).toBe(
    "Owner S01 Builder must rework the returned item",
  );
});

it("лид из окна — живой лид: закрытый назначенный уступает первому живому, блокировку решает он", () => {
  const plan = planOf({
    items: [itemWith(1, { status: "blocked", note: null })],
  });
  const entry = dutyEntry(plan, "s-01");
  entry.map.sessions[0]!.lifecycle = "closed";
  const { container } = render(
    <PlanPanel entry={entry} roomId="r-01" bridge={createFakeBridge()} />,
  );
  expect(dutiesOf(itemNode(container, 1))).toContain(
    "Lead S02 Checker must resolve the block",
  );
  expect(dutiesOf(itemNode(container, 1))).toContain(
    "Owner S01 Builder: Blocked",
  );
});

it("в режиме checklist проверяющего нет, а сделанный пункт обязанностей не даёт", () => {
  const plan = planOf({
    mode: "checklist",
    items: [
      itemWith(1, { status: "ready", verifier: null }),
      itemWith(2, { status: "done", verifier: null }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(dutiesOf(itemNode(container, 1))).toEqual([
    "Owner S01 Builder must start",
  ]);
  expect(dutiesOf(itemNode(container, 2))).toEqual([]);
});

it("у неактивного плана (завершён, отменён) обязанностей нет", () => {
  const plan = planOf({
    status: "completed",
    items: [itemWith(1, { status: "ready" })],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(container.querySelector("[data-plan-duty]")).toBeNull();
});

type Checkpoint = NonNullable<
  NonNullable<RoomPlan["items"][number]["progress"]>["owner"]
>;
const checkpointOf = (
  by: string,
  patch: Partial<Checkpoint> = {},
): Checkpoint => ({
  by,
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  submission: null,
  done: "Parser written",
  next: "Wire the CLI",
  artifacts: ["src/parser.ts", "src/cli.ts"],
  blocker: null,
  ...patch,
});

it("показывает последнюю позицию владельца: сделано, дальше, препятствие, число артефактов и время", () => {
  const plan = planOf({
    items: [
      itemWith(1, {
        status: "in_progress",
        progress: {
          owner: checkpointOf("s-01", { blocker: "Waiting for a fixture" }),
        },
      }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  const owner = container.querySelector<HTMLElement>(
    '[data-plan-checkpoint="owner"]',
  )!;
  expect(owner.querySelector("[data-checkpoint-done]")?.textContent).toBe(
    "Parser written",
  );
  expect(owner.querySelector("[data-checkpoint-next]")?.textContent).toBe(
    "Wire the CLI",
  );
  expect(owner.querySelector("[data-checkpoint-blocker]")?.textContent).toBe(
    "Waiting for a fixture",
  );
  expect(owner.querySelector("[data-checkpoint-artifacts]")?.textContent).toBe(
    "2 artifacts",
  );
  expect(owner.querySelector("[data-checkpoint-time]")?.textContent).toBe("5m");
  expect(owner.textContent).toContain("S01 Builder");
  expect(owner.querySelector("[data-checkpoint-stale]")).toBeNull();
  expect(
    container.querySelector('[data-plan-checkpoint="verifier"]'),
  ).toBeNull();
});

it("позиция проверяющего с прежней сдачей актуальна, а после повторной сдачи помечена stale", () => {
  const log = (status: "done" | "returned") => ({
    at: "2026-10-19T10:00:00.000Z",
    by: "s-01",
    status,
    note: null,
  });
  const fresh = planOf({
    items: [
      itemWith(1, {
        status: "done",
        log: [log("done")],
        progress: {
          verifier: checkpointOf("s-02", {
            submission: 1,
            blocker: "Tests are slow",
          }),
        },
      }),
    ],
  });
  const view = render(
    <PlanPanel
      entry={dutyEntry(fresh)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  const verifier = () =>
    view.container.querySelector<HTMLElement>(
      '[data-plan-checkpoint="verifier"]',
    )!;
  expect(verifier().querySelector("[data-checkpoint-stale]")).toBeNull();
  expect(
    verifier().querySelector("[data-checkpoint-blocker]")?.textContent,
  ).toBe("Tests are slow");
  const resubmitted = planOf({
    items: [
      itemWith(1, {
        status: "done",
        log: [log("done"), log("returned"), log("done")],
        progress: { verifier: checkpointOf("s-02", { submission: 1 }) },
      }),
    ],
  });
  view.rerender(
    <PlanPanel
      entry={dutyEntry(resubmitted)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(
    verifier().querySelector("[data-checkpoint-stale]")?.textContent,
  ).toBe("Stale · saved before the latest submission");
  expect(verifier().getAttribute("data-stale")).toBe("");
});

it("позиция без артефактов и препятствия не рисует лишних строк, один артефакт — в единственном числе", () => {
  const plan = planOf({
    items: [
      itemWith(1, {
        status: "in_progress",
        progress: { owner: checkpointOf("s-01", { artifacts: ["a.ts"] }) },
      }),
      itemWith(2, {
        status: "in_progress",
        progress: { owner: checkpointOf("s-01", { artifacts: [] }) },
      }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(
    itemNode(container, 1).querySelector("[data-checkpoint-artifacts]")
      ?.textContent,
  ).toBe("1 artifact");
  expect(
    itemNode(container, 2).querySelector("[data-checkpoint-artifacts]"),
  ).toBeNull();
  expect(
    itemNode(container, 2).querySelector("[data-checkpoint-blocker]"),
  ).toBeNull();
});

it("у сделанного пункта позиции не показываются: точка возобновления уже не нужна", () => {
  const plan = planOf({
    items: [
      itemWith(1, {
        status: "verified",
        progress: { owner: checkpointOf("s-01") },
      }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(container.querySelector("[data-plan-checkpoint]")).toBeNull();
});

it("прогресс: verified остаётся прежним, пункты done без проверки считаются отдельно и не повышают verified", () => {
  const plan = planOf({
    items: [
      ...[1, 2, 3, 4].map((id) => itemWith(id, { status: "verified" })),
      ...[5, 6].map((id) => itemWith(id, { status: "done" })),
      itemWith(7, { status: "ready" }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(screen.getByText("4/7 verified")).toBeTruthy();
  expect(container.querySelector("[data-plan-awaiting]")?.textContent).toBe(
    "2 awaiting verification",
  );
});

it("прогресс: без пунктов на проверке счётчика нет; в checklist done — это сделано, а не ждёт", () => {
  const verified = planOf({
    items: [itemWith(1, { status: "verified" }), itemWith(2, { status: "ready" })],
  });
  const view = render(
    <PlanPanel
      entry={dutyEntry(verified)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(view.container.querySelector("[data-plan-awaiting]")).toBeNull();
  const checklist = planOf({
    mode: "checklist",
    items: [
      itemWith(1, { status: "done", verifier: null }),
      itemWith(2, { status: "ready", verifier: null }),
    ],
  });
  view.rerender(
    <PlanPanel
      entry={dutyEntry(checklist)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(screen.getByText("1/2 done")).toBeTruthy();
  expect(view.container.querySelector("[data-plan-awaiting]")).toBeNull();
});

it("прогресс: done, принятый из checklist при повышении, не ждёт проверки", () => {
  const plan = planOf({
    rev: 3,
    items: [
      itemWith(1, { status: "done", acceptedChecklistRevision: 1 }),
      itemWith(2, { status: "done" }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(container.querySelector("[data-plan-awaiting]")?.textContent).toBe(
    "1 awaiting verification",
  );
});

it("длинные названия (200+ знаков, без пробелов, с кириллицей и CJK) переносятся и не режутся", () => {
  const unbroken = "Очень-длинное-название-без-пробелов-".repeat(8);
  const cjk = "超长标题".repeat(60);
  const path = "a/".repeat(150);
  const plan = planOf({
    goal: unbroken,
    items: [
      itemWith(1, { title: unbroken, status: "ready" }),
      itemWith(2, { title: cjk, status: "ready" }),
      itemWith(3, { title: path, status: "ready" }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  const titles = Array.from(
    container.querySelectorAll<HTMLElement>("[data-plan-item-title]"),
  );
  expect(titles.map((title) => title.textContent)).toEqual([
    `1. ${unbroken}`,
    `2. ${cjk}`,
    `3. ${path}`,
  ]);
  for (const title of titles) {
    expect(title.className).toContain("min-w-0");
    expect(title.className).toContain("break-words");
    expect(title.className).toContain("[overflow-wrap:anywhere]");
  }
  const root = container.querySelector<HTMLElement>("[data-plan-summary]")!;
  expect(root.className).toContain("min-w-0");
  expect(root.className).toContain("[overflow-wrap:anywhere]");
  expect(root.querySelector("strong")!.className).toContain("break-words");
});

it("длинные позиции участников тоже переносятся", () => {
  const long = "Ж".repeat(600);
  const plan = planOf({
    items: [
      itemWith(1, {
        status: "in_progress",
        progress: {
          owner: checkpointOf("s-01", {
            done: long,
            next: long.slice(0, 300),
            blocker: long.slice(0, 300),
          }),
        },
      }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  const node = container.querySelector<HTMLElement>(
    '[data-plan-checkpoint="owner"]',
  )!;
  expect(node.className).toContain("min-w-0");
  expect(node.className).toContain("[overflow-wrap:anywhere]");
  expect(node.querySelector("[data-checkpoint-done]")?.textContent).toBe(long);
});

it("ownerLabel подписывает человека, сессию и неизвестного участника", () => {
  const entry = dutyEntry(planOf());
  expect(ownerLabel(entry, "human")).toBe("You");
  expect(ownerLabel(entry, "s-02")).toBe("S02 Checker");
  expect(ownerLabel(entry, "s-77")).toBe("s-77");
  expect(ownerLabel(undefined, "s-02")).toBe("s-02");
});

it("одиночный чат без комнаты не получает плановый workflow: ни панели, ни прогресса, ни обязанностей", () => {
  const plan = planOf({ items: [itemWith(1, { status: "ready" })] });
  // Комната с планом есть, но чат открыт вне неё.
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-solo"
      bridge={createFakeBridge()}
    />,
  );
  expect(container.innerHTML).toBe("");
  // Работа вообще без комнат и планов — тоже ничего.
  const solo = makeWork("w-02", {
    projectPath: "/tmp/one",
    sessions: [makeSession("s-01", "Builder")],
  });
  const empty = render(
    <PlanPanel entry={solo} roomId="r-01" bridge={createFakeBridge()} />,
  );
  expect(empty.container.innerHTML).toBe("");
});

it("автономный план без обязанностей, позиций и счётчика проверки: пункты ведёт движок", () => {
  const plan = planOf({
    mode: "autonomous",
    autonomous: autonomousPlan(),
    items: [
      itemWith(1, {
        status: "done",
        progress: { owner: checkpointOf("s-01") },
      }),
      itemWith(2, { status: "ready" }),
    ],
  });
  const { container } = render(
    <PlanPanel
      entry={dutyEntry(plan)}
      roomId="r-01"
      bridge={createFakeBridge()}
    />,
  );
  expect(container.querySelector("[data-plan-duty]")).toBeNull();
  expect(container.querySelector("[data-plan-checkpoint]")).toBeNull();
  expect(container.querySelector("[data-plan-awaiting]")).toBeNull();
  expect(container.querySelector("[data-plan-attempt]")).not.toBeNull();
});

const submissionOf = (n: number, patch: Partial<NonNullable<RoomPlan["items"][number]["submissions"]>[number]> = {}) => ({
  n, by: "s-01", at: "2025-01-05T12:00:00.000Z",
  evidence: { text: `Evidence ${n}`, artifacts: [`file-${n}.txt`] },
  verdict: null, verdictBy: null, verdictAt: null, note: null, ...patch,
});
const planWithSubmissions = (submissions: ReturnType<typeof submissionOf>[], mode: RoomPlan["mode"] = "verified") => {
  const plan = planOf({ mode });
  plan.items[0]!.submissions = submissions;
  return plan;
};

it("a plan item with one submission shows no submission list", () => {
  render(<PlanPanel entry={entryOf(planWithSubmissions([submissionOf(1)]))} roomId="r-01" bridge={createFakeBridge()} />);
  expect(document.querySelector("[data-plan-submissions]")).toBeNull();
});

it("lists submissions newest first with the older evidence folded", () => {
  const plan = planWithSubmissions([submissionOf(1, { verdict: "returned", verdictBy: "s-02", note: "Missing case" }), submissionOf(2)]);
  render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={createFakeBridge()} />);
  const rows = [...document.querySelectorAll("[data-plan-submission]")];
  expect(rows.map((row) => row.getAttribute("data-plan-submission"))).toEqual(["2", "1"]);
  expect(rows[0]!.textContent).toMatch(/^#2 · .* · Jan \d+, 2025/);
  expect(rows[0]!.querySelector("details")).toBeNull();
  expect(rows[1]!.querySelector("details")?.textContent).toContain("Evidence 1");
  expect(rows[1]!.querySelector("details")?.textContent).toContain("file-1.txt");
});

it("shows the verdict, the note and the return by the human", () => {
  const plan = planWithSubmissions([
    submissionOf(1, { verdict: "verified", verdictBy: "s-02", note: "Looks fine", returnedBy: "human", returnedAt: "2025-01-06T12:00:00.000Z", returnNote: "Regression found" }),
    submissionOf(2, { verdict: "returned", verdictBy: "s-02", note: "Not enough" }),
  ]);
  render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={createFakeBridge()} />);
  const [newest, oldest] = [...document.querySelectorAll("[data-plan-submission]")];
  expect(newest!.textContent).toContain("returned by s-02");
  expect(newest!.textContent).toContain("Not enough");
  expect(newest!.textContent).not.toContain("returned by you");
  expect(oldest!.textContent).toContain("verified by s-02");
  expect(oldest!.textContent).toContain("returned by you");
  expect(oldest!.textContent).toContain("Looks fine");
  expect(oldest!.textContent).toContain("Regression found");
});

it("a long unbroken note wraps instead of widening the row", () => {
  const note = "n".repeat(3000);
  const plan = planWithSubmissions([submissionOf(1, { note }), submissionOf(2)]);
  render(<PlanPanel entry={entryOf(plan)} roomId="r-01" bridge={createFakeBridge()} />);
  const paragraph = screen.getByText(note);
  expect(paragraph.className).toContain("break-words");
  expect(paragraph.className).toContain("whitespace-pre-wrap");
  expect(paragraph.closest("[data-plan-submission]")!.className).toContain("break-words");
});
