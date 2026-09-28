import React, { useState } from "react";
import Markdown from "react-markdown";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Code2,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  GitCompareArrows,
  Hash,
  ListChecks,
  LockKeyhole,
  MessageSquare,
  Play,
  ShieldCheck,
  SquareTerminal,
  Star,
  User,
  Users,
} from "lucide-react";
import { artifactContent, providerLabel, assignmentState } from "./model.js";
import { tokenizeMentions } from "./mentions.js";

const icons = {
  claude: new URL("../assets/claude.svg", import.meta.url).href,
  codex: new URL("../assets/codex.svg", import.meta.url).href,
  codexLight: new URL("../assets/codex-light.svg", import.meta.url).href,
};
function Avatar({ session }) {
  return session ? (
    <span
      className={`message-avatar provider ${session.provider}`}
      role="img"
      aria-label={providerLabel[session.provider]}
    >
      <img src={icons[session.provider]} alt="" />
      {session.provider === "codex" && (
        <img className="dark-logo" src={icons.codexLight} alt="" />
      )}
    </span>
  ) : (
    <span className="message-avatar human">
      <User size={15} />
    </span>
  );
}

export function Message({ message, session, sessions, onArtifact }) {
  if (message.from === "system")
    return (
      <div className="system-message">
        <CheckCheck size={13} />
        <span>{message.text}</span>
        <time>{message.time}</time>
      </div>
    );
  return (
    <article className="message">
      <Avatar session={session} />
      <div className="message-content">
        <div className="message-heading">
          <strong>{session ? `${session.role}` : "You"}</strong>
          {session && <span className="session-code">{session.code}</span>}
          {message.tag && (
            <span
              className={`message-tag ${message.tag.includes("resolved") ? "resolved" : ""}`}
            >
              {message.tag}
            </span>
          )}
          <time>{message.time}</time>
        </div>
        <p>
          {tokenizeMentions(message.text, sessions).map((token, i) =>
            token.session ? (
              <span key={i} className={`mention-chip ${token.session.provider}`}>
                @{token.session.code} {token.session.role}
              </span>
            ) : (
              token.text
            ),
          )}
        </p>
        {message.artifact && (
          <button
            className="message-attachment"
            onClick={() => onArtifact(message.artifact)}
          >
            <FileText size={14} />
            {message.artifact}
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
    </article>
  );
}

export function PlanView({
  room,
  members,
  onSession,
  onStart,
  onConversation,
}) {
  const executing = ["executing", "review", "complete"].includes(room.stage);
  const plan = room.plan || [];
  return (
    <div className="detail-scroll">
      <div className="view-heading">
        <div>
          <h2>One plan. Clear ownership.</h2>
          <p>Agreed responsibilities, handoffs and completion criteria.</p>
        </div>
        <span className="badge">Revision {room.revision}</span>
      </div>
      {!plan.length ? (
        <div className="empty-room">
          <ListChecks size={30} />
          <h2>No agreed assignments yet.</h2>
          <p>
            The lead will propose the scope and responsibilities after the team
            discusses your task.
          </p>
          <button className="button secondary" onClick={onConversation}>
            Go to discussion
            <ArrowRight size={14} />
          </button>
        </div>
      ) : (
        <>
          <div className="plan-summary">
            <ShieldCheck size={19} />
            <div>
              <strong>
                {executing
                  ? "Approved plan in progress"
                  : room.stage === "ready"
                    ? "Approved, ready to start"
                    : "Implementation awaits your approval"}
              </strong>
              <p>
                {executing
                  ? "Each assignment has an owner. Review follows the implementation result."
                  : "Discussion and research can continue. Code changes begin after you start implementation."}
              </p>
            </div>
            {room.stage === "ready" && (
              <button className="button primary small" onClick={onStart}>
                <Play size={13} />
                Start
              </button>
            )}
          </div>
          <div
            className="plan-table"
            role="table"
            aria-label="Room assignments"
          >
            <div className="plan-table-head" role="row">
              <span>Assignment / scope</span>
              <span>Owner</span>
              <span>State</span>
            </div>
            {plan.map((task, index) => {
              const session = members.find((s) => s.id === task.sessionId);
              if (!session) return null;
              const state = assignmentState(room, session, task);
              return (
                <button
                  className="plan-row"
                  role="row"
                  key={task.sessionId}
                  onClick={() => onSession(session.id)}
                >
                  <div className="assignment" role="cell">
                    <span
                      className={`task-index ${state.label === "Done" ? "done" : ""}`}
                    >
                      {state.label === "Done" ? <Check size={13} /> : index + 1}
                    </span>
                    <span>
                      <strong>{task.title}</strong>
                      <code>{task.scope}</code>
                      {task.after?.length > 0 && (
                        <small>
                          After{" "}
                          {task.after
                            .map(
                              (id) =>
                                members.find((m) => m.id === id)?.role ||
                                "prior assignment",
                            )
                            .join(", ")}
                        </small>
                      )}
                    </span>
                  </div>
                  <div className="task-owner" role="cell">
                    <Avatar session={session} />
                    <span>
                      {session.role}
                      <small>{session.code}</small>
                    </span>
                  </div>
                  <span role="cell" className={`task-state ${state.tone}`}>
                    {state.label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="plan-bottom-grid">
            <section>
              <h3>
                <ListChecks size={17} />
                Done means
              </h3>
              <ul className="criteria-list">
                {(room.id === "refunds"
                  ? [
                      "Refunds never exceed the remaining balance",
                      "Retries do not create duplicate refunds",
                      "Concurrent requests are tested",
                      "The diff is reviewed by a second agent",
                    ]
                  : [
                      "The shared goal is addressed",
                      "Contributors share findings and artifacts",
                      "The result is checked against the agreed criteria",
                    ]
                )
                  .concat(room.conditions || [])
                  .map((criterion, i) => (
                    <li key={i}>{criterion}</li>
                  ))}
              </ul>
            </section>
            <section>
              <h3>
                <GitBranch size={17} />
                Change boundaries
              </h3>
              <p>
                {room.id === "refunds"
                  ? "Backend and QA use separate session worktrees. The reviewer reads the diff. The lead coordinates integration."
                  : "The lead assigns a separate scope to each contributor. Implementation sessions can use separate worktrees."}
              </p>
              <div className="scope-note">
                Assignments are a coordination agreement; Git still checks for
                conflicts.
              </div>
            </section>
          </div>
          {room.stage === "awaiting" && (
            <button className="button secondary" onClick={onConversation}>
              Go to the proposal
              <ArrowRight size={15} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function DecisionsView({ room, onConversation }) {
  return (
    <div className="detail-scroll">
      <div className="view-heading">
        <div>
          <h2>How the team got here</h2>
          <p>
            Keep the reasoning, the disagreement and your decision together.
          </p>
        </div>
        <CheckCheck size={22} />
      </div>
      {room.id === "refunds" && (
        <div className="decision-timeline">
          <div className="timeline-entry">
            <span className="timeline-node" />
            <div>
              <span className="muted">Revision 1 · 10:47</span>
              <h3>Validate against the payment amount</h3>
              <p>
                The first proposal did not account for earlier partial refunds.
              </p>
              <span className="badge orange">Superseded</span>
            </div>
          </div>
          <div className="timeline-entry">
            <span className="timeline-node concern" />
            <div>
              <span className="muted">Reviewer · S03 · 10:49</span>
              <h3>A second refund can exceed the balance</h3>
              <p>
                Move the remaining-balance check inside the transaction. Cover
                concurrent attempts with an integration test.
              </p>
              <span className="badge green">
                <Check size={12} />
                Resolved in revision 2
              </span>
            </div>
          </div>
        </div>
      )}
      {room.decisions.map((decision, i) => (
        <div className="recorded-decision" key={`${decision.revision}-${i}`}>
          <div className="field-title">
            <strong>Revision {decision.revision}</strong>
            <span
              className={`badge ${decision.status === "approved" ? "green" : "orange"}`}
            >
              {decision.status === "approved"
                ? "Approved by you"
                : "Returned by you"}
            </span>
          </div>
          <p>{decision.text}</p>
          <span className="muted">{decision.at} · saved in the room</span>
        </div>
      ))}
      {room.stage === "awaiting" && (
        <div className="pending-decision">
          <div>
            <span className="badge orange">Waiting for you</span>
            <h3>Revision {room.revision}</h3>
            <p>
              The team has addressed the concern. Your approval records the
              plan; execution is a separate step.
            </p>
          </div>
          <button className="button primary" onClick={onConversation}>
            Review proposal
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {room.stage === "discussion" && !room.decisions.length && (
        <div className="empty-room">
          <CheckCheck size={30} />
          <h2>No decisions yet.</h2>
          <p>
            The lead will bring a proposal here when the team has compared its
            positions.
          </p>
        </div>
      )}
    </div>
  );
}

export function MaterialsView({ room, members, onOpen, onSession }) {
  return (
    <div className="detail-scroll">
      <div className="view-heading">
        <div>
          <h2>Context without the copy-paste</h2>
          <p>
            Analyses, decisions and session summaries available to the team.
          </p>
        </div>
        <FileText size={23} />
      </div>
      {room.artifacts.length ? (
        <div className="material-list">
          {room.artifacts.map((id, i) => (
            <button
              className="material-row"
              key={id}
              onClick={() => onOpen(id)}
            >
              <span className="material-icon">
                <FileText size={20} />
              </span>
              <div>
                <span className="muted">{artifactContent[id]?.kind}</span>
                <h3>{artifactContent[id]?.title}</h3>
                <code>{id}</code>
              </div>
              <span className="material-author">
                {artifactContent[id]?.author}
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-materials">
          <FileText size={24} />
          <p>
            No shared artifacts yet. Session summaries will collect here as the
            work progresses.
          </p>
        </div>
      )}
      <h3 className="section-heading">Session context</h3>
      <div className="session-context-list">
        {members.map((s) => (
          <button key={s.id} onClick={() => onSession(s.id)}>
            <Avatar session={s} />
            <div>
              <strong>
                {s.code} {s.role}
              </strong>
              <p>{s.result || s.task}</p>
              <span className="muted">
                {s.contextFrom.length
                  ? `Inherits from ${s.contextFrom.map((id) => members.find((m) => m.id === id)?.role || "a session").join(", ")}`
                  : "Uses the workspace goal and room decisions"}
              </span>
            </div>
            <ArrowUpRight size={16} />
          </button>
        ))}
      </div>
      <div className="context-bottom-note">
        <Users size={17} />
        <span>
          Start the next session with this context. The findings stay attached
          to the workspace.
        </span>
      </div>
    </div>
  );
}

export function TerminalView({
  session,
  workspace,
  room,
  onRoom,
  input,
  onInput,
  lines,
  onSend,
  onAllow,
}) {
  const blocked = session.status === "blocked",
    refund = room?.id === "refunds";
  return (
    <div className="terminal-view">
      <div className="surface-toolbar">
        <div>
          <SquareTerminal size={15} />
          <strong>
            {session.code} {session.role}
          </strong>
          <span className="badge">{providerLabel[session.provider]}</span>
        </div>
        {room && (
          <button className="text-button" onClick={onRoom}>
            <Hash size={14} />
            {room.title}
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      <div className="terminal-context">
        <GitBranch size={13} />
        <code>
          harnas/{session.code.toLowerCase()}-
          {session.role.toLowerCase().replaceAll(" ", "-")}
        </code>
        <span>Sample terminal</span>
      </div>
      <div className="terminal-output">
        <div className="cli-brand">
          <Avatar session={session} />
          <div>
            <strong>{providerLabel[session.provider]}</strong>
            <small>
              ~/Projects/{workspace.project} · {session.code}
            </small>
          </div>
        </div>
        <div className="terminal-line dim">Context received from Harnas</div>
        <div className="terminal-context-box">
          <span>Workspace</span> {workspace.title}
          <br />
          <span>Room</span> {room?.title || "No room"}
          <br />
          <span>Task</span> {session.task}
          <br />
          <span>Context</span> shared goal, summaries
          {room ? ", room decisions" : ""}
        </div>
        <div className="terminal-line">
          <span className="terminal-prompt">❯</span> {session.task}
        </div>
        {refund ? (
          <>
            <p className="terminal-line">
              I have the shared analysis and decision brief. I’ll check the
              agreed scope before making changes.
            </p>
            <div className="tool-line">
              <span className="tool-dot" />
              Read <strong>docs/refund-contract.md</strong>
              <span className="dim">68 lines</span>
            </div>
            <div className="tool-line">
              <span className="tool-dot" />
              Read <strong>{session.scope}</strong>
              <span className="dim">124 lines</span>
            </div>
            <p className="terminal-line">
              The remaining balance must be checked inside the transaction.
              <br />
              The existing idempotency key can be reused.
            </p>
          </>
        ) : (
          <p className="terminal-line">
            Workspace goal: {workspace.goal || "Waiting for a shared goal."}
            <br />
            {room
              ? "Room context is available. I will share findings with the team."
              : "This session is not in a room. You can add it to a room from its member settings."}
          </p>
        )}
        {blocked ? (
          <div className="terminal-permission">
            <div>
              <LockKeyhole size={17} />
              <strong>Permission requested by the CLI</strong>
            </div>
            <p>Run the refund tests in this session’s worktree?</p>
            <code>pnpm test -- refunds</code>
            <div className="button-row">
              <button className="button primary small" onClick={onAllow}>
                Allow once
              </button>
              <button className="button secondary small" onClick={onRoom}>
                Back to room
              </button>
            </div>
            <small>
              This permission belongs to this CLI session. Room approval does
              not answer it.
            </small>
          </div>
        ) : session.status === "done" ? (
          <div className="terminal-result">
            <Check size={16} />
            Result shared with {room ? "the room" : "the workspace"}.
            <p>Summary and artifacts are available in shared context.</p>
          </div>
        ) : (
          <div className="terminal-line terminal-wait">
            <span className="status-dot" />
            {session.status === "working"
              ? "Working on the approved assignment…"
              : "Waiting for the next instruction."}
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i}>
            <div className="terminal-line">
              <span className="terminal-prompt">❯</span> {line}
            </div>
            <div className="terminal-line dim">
              Preview input recorded. No command was executed.
            </div>
          </div>
        ))}
      </div>
      <form
        className="terminal-composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <span>❯</span>
        <input
          aria-label="Sample terminal input"
          placeholder="Sample terminal input…"
          value={input}
          onChange={(e) => onInput(e.target.value)}
        />
        <button
          className="icon-button"
          aria-label="Submit sample input"
          disabled={!input.trim()}
        >
          <ArrowRight size={17} />
        </button>
      </form>
    </div>
  );
}

export function ArtifactView({ id, onRoom }) {
  const doc = artifactContent[id];
  return (
    <div className="document-view">
      <div className="surface-toolbar">
        <div>
          <FileText size={15} />
          <strong>{id}</strong>
        </div>
        <button className="text-button" onClick={onRoom}>
          <ArrowLeft size={14} />
          Back to room
        </button>
      </div>
      <div className="document-scroll">
        <div className="document-meta">
          <span>{doc?.kind || "Workspace material"}</span>
          <span>{doc?.author || "Shared by the room"}</span>
        </div>
        <article className="markdown-document">
          <Markdown>
            {doc?.body ||
              "# Shared material\n\nThe document is available to the room."}
          </Markdown>
        </article>
        <div className="document-source">
          <Users size={16} />
          Shared with the room · available in session handoffs
        </div>
      </div>
    </div>
  );
}

const diffLines = [
  ["context", "export async function refundPayment(input: RefundInput) {"],
  ["context", "  return db.transaction(async (tx) => {"],
  ["context", "    const payment = await tx.payment.lock(input.paymentId);"],
  ["removed", "    if (input.amount > payment.amount) {"],
  ["added", "    const previous = await tx.refunds.byKey(input.key);"],
  ["added", "    if (previous) return previous;"],
  ["added", ""],
  ["added", "    const refunded = await tx.refunds.total(payment.id);"],
  ["added", "    const remainingBalance = payment.amount - refunded;"],
  ["added", ""],
  ["added", "    if (input.amount > remainingBalance) {"],
  ["context", "      throw new RefundTooLarge('Amount exceeds balance');"],
  ["context", "    }"],

  ["context", ""],
  ["context", "    return tx.refunds.create({"],
  ["context", "      paymentId: payment.id,"],
  ["context", "      amount: input.amount,"],
  ["context", "      currency: payment.currency,"],
  ["context", "      idempotencyKey: input.key,"],
  ["context", "    });"],
  ["context", "  });"],
  ["context", "}"],
];
const testDiff = [
  ["context", "describe('partial refunds', () => {"],
  ["added", "  it('uses the remaining balance', async () => {"],
  ["added", "    const payment = await createPayment({ amount: 100 });"],
  ["added", "    await refund(payment.id, { amount: 70, key: 'first' });"],
  [
    "added",
    "    await expect(refund(payment.id, { amount: 40, key: 'second' }))",
  ],
  ["added", "      .rejects.toThrow(RefundTooLarge);"],
  ["added", "  });"],
  ["added", ""],
  ["added", "  it('returns the same refund on retry', async () => {"],
  ["added", "    const { id } = await createPayment({ amount: 100 });"],
  ["added", "    const first = await refund(id, { amount: 70, key: 'same' });"],
  ["added", "    const retry = await refund(id, { amount: 70, key: 'same' });"],
  ["added", "    expect(retry.id).toBe(first.id);"],
  ["added", "  });"],
  ["context", "});"],
];
const repositoryLines = [
  [
    "context",
    "export function transaction<T>(fn: (tx: Transaction) => Promise<T>) {",
  ],
  ["context", "  return database.transaction(fn);"],
  ["context", "}"],
  ["context", ""],
  ["context", "// The existing repository provides payment-level locking."],
  ["context", "// Refund operations reuse this transaction boundary."],
];
export function DiffView({ id = "refund.ts", onRoom, onReview }) {
  const isTest = id.includes("spec"),
    isRepository = id.includes("repository");
  const shownLines = isTest
    ? testDiff
    : isRepository
      ? repositoryLines
      : diffLines;
  const path = isTest
    ? "tests/refunds.spec.ts"
    : isRepository
      ? "src/payments/repository.ts"
      : "src/payments/refund.ts";
  const [reviewed, setReviewed] = useState(false);
  return (
    <div className="diff-view">
      <div className="surface-toolbar">
        <div>
          <GitCompareArrows size={15} />
          <strong>Review changes</strong>
        </div>
        <button className="text-button" onClick={onRoom}>
          <ArrowLeft size={14} />
          Room
        </button>
      </div>
      <div className="diff-summary">
        <span className="diff-branch">
          <GitBranch size={14} />
          harnas/w-0001/s-02 <ArrowRight size={13} /> main
        </span>
        <span className="diff-count">
          <b>+{shownLines.filter((l) => l[0] === "added").length}</b>
          <em>−{shownLines.filter((l) => l[0] === "removed").length}</em>
        </span>
      </div>
      <div className="diff-file-heading">
        <FileCode2 size={15} />
        <strong>{path}</strong>
        <span className="badge">Sample diff</span>
      </div>
      <div className="diff-code">
        {shownLines.map(([type, line], i) => (
          <div key={i} className={`diff-line ${type}`}>
            <span className="line-number">{i + 21}</span>
            <span className="diff-sign">
              {type === "added" ? "+" : type === "removed" ? "−" : " "}
            </span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
      <div className="diff-review-note">
        <ShieldCheck size={19} />
        <div>
          <strong>Review against the agreed contract</strong>
          <p>
            The sample checks idempotency before the remaining balance. Verify
            that retry and concurrency tests cover the agreed behavior.
          </p>
        </div>
      </div>
      <footer className="diff-footer">
        <span>
          {reviewed
            ? "File marked as reviewed in this preview."
            : "Review is recorded separately from accepting the room result."}
        </span>
        <button
          className={`button ${reviewed ? "secondary" : "primary"}`}
          onClick={() => setReviewed((x) => !x)}
        >
          <Check size={14} />
          {reviewed ? "Reviewed" : "Mark viewed"}
        </button>
      </footer>
    </div>
  );
}

export function FilesPanel({ onOpen, onDiff, workspace }) {
  const [expanded, setExpanded] = useState({
    docs: true,
    src: true,
    tests: true,
  });
  if (workspace.id !== "payments")
    return (
      <div className="empty-panel">
        <Folder size={25} />
        <h3>No sample files</h3>
        <p>
          Room messages and session summaries are available in Context. File
          previews are provided in Payments.
        </p>
      </div>
    );
  return (
    <div className="files-panel">
      <div className="panel-branch">
        <Folder size={15} />
        <strong>{workspace.project}</strong>
        <span>{workspace.branch}</span>
      </div>
      {[
        [
          "docs",
          [
            ["refund-contract.md", "document"],
            ["refund-analysis.md", "document"],
            ["test-plan.md", "document"],
          ],
        ],
        [
          "src",
          [
            ["payments/refund.ts", "code"],
            ["payments/repository.ts", "code"],
          ],
        ],
        ["tests", [["refunds.spec.ts", "code"]]],
      ].map(([folder, files]) => (
        <div key={folder}>
          <button
            className="folder-row"
            onClick={() => setExpanded((e) => ({ ...e, [folder]: !e[folder] }))}
          >
            {expanded[folder] ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
            <Folder size={15} />
            {folder}
          </button>
          {expanded[folder] &&
            files.map(([name, kind]) => (
              <button
                className="file-tree-row"
                key={name}
                onClick={() =>
                  kind === "document" ? onOpen(name) : onDiff(name)
                }
              >
                {kind === "document" ? (
                  <FileText size={14} />
                ) : (
                  <FileCode2 size={14} />
                )}
                <span>{name}</span>
                {name.includes("refund") && kind === "code" && (
                  <span className="modified">M</span>
                )}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

export function ChangesPanel({ workspace, onDiff, onOpen }) {
  if (workspace.id !== "payments")
    return (
      <div className="empty-panel">
        <GitCompareArrows size={25} />
        <h3>No changes yet</h3>
        <p>Changes appear here when a session produces work in its worktree.</p>
      </div>
    );
  return (
    <div className="changes-panel">
      <div className="panel-branch">
        <GitBranch size={15} />
        <strong>Session worktree</strong>
      </div>
      <label className="field">
        Session
        <select aria-label="Changes for session" defaultValue="backend">
          <option value="backend">S02 · Backend</option>
        </select>
      </label>
      <div className="changes-summary">
        <strong>3 changed files</strong>
        <span>
          <b>+32</b> <em>−1</em>
        </span>
      </div>
      {[
        "src/payments/refund.ts",
        "tests/refunds.spec.ts",
        "docs/refund-contract.md",
      ].map((name, i) => (
        <button
          className="changed-file"
          key={name}
          onClick={() =>
            name.endsWith(".md") ? onOpen("refund-contract.md") : onDiff(name)
          }
        >
          <FileCode2 size={14} />
          <span>{name}</span>
          <span className="modified">{i === 2 ? "A" : "M"}</span>
        </button>
      ))}
      <div className="change-branch">
        <GitBranch size={14} />
        <span>
          harnas/w-0001/s-02
          <br />
          <small>base: main</small>
        </span>
      </div>
      <button
        className="button secondary full"
        onClick={() => onDiff("refund.ts")}
      >
        Open diff
        <GitCompareArrows size={15} />
      </button>
      <p className="context-explainer">
        Review each session’s worktree before integrating its changes.
      </p>
      <div className="merge-note">
        <ShieldCheck size={15} />
        <span>
          Integration belongs to the real host. This preview does not create
          commits or merge branches.
        </span>
      </div>
    </div>
  );
}
