import { afterEach, expect, it, vi } from "vitest";
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
