/**
 * Форма новой работы (кусок 3.5, спека 6.6) вместо `NewWorkDialog`: работа и её первая
 * сессия — одним действием, как у Orca. Диалог шириной 560 px; от «+» заголовка проекта
 * проект уже выбран.
 *
 * Порядок вызовов — `works.create`, затем при «Start a session» `sessions.create`. Если
 * второй упал, работа уже есть: форма показывает ошибку сессии и «Retry», который по нажатию
 * повторяет только `sessions.create` — поля работы тогда заперты, чтобы не казалось, что
 * повтор создаст работу с новым названием. Ничего не создаётся без явного действия человека
 * (Create, ⌘Enter, Retry).
 *
 * Новая работа становится активной, а вкладка сессии открывается, только когда снимок работ
 * (`works.changed`) принёс её: `sessions.create` отвечает раньше снимка, и вкладка, открытая
 * сразу, мигнула бы телом «Session deleted». Ожидание живёт в подписке на стор работ, а не в
 * компоненте: форму успевают закрыть, а при «Create more» ждут сразу несколько работ.
 */

import { useEffect, useState } from 'react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { openTab } from '../layout/tree.js';
import { defaultProvider, type ProviderOption } from '../lib/default-provider.js';
import { workKey } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import { Textarea } from '../ui/textarea.js';

export interface NewWorkDraft {
  projectPath: string | null;
  title: string;
  goal: string;
  startSession: boolean;
  provider: string | null;
  label: string;
  task: string;
  worktree: boolean;
  createMore: boolean;
}

/**
 * Края названия — то же правило, что у `works.rename` (`@harnas/protocol`, `TITLE_EDGES`):
 * невидимые символы формата считаются пробелами, иначе название из одних ZWSP прошло бы.
 * Повторено здесь, а не взято из схемы: `works.create` названия не обрезает (старые клиенты),
 * и окно шлёт уже обрезанное.
 */
const TITLE_EDGES = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

export function trimTitle(title: string): string {
  return title.replace(TITLE_EDGES, '');
}

/** Счёт по кодовым точкам: эмодзи — один символ, а не два, как у `length`. */
const codePoints = (text: string): number => [...text].length;

/** Пределы спеки 6.6: название 1–120, цель до 4000, ярлык до 40, задача до 20000 — по кодовым точкам. Тексты — S.dialogs.newWork. */
export function validateDraft(draft: NewWorkDraft): Partial<Record<keyof NewWorkDraft, string>> {
  const errors: Partial<Record<keyof NewWorkDraft, string>> = {};
  const text = S.dialogs.newWork;
  if (draft.projectPath === null) errors.projectPath = text.selectFolderRequired;
  const title = codePoints(trimTitle(draft.title));
  if (title < 1 || title > 120) errors.title = text.titleLength;
  if (codePoints(draft.goal) > 4000) errors.goal = text.goalTooLong;
  // Поля сессии без «Start a session» не уходят на хост — и не проверяются.
  if (draft.startSession) {
    if (draft.provider === null) errors.provider = text.agentRequired;
    if (codePoints(draft.label) > 40) errors.label = text.labelTooLong;
    if (codePoints(draft.task) > 20000) errors.task = text.taskTooLong;
  }
  return errors;
}

/**
 * Делает работу активной и открывает вкладку сессии, когда снимок работ её принёс. Работа
 * ещё не гидрирована — `apply` сам ждёт `hydrate` в очереди (кусок 2.2).
 */
function activateWhenListed(projectPath: string, workId: string, sessionId: string | null): void {
  const key = workKey(projectPath, workId);
  const listed = (): boolean => {
    const entry = useWorksStore.getState().entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
    return entry !== undefined && (sessionId === null || entry.map.sessions.some((session) => session.id === sessionId));
  };
  const activate = (): void => {
    useLayoutStore.getState().setActiveWork(key);
    if (sessionId !== null) {
      useLayoutStore.getState().apply(key, (layout) => openTab(layout, { kind: 'terminal', id: tabId.terminal(sessionId), sessionId }));
    }
  };
  if (listed()) {
    activate();
    return;
  }
  const unsubscribe = useWorksStore.subscribe(() => {
    if (!listed()) return;
    unsubscribe();
    activate();
  });
}

/** Значение пункта «Choose a folder…» в списке проектов — путём оно быть не может. */
const CHOOSE_FOLDER = '\u0000choose-folder';

export interface NewWorkComposerProps {
  open: boolean;
  /** От «+» заголовка проекта — уже выбран; `null` — ⌘N и «New workspace». */
  projectPath: string | null;
  bridge: HarnasBridge;
  onOpenChange(open: boolean): void;
}

export function NewWorkComposer({ open, projectPath: initialProject, bridge, onOpenChange }: NewWorkComposerProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const [projectPath, setProjectPath] = useState<string | null>(initialProject);
  const [chosenFolders, setChosenFolders] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [startSession, setStartSession] = useState(true);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [task, setTask] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof NewWorkDraft, string>>>({});
  const [error, setError] = useState<string | null>(null);
  /** Работа создана, а `sessions.create` упал — «Retry» повторяет только его. */
  const [createdWork, setCreatedWork] = useState<{ projectPath: string; workId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Каждое открытие — с чистой формой и проектом открывшего; «Create more» живёт до
  // перезапуска окна, агент выбирается заново по правилу (`lastProvider` помнит прошлый).
  useEffect(() => {
    if (!open) return;
    setProjectPath(initialProject);
    setTitle('');
    setGoal('');
    setTask('');
    setLabel('');
    setWorktree(false);
    setFieldErrors({});
    setError(null);
    setCreatedWork(null);
    setBusy(false);
  }, [open, initialProject]);

  useEffect(() => {
    if (!open) return;
    bridge
      .call('providers.list', {})
      .then((result) => {
        setProviders(result.providers);
        setProvider(defaultProvider(result.providers, useUiStore.getState().ui.lastProvider));
      })
      .catch((err: unknown) => {
        console.warn('[harnas] providers.list', err);
        setError(errorText(decodeIpcError(err).code, S.errors.actions.loadProviders));
      });
  }, [open, bridge]);

  useEffect(() => {
    setWorktreeAvailable(false);
    setWorktree(false);
    if (!open || projectPath === null) return;
    let stale = false;
    bridge
      .call('worktrees.available', { projectPath })
      .then((result) => {
        if (!stale) setWorktreeAvailable(result.available);
      })
      .catch(() => {
        // Без ответа поле просто не показывается.
      });
    return () => {
      stale = true;
    };
  }, [open, bridge, projectPath]);

  const knownProjects = [...new Set([...entries.map((entry) => entry.projectPath), ...chosenFolders])].sort();

  const chooseFolder = async (): Promise<void> => {
    const dir = await bridge.app.chooseFolder();
    if (dir === null) return;
    setChosenFolders((current) => (current.includes(dir) ? current : [...current, dir]));
    setProjectPath(dir);
  };

  const finish = (): void => {
    setBusy(false);
    setCreatedWork(null);
    if (createMore) {
      setTitle('');
      setGoal('');
      setTask('');
      return;
    }
    onOpenChange(false);
  };

  const createSession = async (work: { projectPath: string; workId: string }): Promise<void> => {
    const chosen = provider ?? '';
    // Пустой ярлык по спеке 6.6 — имя агента; хост пустой ярлык пишет как есть.
    const sessionLabel = label === '' ? (providers.find((item) => item.id === chosen)?.label ?? chosen) : label;
    setBusy(true);
    setError(null);
    try {
      const { ref } = await bridge.call('sessions.create', {
        projectPath: work.projectPath,
        workId: work.workId,
        provider: chosen,
        label: sessionLabel,
        task,
        parent: null,
        worktree,
      });
      useUiStore.getState().patchUi({ lastProvider: chosen });
      activateWhenListed(work.projectPath, work.workId, ref.sessionId);
      finish();
    } catch (err) {
      console.warn('[harnas] sessions.create', err);
      setCreatedWork(work);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createSession));
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (createdWork !== null) {
      await createSession(createdWork);
      return;
    }
    const errors = validateDraft({ projectPath, title, goal, startSession, provider, label, task, worktree, createMore });
    setFieldErrors(errors);
    if (projectPath === null || Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    let workId: string;
    try {
      ({ workId } = await bridge.call('works.create', { projectPath, title: trimTitle(title), goal }));
    } catch (err) {
      console.warn('[harnas] works.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createWorkspace));
      setBusy(false);
      return;
    }
    if (!startSession) {
      activateWhenListed(projectPath, workId, null);
      finish();
      return;
    }
    await createSession({ projectPath, workId });
  };

  const workLocked = createdWork !== null;
  const text = S.dialogs.newWork;
  const fieldError = (key: keyof NewWorkDraft): JSX.Element | null =>
    fieldErrors[key] === undefined ? null : <span className="text-xs text-destructive">{fieldErrors[key]}</span>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[560px] max-w-[560px]"
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !event.metaKey) return;
          event.preventDefault();
          void submit();
        }}
      >
        <DialogTitle>{text.title}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span>{text.projectField}</span>
            <Select
              value={projectPath ?? ''}
              disabled={workLocked}
              onValueChange={(value) => {
                if (value === CHOOSE_FOLDER) void chooseFolder();
                else setProjectPath(value);
              }}
            >
              <SelectTrigger aria-label={text.projectField}>
                <SelectValue placeholder={text.chooseFolderPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {knownProjects.map((path) => (
                  <SelectItem key={path} value={path}>
                    {path}
                  </SelectItem>
                ))}
                <SelectItem value={CHOOSE_FOLDER}>{text.chooseFolderPlaceholder}</SelectItem>
              </SelectContent>
            </Select>
            {fieldError('projectPath')}
          </div>
          <label className="flex flex-col gap-1">
            {text.titleField}
            <Input value={title} disabled={workLocked} onChange={(event) => setTitle(event.target.value)} />
            {fieldError('title')}
          </label>
          <label className="flex flex-col gap-1">
            {text.goalField}
            <Textarea value={goal} disabled={workLocked} onChange={(event) => setGoal(event.target.value)} />
            {fieldError('goal')}
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={startSession} disabled={workLocked} onCheckedChange={setStartSession} />
            {text.startSession}
          </label>
          {startSession ? (
            <>
              <div className="flex flex-col gap-1">
                <span>{text.agentField}</span>
                <Select value={provider ?? ''} onValueChange={setProvider}>
                  <SelectTrigger aria-label={text.agentField}>
                    <SelectValue placeholder={S.dialogs.newSession.providerPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers
                      .filter((item) => item.available)
                      .map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {fieldError('provider')}
              </div>
              <label className="flex flex-col gap-1">
                {S.dialogs.newSession.labelField}
                <Input value={label} onChange={(event) => setLabel(event.target.value)} />
                {fieldError('label')}
              </label>
              <label className="flex flex-col gap-1">
                {S.dialogs.newSession.taskField}
                <Textarea
                  placeholder={S.dialogs.newSession.taskPlaceholder}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                />
                {fieldError('task')}
              </label>
              {worktreeAvailable ? (
                <label className="flex items-center gap-2">
                  <Switch checked={worktree} onCheckedChange={setWorktree} />
                  {S.dialogs.newSession.inOwnWorktree}
                </label>
              ) : null}
            </>
          ) : null}
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="items-center">
          <label className="mr-auto flex items-center gap-2 text-sm">
            <Checkbox checked={createMore} onCheckedChange={(checked) => setCreateMore(checked === true)} />
            {text.createMore}
          </label>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {workLocked ? S.common.retry : S.common.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
