import { afterEach, beforeEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RoomPlan, WorkEntry } from "@parley/core";
import { PlanPanel, RoomModeControl } from "./PlanPanel.js";
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
const entryOf = (plan = planOf()): WorkEntry => {
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
