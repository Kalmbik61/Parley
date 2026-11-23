import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  transitionRoom,
  assignmentState,
} from "./model.js";

test("approving a plan does not start implementation; starting requires approval", () => {
  const room = createInitialState().rooms[0];
  assert.equal(transitionRoom(room, { type: "start" }), room);
  const approved = transitionRoom(room, { type: "approve" });
  assert.equal(approved.stage, "ready");
  assert.equal(approved.decisions.length, 1);
  assert.equal(transitionRoom(approved, { type: "approve" }), approved);
  assert.equal(transitionRoom(approved, { type: "start" }).stage, "executing");
  assert.equal(room.stage, "awaiting");
});

test("a returned revision remains in history and the next revision needs fresh approval", () => {
  const room = createInitialState().rooms[0];
  assert.equal(transitionRoom(room, { type: "return", note: "   " }), room);
  const returned = transitionRoom(room, {
    type: "return",
    note: "Cover concurrent refunds",
  });
  assert.equal(returned.decisions[0].status, "returned");
  assert.equal(transitionRoom(returned, { type: "start" }), returned);
  const next = transitionRoom(returned, { type: "revised" });
  assert.equal(next.revision, 3);
  assert.equal(next.stage, "awaiting");
  assert.equal(next.feedback, "Cover concurrent refunds");
  assert.equal(next.decisions[0].revision, 2);
  assert.equal(transitionRoom(next, { type: "start" }), next);
  const approved = transitionRoom(next, { type: "approve" });
  assert.match(approved.decisions.at(-1).text, /Cover concurrent refunds/);
  assert.deepEqual(approved.decisions.at(-1).conditions, [
    "Cover concurrent refunds",
  ]);
  assert.notEqual(approved.decisions.at(-1).proposal, next.proposal);
});

test("new rooms can reach a room-specific proposal and execution", () => {
  const data = createInitialState(),
    room = data.rooms[1];
  const proposed = transitionRoom(room, {
    type: "propose",
    sessions: data.sessions,
  });
  assert.equal(proposed.stage, "awaiting");
  assert.match(proposed.proposal.title, /Sign-in flow/);
  assert.equal(proposed.plan.length, 2);
  assert.ok(proposed.plan.every((p) => room.members.includes(p.sessionId)));
  assert.equal(
    transitionRoom(transitionRoom(proposed, { type: "approve" }), {
      type: "start",
    }).stage,
    "executing",
  );
});

test("assignment status follows the session after a permission is answered", () => {
  const room = { ...createInitialState().rooms[0], stage: "executing" };
  assert.equal(
    assignmentState(room, { status: "blocked" }).label,
    "Needs input",
  );
  assert.equal(assignmentState(room, { status: "working" }).label, "Working");
});

test("results can only be accepted from review; room histories are independent", () => {
  const data = createInitialState();
  assert.equal(
    transitionRoom(data.rooms[0], { type: "finish" }),
    data.rooms[0],
  );
  assert.equal(
    transitionRoom({ ...data.rooms[0], stage: "review" }, { type: "finish" })
      .stage,
    "complete",
  );
  assert.equal(data.rooms[1].messages.length, 2);
});
