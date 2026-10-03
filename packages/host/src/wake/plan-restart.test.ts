import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  addMessage,
  addSession,
  addRoom,
  HUMAN,
  setProposal,
  resolveProposal,
  reservePlanEffects,
  transitionSession,
} from "@parley/core";
import type { WorkMap } from "@parley/core";
import type { HostContext } from "../context.js";
import type { ActivityService } from "../activity/activity-service.js";
import type { WorksService } from "../works/works-service.js";
import type { PtyManager } from "../pty/pty-manager.js";
import type { SessionsService } from "../sessions/sessions-service.js";
import { createWakeService } from "./wake-service.js";
let home: string;
let previous: string | undefined;
beforeEach(async () => {
  home = await mkdtemp("/private/tmp/parley-plan-wake-");
  previous = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = home;
  await mkdir(path.join(home, "project"));
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
function mapFixture(): WorkMap {
  const at = new Date().toISOString();
  const map: WorkMap = {
    schemaVersion: 2,
    work: {
      id: "w-01",
      title: "Wake",
      goal: "",
      status: "active",
      createdAt: at,
      updatedAt: at,
    },
    sessions: [],
    rooms: [],
    messages: [],
  };
  for (const label of ["Lead", "Owner"])
    addSession(map, { provider: "claude", label, task: "Fixture" }, at);
  addRoom(
    map,
    {
      creator: HUMAN,
      members: ["s-01", "s-02"],
      lead: "s-01",
      title: "Plan",
      mode: "checklist",
    },
    at,
  );
  const p = setProposal(map, "r-01", "s-01", "Decision", at, {
    plan: {
      mode: "checklist",
      goal: "Do it",
      items: [{ id: 1, title: "Work", scope: "src", owner: "s-02" }],
    },
  });
  resolveProposal(
    map,
    "r-01",
    p.proposalId,
    "accept",
    { rev: p.rev, planId: "pl-01", planRev: 0 },
    at,
  );
  transitionSession(map, "s-02", "active", { at });
  transitionSession(map, "s-02", "sleeping", { at });
  map.sessions[1]!.providerSessionId = "offline-fixture";
  addMessage(map, { from: HUMAN, to: ["s-02"], text: "Old ordinary mail" }, at);
  reservePlanEffects(map, 20, at);
  return map;
}
function rig(map: WorkMap) {
  const project = path.join(home, "project");
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const works = {
    snapshot: () => ({
      entries: [{ projectPath: project, map }],
      branches: {},
    }),
    entry: () => ({ projectPath: project, map }),
    onChange: () => () => {},
  } as unknown as WorksService;
  const activity = {
    onChange: () => () => {},
    mailWaiting: vi.fn(),
  } as unknown as ActivityService;
  const pty = {
    get: () => undefined,
    on: (name: string, fn: (...args: unknown[]) => void) => {
      callbacks.set(name, fn);
      return () => {};
    },
  } as unknown as PtyManager;
  const host = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcast: vi.fn(),
  } as unknown as HostContext;
  const launch = vi.fn<SessionsService["launch"]>(async () => {});
  const wake = createWakeService(host, works, activity, pty, { launch });
  return {
    wake,
    launch,
    callbacks,
    ref: { projectPath: project, workId: "w-01", sessionId: "s-02" },
  };
}
async function settled() {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
}
it("restart wakes only a current persisted sent plan assignment while ordinary old mail remains pointed", async () => {
  const map = mapFixture();
  const r = rig(map);
  r.wake.start();
  await settled();
  expect(r.launch).toHaveBeenCalledTimes(1);
  expect(r.launch.mock.calls[0]![0]).toEqual(r.ref);
  r.wake.stop();
});
it.each(["cancelled", "forged", "obsolete"] as const)(
  "restart does not wake a %s effect even with unread text",
  async (kind) => {
    const map = mapFixture();
    if (kind === "cancelled") map.planEffects![0]!.status = "cancelled";
    else if (kind === "forged")
      map.messages.find(
        (row) => row.id === map.planEffects![0]!.messageId,
      )!.text = "Forged payload";
    else map.plans![0]!.rev++;
    const r = rig(map);
    r.wake.start();
    await settled();
    expect(r.launch).not.toHaveBeenCalled();
    r.wake.stop();
  },
);
