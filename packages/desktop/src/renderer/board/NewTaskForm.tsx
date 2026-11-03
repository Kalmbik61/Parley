/** Форма новой задачи над колонкой Backlog: заголовок с диктовкой, детали, проект и Save. */
import { useEffect, useRef, useState } from 'react';
import { S } from '../../shared/strings.js';
import { MicButton } from '../voice/MicButton.js';
import { useDictationStore } from '../voice/dictation-store.js';
import { useTextareaDictation } from '../voice/targets.js';
import type { BoardProject } from './board-model.js';
import { useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';
import { splitTaskText } from './task-text.js';

const DICTATION_ID = 'board:new-task';
const NO_PROJECT = '';

export interface NewTaskFormProps {
  bridge: BoardBridge;
  projects: readonly BoardProject[];
  defaultPath: string | null;
  /** Сколько раз нажали Dictate, пока форма открыта: каждое нажатие включает диктовку в этой же форме, 0 — без неё. */
  dictate: number;
  onClose(): void;
}

export function NewTaskForm({ bridge, projects, defaultPath, dictate, onClose }: NewTaskFormProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [projectPath, setProjectPath] = useState<string>(defaultPath ?? NO_PROJECT);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const mounted = useRef(true);
  // Нажатия Dictate, которые форма уже превратила в `toggle`: повторный прогон эффекта (StrictMode) второго не даст.
  const handled = useRef(0);
  const dictating = useDictationStore(state => state.targetId === DICTATION_ID && state.phase !== 'idle');
  useTextareaDictation(DICTATION_ID, titleRef, setTitle);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Форма закрыта посреди записи (Cancel, Esc, другая вкладка): микрофон не остаётся включённым.
      const store = useDictationStore.getState();
      if (store.targetId === DICTATION_ID && store.phase !== 'idle') store.cancel();
    };
  }, []);

  useEffect(() => {
    if (dictate <= handled.current) return;
    handled.current = dictate;
    void useDictationStore.getState().toggle(DICTATION_ID);
  }, [dictate]);

  const canSave = !busy && !dictating && title.trim() !== '';
  const save = async (): Promise<void> => {
    if (!canSave) return;
    const target = projects.find(project => !project.inbox && project.projectPath === projectPath);
    const path = target ? target.projectPath : useBoardStore.getState().inboxPath;
    if (path === null) { setFailed(true); return; }
    const text = splitTaskText(title, details);
    if (text.title === '') return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await bridge.call('backlog.add', { projectPath: path, title: text.title, ...(text.details === '' ? {} : { details: text.details }) });
      useBoardStore.getState().apply(result);
      if (mounted.current) onClose();
    } catch {
      if (mounted.current) { setFailed(true); setBusy(false); }
    }
  };

  return (
    <form
      aria-label={S.board.newTask}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2 text-sm"
      onSubmit={event => { event.preventDefault(); void save(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
    >
      <div className="flex items-start gap-2">
        <textarea
          ref={titleRef}
          rows={1}
          aria-label={S.board.taskField}
          maxLength={8192}
          className="min-w-0 flex-1 resize-none rounded-md bg-background px-2 py-1"
          value={title}
          autoFocus
          onChange={event => setTitle(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            if (useDictationStore.getState().finishBeforeSend(DICTATION_ID)) return;
            void save();
          }}
        />
        <MicButton targetId={DICTATION_ID} size="sm" />
      </div>
      <textarea
        aria-label={S.board.detailsField}
        rows={3}
        maxLength={65536}
        className="resize-y rounded-md bg-background px-2 py-1"
        value={details}
        onChange={event => setDetails(event.target.value)}
      />
      <select
        aria-label={S.board.projectField}
        className="min-w-0 truncate rounded-md bg-background px-2 py-1"
        value={projectPath}
        onChange={event => setProjectPath(event.target.value)}
      >
        <option value={NO_PROJECT}>{S.board.noProject}</option>
        {projects.filter(project => !project.inbox).map(project => (
          <option key={project.key} value={project.projectPath}>{project.title}</option>
        ))}
      </select>
      {failed && <p role="alert" className="text-xs text-destructive">{S.board.failed}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-2 py-1 hover:bg-accent" onClick={onClose}>{S.board.cancel}</button>
        <button type="submit" disabled={!canSave} className="rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50">{S.board.save}</button>
      </div>
    </form>
  );
}
