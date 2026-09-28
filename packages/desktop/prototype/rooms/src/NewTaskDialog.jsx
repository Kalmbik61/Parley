import React, { useState } from "react";
import { Plus, X, Star, GitBranch, Play, Users, ShieldCheck, ChevronDown, ArrowRight } from "lucide-react";
import { providerLabel } from "./model.js";

export function NewTaskDialog({ Modal, Provider, workspace, sessions, task, onClose, onCreate }) {
  const [title, setTitle] = useState(task?.title || "");
  const [goal, setGoal] = useState(task?.goal || "");
  const [members, setMembers] = useState([{ key: "a1", provider: "claude", role: "Agent", model: "", effort: "default", task: "" }]);
  const [existing, setExisting] = useState([]);
  const [lead, setLead] = useState(task?.lead || "a1");
  const [worktree, setWorktree] = useState(true);
  const [launchNow, setLaunchNow] = useState(true);
  const [contextFrom, setContextFrom] = useState([]);
  const already = task?.members || [];
  const count = members.length + existing.length + already.length;
  const candidates = sessions.filter((s) => !existing.includes(s.id) && !already.includes(s.id));
  const update = (key, patch) => setMembers((list) => list.map((m) => m.key === key ? { ...m, ...patch } : m));
  const remove = (key) => {
    setMembers((list) => list.filter((m) => m.key !== key));
    setExisting((list) => list.filter((id) => id !== key));
    if (lead === key) setLead(already[0] || members.find((m) => m.key !== key)?.key || existing.find((id) => id !== key));
  };
  const leadRole = members.find((m) => m.key === lead)?.role || sessions.find((s) => s.id === lead)?.role || "Agent";
  return (
    <Modal title={task ? "Add agents" : "New task"} subtitle={`${workspace.project} / ${workspace.title}`} onClose={onClose} wide>
      <form className="task-create" onSubmit={(e) => {
        e.preventDefault();
        onCreate({ title, goal, members, existing, lead, worktree, launchNow, contextFrom, targetId: task?.id });
      }}>
        <div className="task-create-grid">
          <div className="task-create-main">
            {task ? <div className="task-existing-heading"><h3>{task.title}</h3><p>{task.goal}</p></div> : <>
              <label className="field">Task name<input autoComplete="off" placeholder="e.g. Make checkout resilient" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} /></label>
              <label className="field">What needs to be done?<textarea rows={3} placeholder="Describe the outcome, constraints and what the agents should do." value={goal} onChange={(e) => setGoal(e.target.value)} required /></label>
            </>}
            <div className="field-title"><strong>{task ? "Participants" : "Agents"}</strong><span>{count === 1 ? "One agent, one conversation" : `${count} agents, one shared conversation`}</span></div>
            <div className="task-agent-list">
              {[...already, ...existing].map((id) => {
                const session = sessions.find((s) => s.id === id);
                if (!session) return null;
                return <div className="task-existing-agent" key={id}>
                  <Provider provider={session.provider} small />
                  <div><strong>{session.code} {session.role}</strong><small>{providerLabel[session.provider]} · keeps its context and current state</small></div>
                  {count > 1 && <button type="button" aria-label={`Make ${session.role} lead`} aria-pressed={lead === id} className={`lead-pick ${lead === id ? "selected" : ""}`} onClick={() => setLead(id)}><Star size={13} />{lead === id ? "Lead" : "Make lead"}</button>}
                  {!already.includes(id) && <button type="button" aria-label={`Remove ${session.role}`} onClick={() => remove(id)}><X size={15} /></button>}
                </div>;
              })}
              {members.map((member, index) => <section className="task-agent" key={member.key} aria-label={`New agent ${index + 1}`}>
                <div className="task-agent-heading"><Provider provider={member.provider} small /><span>New agent {index + 1}</span><div className="grow" />
                  {count > 1 && <button type="button" className={`lead-pick ${lead === member.key ? "selected" : ""}`} aria-label={`Make ${member.role || `agent ${index + 1}`} lead`} aria-pressed={lead === member.key} onClick={() => setLead(member.key)}><Star size={13} />{lead === member.key ? "Lead" : "Make lead"}</button>}
                  <button type="button" aria-label={`Remove new agent ${index + 1}`} disabled={count <= 1} onClick={() => remove(member.key)}><X size={15} /></button>
                </div>
                <div className="task-agent-fields">
                  <label className="field">Name / role<input aria-label={`Role for agent ${index + 1}`} value={member.role} onChange={(e) => update(member.key, { role: e.target.value })} maxLength={32} /></label>
                  <label className="field">Provider<select aria-label={`Provider for agent ${index + 1}`} value={member.provider} onChange={(e) => update(member.key, { provider: e.target.value, model: "", effort: "default" })}><option value="claude">Claude Code</option><option value="codex">Codex</option><option disabled>GLM — setup required</option></select></label>
                  <label className="field">Model <span className="planned-label" title="Proposed per-agent setting. Current launches inherit the CLI configuration.">Proposed</span><input aria-label={`Model for agent ${index + 1}`} placeholder="CLI default" value={member.model} onChange={(e) => update(member.key, { model: e.target.value })} /></label>
                  <label className="field">Effort <span className="planned-label">Proposed</span><select aria-label={`Effort for agent ${index + 1}`} value={member.effort} onChange={(e) => update(member.key, { effort: e.target.value })}><option value="default">CLI default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
                </div>
                <details className="agent-instructions"><summary>Individual instructions <ChevronDown size={13} /></summary><textarea aria-label={`Instructions for agent ${index + 1}`} rows={2} placeholder="Optional. Otherwise this agent receives the shared task." value={member.task} onChange={(e) => update(member.key, { task: e.target.value })} /></details>
              </section>)}
            </div>
            <div className="add-agent-actions">
              <button type="button" className="button secondary small" onClick={() => {
                const key = crypto.randomUUID();
                setMembers((list) => [...list, { key, provider: "claude", role: "", model: "", effort: "default", task: "" }]);
                if (!lead) setLead(key);
              }}><Plus size={14} />Add agent</button>
              {candidates.length > 0 && <select aria-label="Add existing agent" value="" onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                setExisting((list) => [...list, id]);
                if (!lead) setLead(id);
              }}><option value="">Add existing agent…</option>{candidates.map((s) => <option key={s.id} value={s.id}>{s.code} {s.role} · {providerLabel[s.provider]}</option>)}</select>}
            </div>
          </div>
          <aside className="task-create-aside" aria-label="Launch settings">
            <h3>Launch settings</h3>
            <label className="launch-check"><input type="checkbox" checked={launchNow} onChange={(e) => setLaunchNow(e.target.checked)} /><div><strong>Start new agents</strong><small>Uncheck to prepare the task first.</small></div></label>
            <label className="field">Working folder<select value={worktree ? "isolated" : "shared"} onChange={(e) => setWorktree(e.target.value === "isolated")}><option value="isolated">Separate worktree per agent</option><option value="shared">Shared project folder</option></select></label>
            <div className="launch-path"><GitBranch size={14} /><span>Base branch <strong>{workspace.branch}</strong></span></div>
            <p className="launch-help">{worktree ? "Each new agent gets an isolated branch. Review and merge its changes in the workspace." : "New agents edit the same folder. Give them separate areas of responsibility."}</p>
            <label className="field">Inherit context from<select aria-label="Inherit context from" value={contextFrom[0] || ""} onChange={(e) => setContextFrom(e.target.value ? [e.target.value] : [])}><option value="">Start with the task only</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.code} {s.role}</option>)}</select></label>
            <p className="launch-help">Summaries, decisions and artifacts stay attached to the handoff.</p>
            {count > 1 && <div className="launch-summary"><Star size={16} /><div><strong>{leadRole || "Agent"} coordinates</strong><p>The lead follows your request, brings questions to you and keeps the conversation visible.</p></div></div>}
            <div className="launch-summary"><ShieldCheck size={16} /><div><strong>You keep the controls</strong><p>Agent permission requests open in their terminal. Adding a teammate never answers those requests.</p></div></div>
            <p className="launch-help proposed-help">Model and effort selection are proposed. Available choices will depend on the provider.</p>
          </aside>
        </div>
        <footer className="modal-footer"><span className="muted"><Users size={13} /> {count} {count === 1 ? "agent" : "agents"} · {members.length} new</span><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={!title.trim() || !goal.trim() || count < 1 || (task && members.length + existing.length === 0)} type="submit">{launchNow && members.length ? <Play size={14} /> : <ArrowRight size={14} />}{task ? "Add agents" : launchNow && members.length ? "Launch task" : "Create task"}</button></footer>
      </form>
    </Modal>
  );
}
