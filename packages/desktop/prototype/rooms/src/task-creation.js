/* global crypto */

export function launchPrepared(state, taskId) {
  const room = state.rooms.find((r) => r.id === taskId);
  if (!room) return state;
  return { ...state, sessions: state.sessions.map((session) =>
    room.members.includes(session.id) && session.lifecycle === "pending"
      ? { ...session, lifecycle: "active", status: "working", result: "Starting task" }
      : session,
  ) };
}

// Одна беседа сохраняет идентичность, когда к первому агенту присоединяются коллеги.
export function createTask(state, workspaceId, data, makeId = () => crypto.randomUUID()) {
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("Choose a workspace.");
  const target = data.targetId
    ? state.rooms.find((r) => r.id === data.targetId && r.workspace === workspaceId)
    : null;
  if (data.targetId && !target) throw new Error("This task is no longer available.");
  const local = state.sessions.filter((s) => s.workspace === workspaceId);
  const existing = [...new Set(data.existing || [])].filter((id) => local.some((s) => s.id === id));
  const title = data.title.trim();
  if (!title || !data.goal.trim()) throw new Error("Add a name and a task.");
  if (!data.members.length && !existing.length && !target) throw new Error("Add at least one agent.");
  let code = Math.max(0, ...local.map((s) => Number(s.code.slice(1)) || 0));
  const sessions = data.members.map((member) => ({
    id: makeId(),
    code: `S${String(++code).padStart(2, "0")}`,
    workspace: workspaceId,
    provider: member.provider,
    role: member.role.trim() || "Agent",
    task: member.task?.trim() || data.goal.trim(),
    status: data.launchNow ? "working" : "queued",
    lifecycle: data.launchNow ? "active" : "pending",
    scope: data.worktree ? "Own worktree" : "Project folder",
    contextFrom: (data.contextFrom || []).filter((id) => local.some((s) => s.id === id)),
    result: data.launchNow ? "Starting task" : "Not started",
    runConfig: {
      model: member.model?.trim() || "CLI default",
      effort: member.effort || "default",
      worktree: !!data.worktree,
      baseBranch: workspace.branch,
    },
  }));
  const members = [...new Set([...(target?.members || []), ...sessions.map((s) => s.id), ...existing])];
  const chosen = sessions[data.members.findIndex((m) => m.key === data.lead)]?.id || data.lead;
  const lead = members.includes(chosen) ? chosen : target?.lead || members[0];
  const room = target
    ? { ...target, members, lead }
    : {
      id: makeId(), workspace: workspaceId, title, goal: data.goal.trim(),
      creator: "human", lead, members, stage: "discussion", revision: 1,
      feedback: "", conditions: [], proposal: null, plan: [], decisions: [], artifacts: [],
      messages: [{ id: makeId(), from: "human", time: "Now", text: data.goal.trim() }],
    };
  return {
    room,
    sessions,
    state: {
      ...state,
      sessions: [...state.sessions, ...sessions],
      rooms: target ? state.rooms.map((r) => r.id === room.id ? room : r) : [...state.rooms, room],
    },
  };
}
