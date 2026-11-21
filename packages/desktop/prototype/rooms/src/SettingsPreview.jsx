import React, { useId, useRef, useState } from 'react';
import './settings-preview.css';

const tabs = ['Appearance', 'Agents & delivery', 'Terminal', 'Product map'];
const scenarios = {
  awaiting: 'Decision waiting',
  executing: 'Implementation',
  review: 'Result review',
};
const backlog = [
  [1, 'Remove the frozen TUI', 'Retire the terminal interface and its dedicated code.'],
  [2, 'Live checks', 'Verify real Claude sessions, delivery and macOS notifications.'],
  [3, 'Review fixes', 'Improve diff rendering, note visibility and refresh behavior.'],
  [
    4,
    'Session reliability',
    'Add a launch action for pending rows; refresh the silence threshold without a host restart.',
  ],
  [5, 'Visual clarity', 'Improve contrast and file-type icons.'],
  [8, 'Rooms as teams', 'One task: one agent is a session, several are a room. Add teammates, choose a lead and keep one conversation.'],
  [9, 'Issue import & GitHub', 'Bring issues into a task draft; add PR and CI workflows.'],
  [10, 'Provider support', 'Complete Codex and GLM delivery and live validation.'],
  [11, 'Terminal continuity', 'Keep scrollback on disk and add nested terminal splits.'],
  [12, 'Workspace conveniences', 'Custom keys, resource usage, Dock attention and task boards.'],
  [13, 'Browser improvements', 'Expand local preview, Design Mode and navigation controls.'],
];

function Toggle({ title, description, checked, onChange }) {
  const id = useId();
  return (
    <div className="settings-preview-row">
      <div>
        <label id={id} htmlFor={`${id}-switch`}>
          {title}
        </label>
        <p>{description}</p>
      </div>
      <button
        id={`${id}-switch`}
        type="button"
        className="settings-preview-switch"
        role="switch"
        aria-labelledby={id}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function Field({ label, hint, value, onChange, type = 'text', min, max }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const valid =
    type === 'number'
      ? draft.trim() !== '' &&
        Number.isInteger(Number(draft)) &&
        Number(draft) >= min &&
        (max === undefined || Number(draft) <= max)
      : draft.trim() !== '';
  return (
    <label className="settings-preview-field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <input
        id={id}
        type={type}
        value={draft}
        min={min}
        max={max}
        step={type === 'number' ? 1 : undefined}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (type === 'number') {
            const number = Number(next);
            if (
              next.trim() &&
              Number.isInteger(number) &&
              number >= min &&
              (max === undefined || number <= max)
            )
              onChange(number);
          } else if (next.trim()) onChange(next);
        }}
        onBlur={() => {
          if (!valid) setDraft(String(value));
        }}
      />
      <small id={`${id}-hint`}>
        {valid
          ? hint
          : type === 'number'
            ? `Enter a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}.`
            : 'Enter a non-empty value.'}
      </small>
    </label>
  );
}

export function SettingsPreview({
  Modal,
  theme,
  setTheme,
  settings,
  onChange,
  onClose,
  onScenario,
}) {
  const [tab, setTab] = useState(0);
  const [pendingScenario, setPendingScenario] = useState(null);
  const [loadedScenario, setLoadedScenario] = useState(null);
  const id = useId();
  const tabRefs = useRef([]);
  const scenarioRefs = useRef({});
  const confirmRef = useRef(null);
  function selectTab(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }
  function dismissReset() {
    scenarioRefs.current[pendingScenario]?.focus();
    setPendingScenario(null);
  }
  return (
    <Modal title="Settings" subtitle="Make room for your way of working." onClose={onClose} wide>
      <div className="settings-preview">
        <p className="settings-preview-note">
          Sample data · Global preferences for this prototype only, not per-task overrides or system
          settings.
        </p>
        <div className="settings-preview-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((label, index) => (
            <button
              key={label}
              type="button"
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={`${id}-tab-${index}`}
              role="tab"
              aria-selected={tab === index}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={tab === index ? 0 : -1}
              onKeyDown={(event) => selectTab(event, index)}
              onClick={() => {
                setTab(index);
                setPendingScenario(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="settings-preview-panel"
          role="tabpanel"
          id={`${id}-panel-${tab}`}
          aria-labelledby={`${id}-tab-${tab}`}
          tabIndex={0}
        >
          {tab === 0 && (
            <>
              <h3>A familiar place to focus.</h3>
              <p className="settings-preview-intro">
                Soft surfaces, clear type. Choose the light that suits you.
              </p>
              <div className="settings-preview-themes" role="group" aria-label="Color theme">
                {['light', 'dark'].map((mode) => (
                  <button
                    type="button"
                    key={mode}
                    className={`settings-preview-theme settings-preview-theme-${mode}`}
                    aria-pressed={theme === mode}
                    onClick={() => setTheme(mode)}
                  >
                    <span className="settings-preview-swatch" aria-hidden="true">
                      <i />
                      <span>
                        <b />
                        <b />
                        <b />
                      </span>
                    </span>
                    <span>
                      {mode === 'light' ? 'Light' : 'Dark'}
                      <small>{theme === mode ? 'Selected' : 'Choose'}</small>
                    </span>
                  </button>
                ))}
              </div>
              <Toggle
                title="Notifications"
                description="Model alerts for attention, finished work and incoming mail."
                checked={settings.notifications}
                onChange={(notifications) => onChange({ notifications })}
              />
              <p className="settings-preview-footnote">
                Interface typography: Figtree with Caprasimo headings.
              </p>
            </>
          )}
          {tab === 1 && (
            <>
              <h3>Keep work moving, at your pace.</h3>
              <Toggle
                title="Auto-launch"
                description="Automatically start pending sessions requested by agents."
                checked={settings.autoLaunch}
                onChange={(autoLaunch) => onChange({ autoLaunch })}
              />
              <Toggle
                title="Auto-wake"
                description={
                  settings.autoWake
                    ? 'Allow incoming mail to wake sleeping sessions.'
                    : 'Paused. Incoming mail waits; auto-launch is unchanged.'
                }
                checked={settings.autoWake}
                onChange={(autoWake) => onChange({ autoWake })}
              />
              <div className="settings-preview-fields">
                <Field
                  label="Message limit"
                  hint="Messages per session / rolling hour"
                  type="number"
                  min={1}
                  value={settings.messageRate}
                  onChange={(messageRate) => onChange({ messageRate })}
                />
                <Field
                  label="Wake limit"
                  hint="Wakes per session / rolling hour · 0 pauses wakes"
                  type="number"
                  min={0}
                  max={60}
                  value={settings.resumeRate}
                  onChange={(resumeRate) => onChange({ resumeRate })}
                />
              </div>
              <Field
                label="Silence threshold"
                hint="Seconds before fallback inactivity detection. Production changes require a host restart (TODO #4)."
                type="number"
                min={1}
                value={(settings.silenceThresholdMs ?? 30000) / 1000}
                onChange={(seconds) => onChange({ silenceThresholdMs: seconds * 1000 })}
              />
              <Field
                label="Worktree root"
                hint="Base folder for session worktrees."
                value={settings.worktreeRoot}
                onChange={(worktreeRoot) => onChange({ worktreeRoot })}
              />
              <div className="settings-preview-providers">
                <strong>Core provider registry</strong>
                <div>
                  {['Claude', 'Codex', 'GLM'].map((provider) => (
                    <span key={provider}>{provider}</span>
                  ))}
                </div>
                <p>
                  No live readiness checks have been run. Registry entries do not establish working
                  provider support.
                </p>
                <p>
                  Model and effort choices belong in the future New Task flow; the current
                  sessions.create contract accepts neither.
                </p>
              </div>
            </>
          )}
          {tab === 2 && (
            <>
              <h3>Give the terminal room to breathe.</h3>
              <p className="settings-preview-intro">
                Preview font preferences before returning to your workspace.
              </p>
              <div className="settings-preview-fields">
                <Field
                  label="Font family"
                  hint="Uses an installed font, with a monospace fallback."
                  value={settings.fontFamily}
                  onChange={(fontFamily) => onChange({ fontFamily })}
                />
                <Field
                  label="Font size"
                  hint="8–32 pt"
                  type="number"
                  min={8}
                  max={32}
                  value={settings.fontSize}
                  onChange={(fontSize) => onChange({ fontSize })}
                />
              </div>
              <div
                className="settings-preview-terminal"
                aria-label="Terminal font preview"
                style={{
                  fontFamily: `${settings.fontFamily}, monospace`,
                  fontSize: `${settings.fontSize}pt`,
                }}
              >
                <span>{settings.worktreeRoot}</span>
                <pre>
                  {'$ git status --short\n M src/workspace.tsx\n\nReady for your next step.'}
                </pre>
              </div>
              <p className="settings-preview-footnote">Font changes are shown in this preview.</p>
            </>
          )}
          {tab === 3 && (
            <>
              <h3>What is here. What comes next.</h3>
              <div className="settings-preview-available">
                <strong>Available in desktop</strong>
                <p>
                  File browsing and previews, Monaco editing, diffs with review notes, and an
                  HTTP(S) browser with local Design Mode. Remote HTTP(S) pages are also supported.
                </p>
              </div>
              <h4>
                Backlog <span>TODOS.md</span>
              </h4>
              <ul className="settings-preview-roadmap">
                {backlog.map(([number, title, description]) => (
                  <li key={number}>
                    <span>#{number}</span>
                    <div>
                      <strong>{title}</strong>
                      <p>{description}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="settings-preview-scenarios">
                <h4>Explore a scenario</h4>
                <p>Loading a scenario replaces this demo’s rooms and messages.</p>
                <div className="settings-preview-actions">
                  {Object.entries(scenarios).map(([key, label]) => (
                    <button
                      type="button"
                      key={key}
                      ref={(element) => {
                        scenarioRefs.current[key] = element;
                      }}
                      onClick={() => {
                        setPendingScenario(key);
                        setLoadedScenario(null);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {pendingScenario && (
                  <div
                    className="settings-preview-confirm"
                    role="group"
                    aria-labelledby={`${id}-confirm`}
                    ref={(element) => {
                      if (element && !confirmRef.current) element.querySelector('button')?.focus();
                      confirmRef.current = element;
                    }}
                  >
                    <strong id={`${id}-confirm`}>Load “{scenarios[pendingScenario]}”?</strong>
                    <p>Your current demo rooms and messages will be replaced.</p>
                    <div className="settings-preview-actions">
                      <button type="button" onClick={dismissReset}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="settings-preview-primary"
                        onClick={() => {
                          const selected = pendingScenario;
                          onScenario(selected);
                          setLoadedScenario(scenarios[selected]);
                          dismissReset();
                        }}
                      >
                        Replace demo & load
                      </button>
                    </div>
                  </div>
                )}
                <p className="settings-preview-status" role="status">
                  {loadedScenario ? `${loadedScenario} loaded.` : ''}
                </p>
              </div>
            </>
          )}
        </div>
        <footer className="settings-preview-footer">
          <span>Prototype preferences</span>
          <button type="button" className="settings-preview-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}
