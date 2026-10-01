/**
 * Диалог «New workspace» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.7) вместо формы новой работы (кусок 3.5,
 * спека Orca-UI 6.6): работа и её первая сессия — одним действием, как у Orca. Поля 1.7: проект (сегмент известных
 * проектов), агент (сегмент провайдеров), название и первый промпт. Ширина 520; от «+» заголовка проекта проект уже выбран,
 * иначе по умолчанию проект активной работы (как в прототипе handoff).
 *
 * Порядок вызовов — `works.create`, затем `sessions.create`. Если второй упал, работа уже есть: диалог показывает ошибку
 * сессии и «Retry», который по нажатию повторяет только `sessions.create` — проект и название тогда заперты, чтобы не
 * казалось, что повтор создаст работу с новым названием (агент, промпт и worktree остаются доступны). Ничего не создаётся
 * без явного действия человека (Create workspace, ⌘Enter, Retry).
 *
 * Пустое название берётся из первого промпта (`titleFromPrompt`); пустой промпт — тихий старт агента, он ждёт задачу в
 * терминале. Ни названия, ни промпта — ошибка: названию не из чего взяться. Первый промпт — `task` первой сессии, цель
 * работы (`goal`) пуста, ярлык сессии пуст: с промптом строка сайдбара покажет `S01`, как в прототипе, а при пустом
 * промпте (тихий старт) хост поставит метку `NEW_LABEL` core — `S01 New session` до автозаголовка Claude Code.
 *
 * «In its own worktree» (спека Orca-UI 6.6, план worktree 4.3) остаётся: виден, если `worktrees.available` для проекта.
 * «Choose a folder…» (`app.chooseFolder`) остаётся рядом с сегментом: без него в окне без работ нельзя выбрать первый проект.
 *
 * Новая работа становится активной, а вкладка сессии открывается, только когда снимок работ (`works.changed`) принёс её:
 * `sessions.create` отвечает раньше снимка, и вкладка, открытая сразу, мигнула бы телом «Session deleted» (`lib/open-when-listed.ts`).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { defaultProvider, type ProviderOption } from '../lib/default-provider.js';
import { openWhenListed } from '../lib/open-when-listed.js';
import { workKey } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';
import { Textarea } from '../ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';

export interface NewWorkDraft {
  projectPath: string | null;
  title: string;
  prompt: string;
  provider: string | null;
}

/**
 * Края названия — то же правило, что у `works.rename` (`@parley/protocol`, `TITLE_EDGES`):
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

/** Сколько знаков первого промпта идёт в название, если его не ввели (прототип handoff: первые 40 знаков первой строки). */
const DERIVED_TITLE_LENGTH = 40;

/** Название из первого промпта (1.7): первая непустая строка, до 40 знаков; в промпте одни пробелы — пусто. */
export function titleFromPrompt(prompt: string): string {
  for (const line of prompt.split('\n')) {
    const trimmed = trimTitle(line);
    if (trimmed !== '') return trimTitle([...trimmed].slice(0, DERIVED_TITLE_LENGTH).join(''));
  }
  return '';
}

/** Название, с которым уйдёт `works.create`: введённое, а если его нет — из первого промпта. */
function effectiveTitle(draft: Pick<NewWorkDraft, 'title' | 'prompt'>): string {
  const typed = trimTitle(draft.title);
  return typed !== '' ? typed : titleFromPrompt(draft.prompt);
}

/** Пределы: название 1–120, первый промпт до 20000 — по кодовым точкам; проект и агент обязательны. Тексты — S.dialogs.newWork. */
export function validateDraft(draft: NewWorkDraft): Partial<Record<keyof NewWorkDraft, string>> {
  const errors: Partial<Record<keyof NewWorkDraft, string>> = {};
  const text = S.dialogs.newWork;
  if (draft.projectPath === null) errors.projectPath = text.selectFolderRequired;
  const typed = trimTitle(draft.title);
  if (typed === '' && titleFromPrompt(draft.prompt) === '') errors.title = text.titleOrPromptRequired;
  else if (codePoints(typed) > 120) errors.title = text.titleLength;
  if (codePoints(draft.prompt) > 20000) errors.prompt = text.promptTooLong;
  if (draft.provider === null) errors.provider = text.agentRequired;
  return errors;
}

/** Имя папки проекта — последний сегмент пути; полный путь идёт в `title` пункта сегмента. */
function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, '') || projectPath;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/** Ответ `providers.list` этого открытия формы: список и агент по умолчанию для него. */
interface LoadedProviders {
  providers: ProviderOption[];
  provider: string | null;
}

export interface NewWorkComposerProps {
  open: boolean;
  /** От «+» заголовка проекта — уже выбран; `null` — ⌘N и «New workspace». */
  projectPath: string | null;
  /** Начальное название: «Create workspace …» палитры (кусок 6.2); `''` — пусто. */
  title: string;
  bridge: ParleyBridge;
  onOpenChange(open: boolean): void;
}

export function NewWorkComposer({ open, projectPath: initialProject, title: initialTitle, bridge, onOpenChange }: NewWorkComposerProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const [projectPath, setProjectPath] = useState<string | null>(initialProject);
  const [chosenFolders, setChosenFolders] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof NewWorkDraft, string>>>({});
  const [error, setError] = useState<string | null>(null);
  /** Работа создана, а `sessions.create` упал — «Retry» повторяет только его. */
  const [createdWork, setCreatedWork] = useState<{ projectPath: string; workId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Снятия ожиданий снимка (`openWhenListed`) — все гасятся при размонтировании. */
  const pendingRef = useRef(new Set<() => void>());
  /**
   * `providers.list` этого открытия. Create, нажатый раньше ответа, ждёт его, а не отказывает
   * молча «Select an agent» (раунд исправлений 2 куска 3.5: под нагрузкой ошибка оставалась под полем,
   * хотя агент по умолчанию уже пришёл и был показан).
   */
  const providersRef = useRef<Promise<LoadedProviders | null> | null>(null);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const cancel of [...pending]) cancel();
    };
  }, []);

  // Каждое открытие — с чистой формой: проект открывшего (от «+» заголовка) или проект активной работы, название из
  // палитры; агент выбирается заново по правилу (`lastProvider` помнит прошлый). Сброс — до отрисовки (`useLayoutEffect`):
  // в `useEffect` он шёл после неё, и диалог успевал показаться с названием и промптом прошлого открытия.
  useLayoutEffect(() => {
    if (!open) return;
    const activeKey = useLayoutStore.getState().activeWorkKey;
    const activeProject =
      useWorksStore.getState().entries.find((entry) => workKey(entry.projectPath, entry.map.work.id) === activeKey)?.projectPath ?? null;
    setProjectPath(initialProject ?? activeProject);
    setProvider(null);
    setTitle(initialTitle);
    setPrompt('');
    setWorktree(false);
    setFieldErrors({});
    setError(null);
    setCreatedWork(null);
    setBusy(false);
  }, [open, initialProject, initialTitle]);

  useEffect(() => {
    if (!open) return;
    providersRef.current = bridge
      .call('providers.list', {})
      .then((result) => {
        const chosen = defaultProvider(result.providers, useUiStore.getState().ui.lastProvider);
        setProviders(result.providers);
        // Выбор человека, сделанный до ответа, не затираем; черновик и сегмент — одно значение.
        setProvider((current) => current ?? chosen);
        return { providers: result.providers, provider: chosen };
      })
      .catch((err: unknown) => {
        console.warn('[parley] providers.list', err);
        setError(errorText(decodeIpcError(err).code, S.errors.actions.loadProviders));
        return null;
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
    onOpenChange(false);
  };

  const createSession = async (work: { projectPath: string; workId: string }, chosen: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { ref } = await bridge.call('sessions.create', {
        projectPath: work.projectPath,
        workId: work.workId,
        provider: chosen,
        // Пустой ярлык: с промптом строка сайдбара покажет `S01`, без него хост поставит «новую сессию» (см. докблок).
        label: '',
        task: prompt,
        parent: null,
        worktree,
      });
      useUiStore.getState().patchUi({ lastProvider: chosen });
      openWhenListed(work.projectPath, work.workId, { kind: 'session', sessionId: ref.sessionId }, pendingRef.current);
      finish();
    } catch (err) {
      console.warn('[parley] sessions.create', err);
      setCreatedWork(work);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createSession));
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (createdWork !== null) {
      await createSession(createdWork, provider ?? '');
      return;
    }
    // Список агентов ещё не пришёл — дождаться его: состояние этого замыкания устарело бы,
    // поэтому агент берётся из ответа.
    let chosen = provider;
    const loading = providersRef.current;
    if (chosen === null && loading !== null) {
      setBusy(true);
      const loaded = await loading;
      setBusy(false);
      if (loaded !== null) chosen = loaded.provider;
    }
    const errors = validateDraft({ projectPath, title, prompt, provider: chosen });
    setFieldErrors(errors);
    if (projectPath === null || Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    let workId: string;
    try {
      ({ workId } = await bridge.call('works.create', { projectPath, title: effectiveTitle({ title, prompt }), goal: '' }));
    } catch (err) {
      console.warn('[parley] works.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createWorkspace));
      setBusy(false);
      return;
    }
    await createSession({ projectPath, workId }, chosen ?? '');
  };

  const workLocked = createdWork !== null;
  const text = S.dialogs.newWork;
  const fieldError = (key: keyof NewWorkDraft): JSX.Element | null =>
    fieldErrors[key] === undefined ? null : <span className="text-xs text-destructive">{fieldErrors[key]}</span>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[520px] max-w-[calc(100vw-2rem)]"
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !event.metaKey) return;
          event.preventDefault();
          void submit();
        }}
      >
        <DialogTitle>{text.title}</DialogTitle>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <div className="flex min-w-0 flex-col gap-1">
            <span id="new-work-project">{text.projectField}</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {knownProjects.length > 0 ? (
                <ToggleGroup
                  type="single"
                  value={projectPath ?? ''}
                  disabled={workLocked}
                  aria-labelledby="new-work-project"
                  // Длинных имён и многих проектов сегмент не выталкивает за край: он переносится, имя обрезается.
                  className="max-w-full flex-wrap rounded-[18px]"
                  onValueChange={(value) => {
                    // Повторный клик по выбранному пункту Radix сообщает пустой строкой — проект не снимается.
                    if (value !== '') setProjectPath(value);
                  }}
                >
                  {knownProjects.map((path) => (
                    <ToggleGroupItem key={path} value={path} title={path} className="max-w-[16rem]">
                      <span className="min-w-0 truncate">{projectName(path)}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              ) : null}
              <Button type="button" variant="outline" size="sm" disabled={workLocked} onClick={() => void chooseFolder()}>
                {text.chooseFolder}
              </Button>
            </div>
            {fieldError('projectPath')}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span id="new-work-agent">{text.agentField}</span>
            <ToggleGroup
              type="single"
              value={provider ?? ''}
              aria-labelledby="new-work-agent"
              className="max-w-full self-start"
              onValueChange={(value) => {
                if (value !== '') setProvider(value);
              }}
            >
              {providers
                .filter((item) => item.available)
                .map((item) => (
                  <ToggleGroupItem key={item.id} value={item.id}>
                    {providerName(item.id, item.label)}
                  </ToggleGroupItem>
                ))}
            </ToggleGroup>
            {fieldError('provider')}
          </div>
          <label className="flex flex-col gap-1">
            {text.titleField}
            <Input
              value={title}
              disabled={workLocked}
              placeholder={text.titlePlaceholder}
              onChange={(event) => setTitle(event.target.value)}
            />
            {fieldError('title')}
          </label>
          <label className="flex flex-col gap-1">
            {text.promptField}
            <Textarea
              value={prompt}
              placeholder={text.promptPlaceholder}
              className="min-h-[96px] rounded-2xl"
              onChange={(event) => setPrompt(event.target.value)}
            />
            {fieldError('prompt')}
          </label>
          {worktreeAvailable ? (
            <label className="flex items-center gap-2">
              <Switch checked={worktree} onCheckedChange={setWorktree} />
              {S.dialogs.newSession.inOwnWorktree}
            </label>
          ) : null}
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="items-center">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {workLocked ? S.common.retry : text.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
