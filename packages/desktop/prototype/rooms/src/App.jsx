import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Clock3,
  Code2,
  Command,
  CornerDownLeft,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Hash,
  Inbox,
  ListChecks,
  Maximize2,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Paperclip,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Star,
  Sun,
  Users,
  X,
} from "lucide-react";
import {
  createInitialState,
  transitionRoom,
  artifactContent,
  providerLabel,
  stageLabel,
  VERSION,
} from "./model.js";
import {
  Message,
  PlanView,
  DecisionsView,
  MaterialsView,
  TerminalView,
  ArtifactView,
  DiffView,
  FilesPanel,
  ChangesPanel,
} from "./views.jsx";
import "./styles.css";
import { MentionEditor } from "./MentionEditor.jsx";
import { NewTaskDialog } from "./NewTaskDialog.jsx";
import { createTask, launchPrepared } from "./task-creation.js";
import { SettingsPreview } from "./SettingsPreview.jsx";
import { mentionedSessions } from "./mentions.js";

const KEY = "harnas-rooms-organic-v1";
const icons = {
  claude: new URL("../assets/claude.svg", import.meta.url).href,
  codex: new URL("../assets/codex.svg", import.meta.url).href,
  codexLight: new URL("../assets/codex-light.svg", import.meta.url).href,
};
const initialTabs = [
  { kind: "room", id: "refunds" },
  { kind: "session", id: "pay-s2" },
];
const statusText = {
  waiting: "Waiting for plan",
  working: "Working",
  blocked: "Needs you",
  queued: "Not started",
  idle: "Idle",
  done: "Result ready",
};
const now = () =>
  new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
const tabKey = (tab) => `${tab.workspace || "payments"}:${tab.kind}:${tab.id}`;
function load() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    return value?.version === VERSION &&
      Array.isArray(value.rooms) &&
      Array.isArray(value.sessions) &&
      Array.isArray(value.workspaces)
      ? value
      : createInitialState();
  } catch {
    return createInitialState();
  }
}
function Provider({ provider, small = false }) {
  return (
    <span
      className={`provider ${provider} ${small ? "small" : ""}`}
      role="img"
      aria-label={providerLabel[provider] || provider}
    >
      {icons[provider] ? <img src={icons[provider]} alt="" /> : <span className="provider-fallback">{(providerLabel[provider] || provider || "?").slice(0, 1).toUpperCase()}</span>}
      {provider === "codex" && (
        <img className="dark-logo" src={icons.codexLight} alt="" />
      )}
    </span>
  );
}
function IconButton({ label, children, onClick, className = "", ...props }) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}
function Badge({ children, tone = "" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function CompactTeam({ members, Provider }) {
  const counts = members.reduce((result, session) => {
    result[session.provider] = (result[session.provider] || 0) + 1;
    return result;
  }, {});
  const working = members.filter((s) => s.status === "working").length;
  return <div className="compact-team" aria-label={`${members.length} ${members.length === 1 ? "agent" : "agents"} in this task`}>
    <div className="compact-providers">{Object.entries(counts).map(([provider, count]) =>
      <span className="compact-provider" key={provider} title={`${providerLabel[provider] || provider}: ${count}`}><Provider provider={provider} small /><span>{count}</span></span>
    )}</div>
    <span className="compact-total">{members.length} {members.length === 1 ? "agent" : "agents"}</span>
    {working > 0 && <span className="compact-working" title={`${working} currently working`}><i />{working} active</span>}
  </div>;
}
function Status({ value, label }) {
  return (
    <span className={`session-status ${value}`}>
      <span className="status-dot" />
      {label || statusText[value]}
    </span>
  );
}

function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const box = ref.current;
    (
      box.querySelector("input,textarea") || box.querySelector("button")
    )?.focus();
    const keys = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const elements = [
          ...box.querySelectorAll(
            'button:not([disabled]),input,textarea,select,[tabindex="0"]',
          ),
        ].filter((el) => el.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    box.addEventListener("keydown", keys);
    return () => {
      box.removeEventListener("keydown", keys);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

function WorkspaceDialog({ onClose, onCreate }) {
  const [title, setTitle] = useState(""),
    [goal, setGoal] = useState("");
  return (
    <Modal
      title="New workspace"
      subtitle="A shared goal, its rooms, and all the work around it."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(title.trim(), goal.trim());
        }}
      >
        <div className="modal-body">
          <label className="field">
            Project
            <div className="static-field">
              <Folder size={16} />
              shop<span className="muted">~/Projects/shop</span>
            </div>
          </label>
          <label className="field">
            Workspace name
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Checkout redesign"
              maxLength={64}
            />
          </label>
          <label className="field">
            Goal
            <textarea
              rows={4}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What does done look like?"
            />
          </label>
        </div>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!title.trim()}>
            Create workspace
            <ArrowRight size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export default function App() {
  const [model, setModel] = useState(load),
    [theme, setTheme] = useState(
      () => localStorage.getItem("harnas-prototype-theme") || "light",
    );
  const [workspaceId, setWorkspaceId] = useState("payments"),
    [tabs, setTabs] = useState(initialTabs),
    [active, setActive] = useState(initialTabs[0]);
  const [view, setView] = useState("conversation"),
    [rightTab, setRightTab] = useState("context"),
    [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 760),
    [rightOpen, setRightOpen] = useState(() => window.innerWidth > 1120);
  const [modal, setModal] = useState(null),
    [toast, setToast] = useState(""),
    [drafts, setDrafts] = useState({}),
    [returnNote, setReturnNote] = useState(null),
    [leftWidth, setLeftWidth] = useState(260),
    [rightWidth, setRightWidth] = useState(288);
  const [paletteQuery, setPaletteQuery] = useState(""),
    [commandIndex, setCommandIndex] = useState(0),
    [collapsed, setCollapsed] = useState({}),
    [mentionIndex, setMentionIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState(undefined);
  const [dragged, setDragged] = useState(null),
    [terminalInput, setTerminalInput] = useState(""),
    [terminalLines, setTerminalLines] = useState({});
  const feedRef = useRef(null),
    composerRef = useRef(null),
    toastTimer = useRef(null),
    lastWorkspaceTab = useRef({});
  const settings = { autoLaunch: true, autoWake: true, messageRate: 20, resumeRate: 6, silenceThresholdMs: 30000, fontSize: 14, fontFamily: "SF Mono", worktreeRoot: "~/harnas/worktrees", notifications: true, ...model.settings };
  const workspace =
    model.workspaces.find((w) => w.id === workspaceId) || model.workspaces[0];
  const workspaceSessions = model.sessions.filter(
      (s) => s.workspace === workspace.id,
    ),
    workspaceRooms = model.rooms.filter((r) => r.workspace === workspace.id);
  const activeSession = model.sessions.find((s) => s.id === active?.id);
  const room =
    active?.kind === "room"
      ? model.rooms.find((r) => r.id === active.id)
      : active?.kind === "session"
        ? workspaceRooms.find((r) => r.members.includes(activeSession?.id))
        : model.rooms.find((r) => r.id === active?.originRoomId) ||
          workspaceRooms[0];
  const members = room
    ? room.members
        .map((id) => model.sessions.find((s) => s.id === id))
        .filter(Boolean)
    : [];
  const lead = members.find((s) => s.id === room?.lead);
  const draft = drafts[room?.id] || "";
  const mentionOptions =
    mentionQuery === undefined
      ? []
      : members.filter((s) =>
          `${s.code} ${s.role}`
            .toLowerCase()
            .includes(mentionQuery.toLowerCase()),
        );
  const recipients = mentionedSessions(draft, members);
  const notify = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3800);
  };
  const updateRoom = (id, fn) =>
    setModel((current) => ({
      ...current,
      rooms: current.rooms.map((r) => (r.id === id ? fn(r) : r)),
    }));
  const sessionById = (id) => model.sessions.find((s) => s.id === id);
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(model));
  }, [model]);
  useEffect(() => {
    localStorage.setItem("harnas-prototype-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (feedRef.current)
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [active?.id, view, room?.messages.length, room?.stage]);
  useEffect(() => {
    const timers = model.rooms
      .filter((r) => r.stage === "revising")
      .map((r) =>
        setTimeout(
          () =>
            updateRoom(r.id, (old) => transitionRoom(old, { type: "revised" })),
          1800,
        ),
      );
    return () => timers.forEach(clearTimeout);
  }, [model.rooms]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  function openTab(tab, workspaceOverride) {
    const ws =
      workspaceOverride ||
      tab.workspace ||
      (tab.kind === "room"
        ? model.rooms.find((r) => r.id === tab.id)?.workspace
        : tab.kind === "session"
          ? sessionById(tab.id)?.workspace
          : workspace.id);
    if (ws && ws !== workspaceId) setWorkspaceId(ws);
    const scopedTab = {
      ...tab,
      workspace: ws,
      originRoomId:
        tab.originRoomId ||
        (["artifact", "diff"].includes(tab.kind) ? room?.id : undefined),
    };
    setTabs((list) =>
      list.some((t) => tabKey(t) === tabKey(scopedTab))
        ? list
        : [...list, scopedTab],
    );
    setActive(scopedTab);
    setView("conversation");
    setReturnNote(null);
    if (window.innerWidth < 761) setLeftOpen(false);
  }
  function switchWorkspace(id) {
    lastWorkspaceTab.current[workspaceId] = active;
    setWorkspaceId(id);
    setReturnNote(null);
    const remembered = lastWorkspaceTab.current[id];
    const first = model.rooms.find((r) => r.workspace === id),
      session = model.sessions.find((s) => s.workspace === id);
    if (remembered) openTab(remembered, id);
    else if (first) openTab({ kind: "room", id: first.id }, id);
    else if (session) openTab({ kind: "session", id: session.id }, id);
    else setActive(null);
    if (window.innerWidth < 761) setLeftOpen(false);
  }
  function closeTab(tab) {
    if (tab.kind === "room") setCollapsed((items) => ({ ...items, [tab.id]: true }));
    const remaining = tabs.filter((t) => tabKey(t) !== tabKey(tab));
    setTabs(remaining);
    if (active && tabKey(active) === tabKey(tab)) {
      const next = remaining
        .filter(
          (t) =>
            (t.workspace ||
              (t.kind === "room"
                ? model.rooms.find((r) => r.id === t.id)?.workspace
                : sessionById(t.id)?.workspace)) === workspaceId,
        )
        .at(-1);
      setActive(next || null);
    }
  }
  function resize(event, side) {
    event.preventDefault();
    const start = event.clientX,
      width = side === "left" ? leftWidth : rightWidth;
    const move = (e) =>
      side === "left"
        ? setLeftWidth(Math.max(220, Math.min(360, width + e.clientX - start)))
        : setRightWidth(
            Math.max(250, Math.min(390, width + start - e.clientX)),
          );
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  }
  function roomAction(action) {
    updateRoom(room.id, (r) =>
      transitionRoom(r, { ...action, sessions: members }),
    );
    setReturnNote(null);
    if (action.type === "approve")
      notify("Plan approved. Start implementation when you are ready.");
    if (action.type === "start") {
      setModel((data) => ({
        ...data,
        sessions: data.sessions.map((s) =>
          room.members.includes(s.id)
            ? {
                ...s,
                status:
                  room.id === "refunds"
                    ? s.id === room.lead
                      ? "working"
                      : s.id === "pay-s2"
                        ? "blocked"
                        : "queued"
                    : "working",
              }
            : s,
        ),
      }));
      notify("Implementation started in the sample sessions.");
    }
    if (action.type === "return") notify("Feedback sent to the lead.");
    if (action.type === "finish")
      notify("Result accepted. Context stays with the workspace.");
  }
  function sendMessage(event) {
    event?.preventDefault();
    if (!draft.trim() || !room) return;
    updateRoom(room.id, (r) => ({
      ...r,
      messages: [
        ...r.messages,
        {
          id: crypto.randomUUID(),
          from: "human",
          time: now(),
          text: draft.trim(),
          to: recipients.map((s) => s.id),
        },
      ],
    }));
    setDrafts((value) => ({ ...value, [room.id]: "" }));
    setMentionIndex(0);
  }
  function insertMention(session) {
    composerRef.current?.insertMention(session);
    setMentionIndex(0);
  }
  function createItems(data) {
    try {
      const next = createTask(model, workspace.id, data);
      setModel(next.state);
      const tab = { kind: "room", id: next.room.id, workspace: workspace.id };
      setTabs((list) => list.some((t) => tabKey(t) === tabKey(tab)) ? list : [...list, tab]);
      setActive(tab);
      setCollapsed((items) => ({ ...items, [next.room.id]: false }));
      setView("conversation");
      setModal(null);
      notify(data.targetId ? "Agents added. The conversation stays together." : data.launchNow && next.sessions.length ? "Task launched in the preview." : "Task prepared. New agents are not started.");
    } catch (error) {
      notify(error.message);
    }
  }
  function addToRoom(roomId, sessionId) {
    const target = model.rooms.find((r) => r.id === roomId),
      session = sessionById(sessionId);
    if (!target || !session || target.workspace !== session.workspace) {
      notify("Sessions stay inside their workspace.");
      return;
    }
    if (target.members.includes(sessionId)) {
      notify(`${session.role} is already in ${target.title}.`);
      return;
    }
    updateRoom(roomId, (r) => ({
      ...r,
      members: [...r.members, sessionId],
      messages: [
        ...r.messages,
        {
          id: crypto.randomUUID(),
          from: "system",
          time: now(),
          text: `${session.code} ${session.role} joined the room.`,
        },
      ],
    }));
    notify(`${session.role} added to ${target.title}.`);
  }
  const commands = [
    {
      name: "New task",
      hint: "A task for one agent or a team",
      key: "⌘T",
      icon: Users,
      run: () => setModal("new"),
    },
    {
      name: "New workspace",
      hint: "Start a new shared goal",
      key: "⌘N",
      icon: Plus,
      run: () => setModal("workspace"),
    },
    ...model.rooms.map((r) => ({
      name: r.title,
      hint: `Room in ${model.workspaces.find((w) => w.id === r.workspace)?.title}`,
      icon: Hash,
      run: () => openTab({ kind: "room", id: r.id }, r.workspace),
    })),
    ...model.sessions.map((s) => ({
      name: `${s.code} ${s.role}`,
      hint: `${providerLabel[s.provider]} · ${model.workspaces.find((w) => w.id === s.workspace)?.title}`,
      icon: SquareTerminal,
      run: () => openTab({ kind: "session", id: s.id }, s.workspace),
    })),
    {
      name: "Toggle left sidebar",
      hint: "More room for your work",
      key: "⌘B",
      icon: PanelLeft,
      run: () => setLeftOpen((x) => !x),
    },
    {
      name: "Toggle context panel",
      hint: "Files, shared context, and changes",
      key: "⌘L",
      icon: PanelRight,
      run: () => setRightOpen((x) => !x),
    },
    {
      name:
        theme === "light" ? "Switch to dark theme" : "Switch to light theme",
      hint: "Organic appearance",
      icon: theme === "light" ? Moon : Sun,
      run: () => setTheme((x) => (x === "light" ? "dark" : "light")),
    },
    {
      name: "Settings & prototype scenarios",
      hint: "Appearance, providers, and sample states",
      icon: Settings2,
      run: () => setModal("settings"),
    },
  ];
  const filteredCommands = commands.filter((c) =>
    `${c.name} ${c.hint}`.toLowerCase().includes(paletteQuery.toLowerCase()),
  );
  const showPalette = () => {
    setPaletteQuery("");
    setCommandIndex(0);
    setModal("palette");
  };
  function runCommand(c) {
    setModal(null);
    c?.run();
  }
  useEffect(() => {
    const keys = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "j") {
          e.preventDefault();
          showPalette();
        }
        if (e.key.toLowerCase() === "b") {
          e.preventDefault();
          setLeftOpen((x) => !x);
        }
        if (e.key.toLowerCase() === "l") {
          e.preventDefault();
          setRightOpen((x) => !x);
        }
        if (e.key.toLowerCase() === "t") {
          e.preventDefault();
          setModal("new");
        }
        if (e.key.toLowerCase() === "n") {
          e.preventDefault();
          setModal("workspace");
        }
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);
  const visibleTabs = tabs.filter(
    (t) =>
      (t.workspace ||
        (t.kind === "room"
          ? model.rooms.find((r) => r.id === t.id)?.workspace
          : t.kind === "session"
            ? sessionById(t.id)?.workspace
            : "payments")) === workspace.id,
  );
  const tabTitle = (t) =>
    t.kind === "room"
      ? model.rooms.find((r) => r.id === t.id)?.title
      : t.kind === "session"
        ? `${sessionById(t.id)?.code} ${sessionById(t.id)?.role}`
        : t.id;
  function scenario(stage) {
    const seed = createInitialState();
    seed.rooms[0].stage = stage;
    if (["ready", "executing", "review", "complete"].includes(stage))
      seed.rooms[0].decisions = [
        {
          revision: 2,
          status: "approved",
          text: "Use the remaining balance, validate inside the transaction, preserve idempotency.",
          at: "10:55",
        },
      ];
    if (stage === "executing")
      seed.sessions = seed.sessions.map((s) =>
        s.workspace === "payments"
          ? {
              ...s,
              status:
                s.role === "Backend"
                  ? "blocked"
                  : s.role === "Architect"
                    ? "working"
                    : "queued",
            }
          : s,
      );
    if (stage === "review")
      seed.sessions = seed.sessions.map((s) =>
        s.workspace === "payments"
          ? { ...s, status: "done", result: "Result shared" }
          : s,
      );
    setModel(seed);
    setWorkspaceId("payments");
    setTabs(initialTabs);
    setActive(initialTabs[0]);
    setView("conversation");
    setModal(null);
    setDrafts({});
    setReturnNote(null);
    notify("Sample scenario loaded.");
  }

  return (
    <div
      className={`app ${leftOpen ? "left-open" : ""} ${rightOpen ? "right-open" : ""}`}
      style={{
        "--left-width": `${leftWidth}px`,
        "--right-width": `${rightWidth}px`,
      }}
    >
      <header className="titlebar">
        <div className="window-chrome">
          <div className="traffic-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <IconButton
            label="Toggle sidebar (⌘B)"
            onClick={() => setLeftOpen((x) => !x)}
          >
            <PanelLeft size={17} />
          </IconButton>
          <span className="app-name">harnas</span>
        </div>
        <div className="tabstrip" role="tablist" aria-label="Workspace tabs">
          {visibleTabs.map((t) => (
            <div
              className={`tab ${active && tabKey(active) === tabKey(t) ? "active" : ""}`}
              key={tabKey(t)}
            >
              <button
                role="tab"
                aria-selected={!!active && tabKey(active) === tabKey(t)}
                onClick={() => openTab(t)}
              >
                {t.kind === "room" ? (
                  model.rooms.find((r) => r.id === t.id)?.members.length === 1
                    ? <Provider provider={sessionById(model.rooms.find((r) => r.id === t.id).members[0])?.provider || "claude"} small />
                    : <Hash size={14} />
                ) : t.kind === "session" ? (
                  <SquareTerminal size={14} />
                ) : (
                  <FileText size={14} />
                )}
                <span>{tabTitle(t)}</span>
                {t.kind === "room" &&
                  model.rooms.find((r) => r.id === t.id)?.stage ===
                    "awaiting" && <i className="notification-dot" />}
              </button>
              <IconButton
                label={`Close ${tabTitle(t)}`}
                onClick={() => closeTab(t)}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <IconButton
            label="New task (⌘T)"
            onClick={() => setModal("new")}
          >
            <Plus size={17} />
          </IconButton>
        </div>
        <div className="window-tools">
          <IconButton label="Command palette (⌘J)" onClick={showPalette}>
            <Search size={17} />
          </IconButton>
          <IconButton
            label="Toggle context panel (⌘L)"
            onClick={() => setRightOpen((x) => !x)}
          >
            <PanelRight size={17} />
          </IconButton>
        </div>
      </header>
      <div className="workspace-shell">
        {leftOpen && (
          <>
            <aside className="sidebar" aria-label="Workspaces">
              <div className="sidebar-actions">
                <button onClick={showPalette}>
                  <Search size={16} />
                  <span>Search anything</span>
                  <kbd>⌘J</kbd>
                </button>
                <button onClick={() => setModal("workspace")}>
                  <Plus size={16} />
                  <span>New workspace</span>
                  <kbd>⌘N</kbd>
                </button>
              </div>
              <div className="project-heading">
                <span className="project-symbol">
                  <Folder size={13} />
                </span>
                <strong>shop</strong>
                <span className="muted">{model.workspaces.length}</span>
                <ChevronDown size={13} />
                <IconButton
                  label="New workspace in shop"
                  onClick={() => setModal("workspace")}
                >
                  <Plus size={15} />
                </IconButton>
              </div>
              <div className="workspace-list">
                {model.workspaces.map((w) => {
                  const wr = model.rooms.filter((r) => r.workspace === w.id),
                    ws = model.sessions.filter((s) => s.workspace === w.id),
                    isActive = w.id === workspace.id;
                  const needs = wr.filter((r) => r.stage === "awaiting").length;
                  return (
                    <section
                      key={w.id}
                      className={`workspace-card ${isActive ? "selected" : ""}`}
                    >
                      <button
                        className="workspace-select"
                        onClick={() => switchWorkspace(w.id)}
                      >
                        <span
                          className={`workspace-indicator ${needs ? "attention" : ""}`}
                        />
                        <strong>{w.title}</strong>
                        {needs > 0 && (
                          <span className="tiny-counter">{needs}</span>
                        )}
                        {isActive && <ChevronDown size={13} />}
                      </button>
                      <button
                        className="workspace-meta"
                        onClick={() => switchWorkspace(w.id)}
                      >
                        <GitBranch size={11} />
                        {w.branch}
                        <span>·</span>
                        {ws.length} agents
                      </button>
                      {isActive && (
                        <div className="workspace-content">
                          {wr.map((r) => (
                            <div
                              className={`sidebar-room ${active?.kind === "room" && active.id === r.id ? "current" : ""} ${r.stage === "awaiting" ? "needs-decision" : ""} ${dragged ? "drop-target" : ""}`}
                              key={r.id}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                e.preventDefault();
                                addToRoom(
                                  r.id,
                                  e.dataTransfer.getData("text/plain"),
                                );
                                setDragged(null);
                              }}
                            >
                              <div className="room-nav-row">
                                <button
                                  className="room-nav"
                                  onClick={() =>
                                    openTab({ kind: "room", id: r.id })
                                  }
                                >
                                  {r.members.length === 1 ? <Provider provider={sessionById(r.members[0])?.provider || "claude"} small /> : <Hash size={15} />}
                                  <strong>{r.title}</strong>
                                  {r.stage === "awaiting" ? (
                                    <span className="notification-dot" />
                                  ) : null}
                                </button>
                                <IconButton
                                  label={`${collapsed[r.id] ? "Expand" : "Collapse"} ${r.title}`}
                                  onClick={() =>
                                    setCollapsed((c) => ({
                                      ...c,
                                      [r.id]: !c[r.id],
                                    }))
                                  }
                                >
                                  {collapsed[r.id] ? (
                                    <ChevronRight size={13} />
                                  ) : (
                                    <ChevronDown size={13} />
                                  )}
                                </IconButton>
                              </div>
                              {(collapsed[r.id] || r.members.length === 1) && <CompactTeam members={r.members.map(sessionById).filter(Boolean)} Provider={Provider} />}
                              {!collapsed[r.id] && r.members.length > 1 && (
                                <div className="sidebar-members">
                                  {r.members.map((id) => {
                                    const s = sessionById(id);
                                    return (
                                      s && (
                                        <button
                                          draggable
                                          onDragStart={(e) => {
                                            setDragged(s.id);
                                            e.dataTransfer.setData(
                                              "text/plain",
                                              s.id,
                                            );
                                          }}
                                          onDragEnd={() => setDragged(null)}
                                          className={`session-row ${active?.id === s.id ? "current" : ""}`}
                                          key={s.id}
                                          onClick={() =>
                                            openTab({
                                              kind: "session",
                                              id: s.id,
                                            })
                                          }
                                        >
                                          <Provider
                                            provider={s.provider}
                                            small
                                          />
                                          <span className="session-code">
                                            {s.code}
                                          </span>
                                          <span className="role">{s.role}</span>
                                          {s.id === r.lead && (
                                            <Star
                                              size={11}
                                              className="lead-star"
                                              fill="currentColor"
                                            />
                                          )}
                                          <span
                                            className={`status-dot ${s.status}`}
                                            title={statusText[s.status]}
                                          />
                                        </button>
                                      )
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ))}
                          {ws
                            .filter(
                              (s) => !wr.some((r) => r.members.includes(s.id)),
                            )
                            .map((s) => (
                              <button
                                className="session-row standalone"
                                key={s.id}
                                draggable
                                onDragStart={(e) => {
                                  setDragged(s.id);
                                  e.dataTransfer.setData("text/plain", s.id);
                                }}
                                onDragEnd={() => setDragged(null)}
                                onClick={() =>
                                  openTab({ kind: "session", id: s.id })
                                }
                              >
                                <Provider provider={s.provider} small />
                                <span>
                                  {s.code} {s.role}
                                </span>
                                <span className={`status-dot ${s.status}`} />
                              </button>
                            ))}
                          <button
                            className="new-room-link"
                            onClick={() => setModal("new")}
                          >
                            <Plus size={14} />
                            New task
                          </button>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
              <div className="sidebar-bottom">
                <div className="local-connection">
                  <span className="status-dot done" />
                  <span>Local workspace</span>
                  <span className="muted">macOS</span>
                </div>
                <div className="sidebar-bottom-actions">
                  <button onClick={() => setModal("settings")}>
                    <Settings2 size={16} />
                    Settings
                  </button>
                  <IconButton
                    label={
                      theme === "light"
                        ? "Switch to dark theme"
                        : "Switch to light theme"
                    }
                    onClick={() =>
                      setTheme((t) => (t === "light" ? "dark" : "light"))
                    }
                  >
                    {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
                  </IconButton>
                </div>
              </div>
            </aside>
            <div
              role="separator"
              aria-label="Resize workspace sidebar"
              aria-orientation="vertical"
              className="resizer"
              onPointerDown={(e) => resize(e, "left")}
            />
          </>
        )}
        <main className="main-sheet">
          {!active ? (
            <div className="empty-workspace">
              <div className="empty-icon">
                <FolderOpen size={28} />
              </div>
              <span className="muted">
                {workspace.project} / {workspace.title}
              </span>
              <h1>A space to work together.</h1>
              <p>
                {workspace.goal ||
                  "Bring agents into a room, give them a shared goal, and keep the work in one place."}
              </p>
              <button
                className="button primary"
                onClick={() => setModal("new")}
              >
                <Plus size={16} />
                New task
              </button>
              <p className="empty-task-hint">Start with one agent. Add teammates to the same conversation.</p>
            </div>
          ) : active.kind === "room" && room ? (
            <>
              <header className={`room-header ${members.length === 1 ? "single-agent-task" : ""}`}>
                <div className="breadcrumb">
                  <span>{workspace.title}</span>
                  <ChevronRight size={12} />
                  <span>{members.length === 1 ? "Session" : "Room"}</span>
                </div>
                <div className="room-title-row">
                  <h1>{room.title}</h1>
                  <Badge
                    tone={
                      ["awaiting", "ready"].includes(room.stage)
                        ? "orange"
                        : room.stage === "complete"
                          ? "green"
                          : ""
                    }
                  >
                    {room.stage === "awaiting" ? (
                      <CircleDot size={12} />
                    ) : room.stage === "complete" ? (
                      <Check size={12} />
                    ) : null}
                    {room.stage === "discussion" ? (members.some((s) => s.status === "blocked") ? "Needs you" : members.some((s) => s.status === "working") ? "In progress" : members.every((s) => s.status === "queued") ? "Not started" : "Ready") : stageLabel(room.stage)}
                  </Badge>
                  <div className="grow" />
                  {members.some((s) => s.lifecycle === "pending") && <button className="button primary small" onClick={() => {
                    setModel((current) => launchPrepared(current, room.id));
                    notify("Prepared agents started in the sample task.");
                  }}><Play size={14} />Launch prepared</button>}
                  <button className="button secondary small" onClick={() => setModal("add-agents")}><Plus size={14} />Add agents</button>
                  <IconButton
                    label="Task settings and members"
                    onClick={() => setModal("room-settings")}
                  >
                    <MoreHorizontal size={19} />
                  </IconButton>
                </div>
                <p className="room-goal">
                  {room.goal ||
                    "Write a shared task below to start the discussion."}
                </p>
                <div className="room-byline">
                  <span>
                    {members.length > 1 ? <Star size={12} className="lead-star" fill="currentColor" /> : <Provider provider={lead?.provider || "claude"} small />}
                    {members.length > 1 ? `${lead?.role || "No lead"} leads` : providerLabel[lead?.provider] || "Agent"}
                  </span>
                  <span>
                    <Users size={13} />
                    {members.length} {members.length === 1 ? "agent" : "agents"}
                  </span>
                  <span>
                    Created by{" "}
                    {room.creator === "human"
                      ? "you"
                      : sessionById(room.creator)?.code || "agent"}
                  </span>
                </div>
                <div className="team-strip">
                  {members.map((s) => (
                    <button
                      key={s.id}
                      className={`team-card ${s.status === "blocked" ? "blocked" : ""}`}
                      onClick={() => openTab({ kind: "session", id: s.id })}
                    >
                      <div className="team-card-heading">
                        <Provider provider={s.provider} />
                        <strong>{s.role}</strong>
                        {s.id === room.lead && (
                          <Star
                            size={11}
                            className="lead-star"
                            fill="currentColor"
                          />
                        )}
                        <span className="session-code">{s.code}</span>
                      </div>
                      <span className="team-task">{s.task}</span>
                      {s.runConfig && <span className="team-config">{s.runConfig.model} · {s.runConfig.effort === "default" ? "CLI effort" : `${s.runConfig.effort} effort`} · {s.runConfig.worktree ? "Own worktree" : "Project folder"}</span>}
                      <Status
                        value={s.status}
                        label={room.stage === "awaiting" ? s.result : undefined}
                      />
                    </button>
                  ))}
                </div>
                <nav className="room-navigation" aria-label="Room views">
                  {[
                    ["conversation", "Conversation", MessageSquare],
                    ["plan", "Plan & ownership", ListChecks],
                    ["decisions", "Decisions", CheckCheck],
                    ["materials", "Materials", Paperclip],
                  ].map(([id, label, Icon]) => (
                    <button
                      key={id}
                      onClick={() => {
                        setView(id);
                        setReturnNote(null);
                      }}
                      className={view === id ? "selected" : ""}
                    >
                      <Icon size={14} />
                      {label}
                      {id === "decisions" && (
                        <span>
                          {room.decisions.length +
                            (room.stage === "awaiting" ? 1 : 0)}
                        </span>
                      )}
                      {id === "materials" && (
                        <span>{room.artifacts.length}</span>
                      )}
                    </button>
                  ))}
                </nav>
              </header>
              {view === "conversation" ? (
                <>
                  <div className="conversation-scroll" ref={feedRef}>
                    <div className="thread-content">
                      <div className="date-divider">
                        <span>Today</span>
                        <span>Discussion stays with the workspace</span>
                      </div>
                      {room.messages.map((message) => (
                        <Message
                          key={message.id}
                          message={message}
                          session={sessionById(message.from)}
                          sessions={model.sessions}
                          onArtifact={(id) =>
                            openTab({
                              kind: "artifact",
                              id,
                              workspace: workspace.id,
                            })
                          }
                        />
                      ))}
                      {room.stage === "awaiting" && (
                        <div className="decision-card">
                          <div className="decision-eyebrow">
                            <span className="decision-symbol">
                              <CheckCheck size={18} />
                            </span>
                            <span>Team proposal</span>
                            <Badge tone="orange">
                              Revision {room.revision}
                            </Badge>
                            <span className="decision-time">
                              {room.messages.at(-1)?.time}
                            </span>
                          </div>
                          <h2>
                            {room.proposal?.title || `Plan for ${room.title}`}
                          </h2>
                          <p>{room.proposal?.text || room.goal}</p>
                          <div className="decision-summary">
                            {(room.proposal?.points || []).map((point) => (
                              <span key={point}>
                                <Check size={14} />
                                {point}
                              </span>
                            ))}
                          </div>
                          {room.conditions?.length > 0 && (
                            <div className="included-feedback">
                              <strong>Your requested changes</strong>
                              {room.conditions.map((condition, i) => (
                                <p key={i}>{condition}</p>
                              ))}
                            </div>
                          )}
                          <button
                            className="consensus-note"
                            onClick={() => setView("decisions")}
                          >
                            <ShieldCheck size={15} />
                            <span>
                              {room.id === "refunds"
                                ? `Reviewer’s concern resolved in revision ${room.revision}`
                                : "Review the proposal and its recorded assumptions"}
                            </span>
                            <ArrowRight size={13} />
                          </button>
                          {returnNote !== null ? (
                            <form
                              className="rework-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                roomAction({
                                  type: "return",
                                  note: returnNote,
                                });
                              }}
                            >
                              <label className="field">
                                What should the lead change?
                                <textarea
                                  autoFocus
                                  value={returnNote}
                                  onChange={(e) =>
                                    setReturnNote(e.target.value)
                                  }
                                  placeholder="Describe the change or unresolved concern…"
                                  required
                                  rows={3}
                                />
                              </label>
                              <div className="button-row">
                                <button
                                  className="button primary"
                                  disabled={!returnNote.trim()}
                                >
                                  Send to lead
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="button ghost"
                                  onClick={() => setReturnNote(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <>
                              <div className="decision-actions">
                                <button
                                  className="button primary"
                                  onClick={() =>
                                    roomAction({ type: "approve" })
                                  }
                                >
                                  <Check size={16} />
                                  Approve plan
                                </button>
                                <button
                                  className="button secondary"
                                  onClick={() => setReturnNote("")}
                                >
                                  Return for rework
                                </button>
                                <button
                                  className="text-button scope-link"
                                  onClick={() => setView("plan")}
                                >
                                  View scope
                                  <ArrowRight size={13} />
                                </button>
                              </div>
                              <p className="decision-footnote">
                                Approving the plan does not start
                                implementation.
                              </p>
                            </>
                          )}
                        </div>
                      )}
                      {room.stage === "ready" && (
                        <div className="next-action-card">
                          <span className="round-icon">
                            <CheckCheck size={21} />
                          </span>
                          <h2>The plan is agreed.</h2>
                          <p>
                            Revision {room.revision} is approved. The lead will
                            distribute the work and keep the room updated.
                          </p>
                          <div className="button-row">
                            <button
                              className="button primary"
                              onClick={() => roomAction({ type: "start" })}
                            >
                              <Play size={15} fill="currentColor" />
                              Start implementation
                            </button>
                            <button
                              className="button secondary"
                              onClick={() => setView("plan")}
                            >
                              Review assignments
                            </button>
                          </div>
                        </div>
                      )}
                      {room.stage === "revising" && (
                        <div className="inline-state">
                          <Provider provider={lead?.provider || "claude"} />
                          <div>
                            <strong>
                              {lead?.role} is revising the proposal
                            </strong>
                            <p>
                              Your feedback stays attached to the previous
                              revision.
                            </p>
                          </div>
                          <span className="typing-dots">•••</span>
                        </div>
                      )}
                      {room.stage === "executing" && (
                        <div className="execution-card">
                          <div className="field-title">
                            <strong>
                              <CircleDot size={16} />
                              Implementation is in progress
                            </strong>
                            <Badge>Revision {room.revision}</Badge>
                          </div>
                          <p>
                            Each agent has an assignment. Review and QA wait for
                            the implementation result.
                          </p>
                          {members.some((s) => s.status === "blocked") && (
                            <button
                              className="attention-banner"
                              onClick={() =>
                                openTab({
                                  kind: "session",
                                  id: members.find(
                                    (s) => s.status === "blocked",
                                  ).id,
                                })
                              }
                            >
                              <MessageSquare size={18} />
                              <span>
                                <strong>Backend needs your input</strong>
                                <small>
                                  A CLI permission request is waiting in the
                                  terminal.
                                </small>
                              </span>
                              <ArrowRight size={17} />
                            </button>
                          )}
                          <button
                            className="text-button"
                            onClick={() => setView("plan")}
                          >
                            See assignments
                            <ListChecks size={14} />
                          </button>
                        </div>
                      )}
                      {room.stage === "review" && (
                        <div className="next-action-card">
                          <span className="round-icon">
                            <ShieldCheck size={22} />
                          </span>
                          <h2>Ready for your review.</h2>
                          <p>
                            The sample run has a reviewed diff and a
                            verification report. Inspect the result before
                            accepting it.
                          </p>
                          <div className="review-stats">
                            <span>
                              <Check size={14} />4 assignments completed
                            </span>
                            <span>
                              <Check size={14} />
                              18 sample tests passed
                            </span>
                          </div>
                          <div className="button-row">
                            <button
                              className="button primary"
                              onClick={() =>
                                openTab({
                                  kind: "diff",
                                  id: "refund.ts",
                                  workspace: workspace.id,
                                })
                              }
                            >
                              <GitCompareArrows size={15} />
                              Review changes
                            </button>
                            <button
                              className="button secondary"
                              onClick={() => roomAction({ type: "finish" })}
                            >
                              Accept result
                            </button>
                          </div>
                        </div>
                      )}
                      {room.stage === "complete" && (
                        <div className="inline-state complete">
                          <CircleCheck size={23} />
                          <div>
                            <strong>Result accepted</strong>
                            <p>
                              The decision, analysis and results remain
                              available for the next room.
                            </p>
                          </div>
                          <button
                            className="text-button"
                            onClick={() => setView("materials")}
                          >
                            View materials
                            <ArrowRight size={14} />
                          </button>
                        </div>
                      )}
                      {room.stage === "discussion" &&
                        room.messages.length > 0 && (
                          <div className="discussion-next">
                            <MessageSquare size={19} />
                            <div>
                              <strong>
                                Need a plan before the next step?
                              </strong>
                              <p>
                                Ask {members.length === 1 ? "your agent" : "the lead"} for a proposal when you want to compare approaches.
                                This opens a sample decision for your review.
                              </p>
                            </div>
                            <button
                              className="button secondary"
                              onClick={() => roomAction({ type: "propose" })}
                            >
                              Request proposal
                              <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                      {room.messages.length === 0 && (
                        <div className="empty-room">
                          <Users size={32} />
                          <h2>Your team is here.</h2>
                          <p>
                            Give them a shared task. {lead?.role || "The lead"}{" "}
                            will gather their positions and bring you a
                            proposal.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  <form className="composer" onSubmit={sendMessage}>
                    <div className="composer-box">
                      <MentionEditor
                        key={room.id}
                        ref={composerRef}
                        value={draft}
                        roomId={room.id}
                        members={members}
                        aria-controls={mentionOptions.length ? "agent-mention-options" : undefined}
                        aria-activedescendant={mentionOptions.length ? `mention-${mentionOptions[mentionIndex % mentionOptions.length].id}` : undefined}
                        onChange={(value) => {
                          setDrafts((d) => ({ ...d, [room.id]: value }));
                          setMentionIndex(0);
                        }}
                        onQuery={setMentionQuery}
                        onKeyDown={(e) => {
                          if (
                            mentionOptions.length &&
                            ["ArrowDown", "ArrowUp"].includes(e.key)
                          ) {
                            e.preventDefault();
                            setMentionIndex(
                              (i) =>
                                (i +
                                  (e.key === "ArrowDown" ? 1 : -1) +
                                  mentionOptions.length) %
                                mentionOptions.length,
                            );
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            if (mentionOptions.length)
                              insertMention(
                                mentionOptions[
                                  mentionIndex % mentionOptions.length
                                ],
                              );
                            else sendMessage();
                          }
                          if (e.key === "Escape" && mentionOptions.length) {
                            e.preventDefault();
                            setMentionQuery(undefined);
                          }
                        }}
                      />
                      <div className="composer-bottom">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => composerRef.current?.insertAtSign()}
                        >
                          <AtSign size={15} />
                          Mention
                        </button>
                        <span className="composer-hint">
                          Visible to everyone · ↵ send · ⇧↵ new line
                        </span>
                        <button
                          type="submit"
                          aria-label="Send message"
                          className="send-button"
                          disabled={!draft.trim()}
                        >
                          <ArrowUp size={18} />
                        </button>
                      </div>
                    </div>
                    {mentionOptions.length > 0 && (
                      <div
                        className="mention-menu"
                        role="listbox"
                        aria-label="Mention an agent"
                        id="agent-mention-options"
                      >
                        {mentionOptions.map((s, i) => (
                          <button
                            type="button"
                            role="option"
                            id={`mention-${s.id}`}
                            aria-selected={
                              i === mentionIndex % mentionOptions.length
                            }
                            key={s.id}
                            className={
                              i === mentionIndex % mentionOptions.length
                                ? "selected"
                                : ""
                            }
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertMention(s)}
                          >
                            <Provider provider={s.provider} small />
                            <strong>
                              {s.code} {s.role}
                            </strong>
                            {s.id === room.lead && <Star size={11} />}
                            <span>{s.task}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </form>
                </>
              ) : view === "plan" ? (
                <PlanView
                  room={room}
                  members={members}
                  onSession={(id) => openTab({ kind: "session", id })}
                  onStart={() => roomAction({ type: "start" })}
                  onConversation={() => setView("conversation")}
                />
              ) : view === "decisions" ? (
                <DecisionsView
                  room={room}
                  onConversation={() => setView("conversation")}
                />
              ) : (
                <MaterialsView
                  room={room}
                  members={members}
                  onOpen={(id) =>
                    openTab({ kind: "artifact", id, workspace: workspace.id })
                  }
                  onSession={(id) => openTab({ kind: "session", id })}
                />
              )}
            </>
          ) : active.kind === "session" && activeSession ? (
            <TerminalView
              session={activeSession}
              workspace={workspace}
              room={room}
              onRoom={() => room && openTab({ kind: "room", id: room.id })}
              input={terminalInput}
              onInput={setTerminalInput}
              lines={terminalLines[activeSession.id] || []}
              onSend={() => {
                if (terminalInput.trim()) {
                  setTerminalLines((l) => ({
                    ...l,
                    [activeSession.id]: [
                      ...(l[activeSession.id] || []),
                      terminalInput,
                    ],
                  }));
                  setTerminalInput("");
                  notify("Sample terminal: no command was executed.");
                }
              }}
              onAllow={() => {
                setModel((data) => ({
                  ...data,
                  sessions: data.sessions.map((s) =>
                    s.id === activeSession.id ? { ...s, status: "working" } : s,
                  ),
                }));
                notify("Sample permission accepted. Backend is working.");
              }}
            />
          ) : active.kind === "artifact" ? (
            <ArtifactView
              id={active.id}
              onRoom={() => room && openTab({ kind: "room", id: room.id })}
            />
          ) : (
            <DiffView
              key={tabKey(active)}
              id={active.id}
              onRoom={() => room && openTab({ kind: "room", id: room.id })}
              onReview={() => {
                setRightTab("changes");
                setRightOpen(true);
              }}
            />
          )}
        </main>
        {rightOpen && (
          <>
            <div
              className="resizer right-resizer"
              role="separator"
              aria-label="Resize context panel"
              aria-orientation="vertical"
              onPointerDown={(e) => resize(e, "right")}
            />
            <aside className="right-panel" aria-label="Workspace context">
              <div
                className="right-navigation"
                role="tablist"
                aria-label="Context panels"
              >
                {["context", "files", "changes"].map((name) => (
                  <button
                    key={name}
                    role="tab"
                    aria-selected={rightTab === name}
                    className={rightTab === name ? "selected" : ""}
                    onClick={() => setRightTab(name)}
                  >
                    {name[0].toUpperCase() + name.slice(1)}
                    {name === "changes" && workspace.id === "payments" && (
                      <span>3</span>
                    )}
                  </button>
                ))}
                <IconButton
                  label="Close context panel"
                  onClick={() => setRightOpen(false)}
                >
                  <X size={14} />
                </IconButton>
              </div>
              {rightTab === "context" ? (
                <>
                  <div className="context-heading">
                    <span className="context-icon">
                      <FolderOpen size={18} />
                    </span>
                    <div>
                      <h3>Shared context</h3>
                      <span>Available to the whole room</span>
                    </div>
                  </div>
                  <section className="context-section">
                    <h4>Workspace goal</h4>
                    <p>
                      {workspace.goal || "Add a goal when you create a task."}
                    </p>
                    <div className="context-reference">
                      <Folder size={12} />
                      {workspace.project}
                      <GitBranch size={12} />
                      {workspace.branch}
                    </div>
                  </section>
                  <section className="context-section">
                    <div className="section-label">
                      <h4>Room materials</h4>
                      <span>{room?.artifacts.length || 0}</span>
                    </div>
                    {room?.artifacts.length ? (
                      room.artifacts.map((id) => (
                        <button
                          className="context-file"
                          key={id}
                          onClick={() =>
                            openTab({
                              kind: "artifact",
                              id,
                              workspace: workspace.id,
                            })
                          }
                        >
                          <FileText size={17} />
                          <span>
                            <strong>{artifactContent[id]?.title || id}</strong>
                            <small>{artifactContent[id]?.author}</small>
                          </span>
                          <ChevronRight size={13} />
                        </button>
                      ))
                    ) : (
                      <p className="muted">
                        Shared analyses and artifacts will appear here.
                      </p>
                    )}
                  </section>
                  <section className="context-section">
                    <div className="section-label">
                      <h4>Context handoffs</h4>
                      <button
                        className="plain-link"
                        onClick={() => {
                          if (room) {
                            openTab({ kind: "room", id: room.id });
                            setView("materials");
                          }
                        }}
                      >
                        View all
                      </button>
                    </div>
                    <div className="handoff-diagram">
                      <div className="handoff-lead">
                        <Star size={12} fill="currentColor" />
                        {lead?.role || "Room lead"}
                        <span>brief + decisions</span>
                      </div>
                      <div className="handoff-branches">
                        {members
                          .filter((s) => s.id !== room?.lead)
                          .slice(0, 3)
                          .map((s) => (
                            <button
                              key={s.id}
                              onClick={() =>
                                openTab({ kind: "session", id: s.id })
                              }
                            >
                              <CornerDownLeft size={13} />
                              <Provider provider={s.provider} small />
                              <span>{s.role}</span>
                              <ChevronRight size={12} />
                            </button>
                          ))}
                      </div>
                    </div>
                    <p className="context-explainer">
                      Summaries, decisions and artifacts travel with the task.
                    </p>
                  </section>
                  <section className="context-section context-scope">
                    <h4>
                      <GitBranch size={13} />
                      Work boundaries
                    </h4>
                    <p>
                      Assignments define who changes what. Check each agent’s
                      working folder before reviewing or merging its changes.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (room) {
                          openTab({ kind: "room", id: room.id });
                          setView("plan");
                        }
                      }}
                    >
                      See ownership
                      <ArrowRight size={13} />
                    </button>
                  </section>
                </>
              ) : rightTab === "files" ? (
                <FilesPanel
                  onOpen={(id) =>
                    openTab({ kind: "artifact", id, workspace: workspace.id })
                  }
                  onDiff={(id) =>
                    openTab({
                      kind: "diff",
                      id: id || "refund.ts",
                      workspace: workspace.id,
                      originRoomId: "refunds",
                    })
                  }
                  workspace={workspace}
                />
              ) : (
                <ChangesPanel
                  workspace={workspace}
                  onOpen={(id) =>
                    openTab({
                      kind: "artifact",
                      id,
                      workspace: workspace.id,
                      originRoomId: "refunds",
                    })
                  }
                  onDiff={(id) =>
                    openTab({
                      kind: "diff",
                      id: id || "refund.ts",
                      workspace: workspace.id,
                      originRoomId: "refunds",
                    })
                  }
                />
              )}
              <div className="context-bottom">
                <ShieldCheck size={14} />
                <span>Context stays in your workspace</span>
              </div>
            </aside>
          </>
        )}
      </div>
      <footer className="statusbar">
        <span className="prototype-tag">
          <CircleDot size={11} />
          Interactive prototype
        </span>
        <span className="statusbar-divider" />
        <span>Sample sessions</span>
        <div className="grow" />
        <span className="provider-status">
          <Provider provider="claude" small />
          Claude Code
        </span>
        <span className="provider-status">
          <Provider provider="codex" small />
          Codex
        </span>
        <IconButton
          label="Prototype settings"
          onClick={() => setModal("settings")}
        >
          <Settings2 size={13} />
        </IconButton>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <CircleCheck size={17} />
          {toast}
          <IconButton label="Dismiss notification" onClick={() => setToast("")}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      {modal === "new" || modal === "session" || modal === "add-agents" ? (
        <NewTaskDialog
          workspace={workspace}
          sessions={workspaceSessions}
          Modal={Modal}
          Provider={Provider}
          task={modal === "add-agents" ? room : undefined}
          onClose={() => setModal(null)}
          onCreate={createItems}
        />
      ) : null}
      {modal === "workspace" && (
        <WorkspaceDialog
          onClose={() => setModal(null)}
          onCreate={(title, goal) => {
            const w = {
              id: crypto.randomUUID(),
              title,
              goal,
              project: "shop",
              branch: "main",
            };
            setModel((m) => ({ ...m, workspaces: [...m.workspaces, w] }));
            setWorkspaceId(w.id);
            setActive(null);
            setModal(null);
            notify("Workspace created. Add a task to get started.");
          }}
        />
      )}
      {modal === "palette" && (
        <Modal title="Go to anything" onClose={() => setModal(null)} wide>
          <div className="palette-search">
            <Search size={20} />
            <input
              aria-label="Search commands and sessions"
              placeholder="Search rooms, agents, or commands…"
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value);
                setCommandIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCommandIndex(
                    (i) => (i + 1) % Math.max(filteredCommands.length, 1),
                  );
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCommandIndex(
                    (i) =>
                      (i - 1 + filteredCommands.length) %
                      Math.max(filteredCommands.length, 1),
                  );
                }
                if (e.key === "Enter" && filteredCommands.length) {
                  e.preventDefault();
                  runCommand(
                    filteredCommands[commandIndex % filteredCommands.length],
                  );
                }
              }}
            />
            <kbd>esc</kbd>
          </div>
          <div className="command-list">
            {filteredCommands.length ? (
              filteredCommands.map((c, i) => (
                <button
                  key={`${c.name}-${i}`}
                  className={i === commandIndex ? "selected" : ""}
                  onClick={() => runCommand(c)}
                  onMouseMove={() => setCommandIndex(i)}
                >
                  <c.icon size={17} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>{c.hint}</small>
                  </span>
                  {c.key && <kbd>{c.key}</kbd>}
                  {i === commandIndex && <CornerDownLeft size={15} />}
                </button>
              ))
            ) : (
              <div className="no-results">No matching rooms or commands.</div>
            )}
          </div>
          <div className="palette-footer">
            <span>↑ ↓ navigate</span>
            <span>↵ open</span>
            <span>⌘J anywhere</span>
          </div>
        </Modal>
      )}
      {modal === "room-settings" && room && (
        <Modal
          title="Task settings"
          subtitle={`${room.title} · ${members.length} ${members.length === 1 ? "agent" : "agents"}`}
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <div className="member-settings-list">
              {members.map((s) => (
                <div className="member-setting" key={s.id}>
                  <Provider provider={s.provider} />
                  <div>
                    <strong>
                      {s.code} {s.role}
                    </strong>
                    <span>{providerLabel[s.provider]} · {s.runConfig?.model || "CLI default"} · {s.runConfig?.effort || "default"} effort</span>
                  </div>
                  <button
                    className={`button small ${s.id === room.lead ? "lead-selected" : "secondary"}`}
                    onClick={() => {
                      updateRoom(room.id, (r) => ({ ...r, lead: s.id }));
                      notify(`${s.role} is now the room lead.`);
                    }}
                  >
                    <Star
                      size={13}
                      fill={s.id === room.lead ? "currentColor" : "none"}
                    />
                    {s.id === room.lead ? "Lead" : "Make lead"}
                  </button>
                </div>
              ))}
            </div>
            {workspaceSessions.some((s) => !room.members.includes(s.id)) && (
              <label className="field">
                Add an existing session
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      addToRoom(room.id, e.target.value);
                      e.target.value = "";
                    }
                  }}
                >
                  <option value="">Choose a session…</option>
                  {workspaceSessions
                    .filter((s) => !room.members.includes(s.id))
                    .map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.code} {s.role}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <button className="button secondary" onClick={() => setModal("add-agents")}><Plus size={15} />Add agents</button>
            <p className="form-note">
              <Users size={15} />
              The shared conversation is visible to every room member.
            </p>
          </div>
          <footer className="modal-footer">
            <button className="button primary" onClick={() => setModal(null)}>
              Done
            </button>
          </footer>
        </Modal>
      )}
      {modal === "settings" && (
        <SettingsPreview Modal={Modal} theme={theme} setTheme={setTheme} settings={settings} onChange={(patch) => setModel((current) => ({ ...current, settings: { ...settings, ...patch } }))} onClose={() => setModal(null)} onScenario={scenario} />
      )}
    </div>
  );
}
