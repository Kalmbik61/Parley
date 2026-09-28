import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "./model.js";
import { createTask, launchPrepared } from "./task-creation.js";

const task = (patch = {}) => ({
  title: "Reliable launches", goal: "Make pending agents launch reliably.",
  members: [{ key: "first", provider: "claude", role: "Implementer", model: "custom-cli-model", effort: "medium" }],
  existing: [], lead: "first", worktree: true, launchNow: true, contextFrom: ["pay-s1"], ...patch,
});
let sequence = 0;
const id = () => `new-${++sequence}`;

test("launching prepared agents preserves already running sessions and task history", () => {
  const prepared = createTask(createInitialState(), "payments", task({ launchNow: false, existing: ["pay-s1"] }), id);
  const launched = launchPrepared(prepared.state, prepared.room.id);
  assert.equal(launched.sessions.find((s) => s.id === prepared.sessions[0].id).lifecycle, "active");
  assert.equal(launched.sessions.find((s) => s.id === "pay-s1"), prepared.state.sessions.find((s) => s.id === "pay-s1"));
  assert.equal(launched.rooms, prepared.state.rooms);
  assert.equal(launchPrepared(launched, prepared.room.id).sessions.at(-1), launched.sessions.at(-1));
});

test("one agent starts a durable task and retains launch choices", () => {
  const initial = createInitialState();
  const result = createTask(initial, "payments", task(), id);
  assert.equal(result.room.members.length, 1);
  assert.equal(result.room.lead, result.sessions[0].id);
  assert.equal(result.sessions[0].status, "working");
  assert.deepEqual(result.sessions[0].runConfig, { model: "custom-cli-model", effort: "medium", worktree: true, baseBranch: "main" });
  assert.deepEqual(result.sessions[0].contextFrom, ["pay-s1"]);
  assert.equal(initial.rooms.length + 1, result.state.rooms.length);
});

test("a second agent turns the same conversation into a team, preserving history", () => {
  const single = createTask(createInitialState(), "payments", task(), id);
  const team = createTask(single.state, "payments", task({ targetId: single.room.id, lead: single.room.lead, launchNow: false }), id);
  assert.equal(team.room.id, single.room.id);
  assert.equal(team.room.members.length, 2);
  assert.equal(team.room.messages, single.room.messages);
  assert.equal(team.room.lead, single.room.lead);
  assert.equal(team.sessions[0].lifecycle, "pending");
  assert.equal(team.sessions[0].code, "S06");
});

test("adding existing agents preserves their state and excludes other workspaces", () => {
  const initial = createInitialState();
  const result = createTask(initial, "payments", task({ members: [], existing: ["pay-s1", "pay-s1", "auth-s1"], lead: "missing" }), id);
  assert.deepEqual(result.room.members, ["pay-s1"]);
  assert.equal(result.state.sessions[0], initial.sessions[0]);
  assert.equal(result.room.lead, "pay-s1");
  assert.throws(() => createTask(initial, "payments", task({ members: [], existing: ["auth-s1"] }), id), /at least one/);
});

test("invalid tasks do not create sessions and role instructions override shared task", () => {
  const initial = createInitialState();
  for (const patch of [{ title: " " }, { goal: " " }, { targetId: "missing" }])
    assert.throws(() => createTask(initial, "payments", task(patch), id));
  const result = createTask(initial, "payments", task({ members: [{ key: "first", provider: "codex", role: "Reviewer", task: "Review only" }] }), id);
  assert.equal(result.sessions[0].task, "Review only");
  assert.equal(result.sessions[0].runConfig.model, "CLI default");
});
