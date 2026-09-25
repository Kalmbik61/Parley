/**
 * Оверлеи: какой открыт, что в нём выбрано и что делает `Enter`
 * (дизайн TUI v2, 2.4 и 5.2–5.3; макеты 4.0–4.11).
 *
 * Пока оверлей открыт, ввод идёт ему, а не гостю: `use-actions.ts` держит
 * `capture`, а разбирает клавиши этот хук. Содержимое строят чистые функции
 * `overlays.ts` и `work-dialogs.ts`, рамку рисует `components/overlay.tsx`.
 */

import {
  checkSession,
  configPath,
  createWork,
  ENV_NAMES,
  parseSetting,
  planResume,
  readBrief,
  registerResumed,
  requestAutoSummary,
  THEME_NAMES,
  UNTITLED_WORK,
  updateMap,
  type ActivityLog,
  type HarnasConfig,
  type SessionActivity,
  type SessionIndex,
  type TypedSettingKey,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import { useInput } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DotState } from './components/activity-dot.js';
import type { OverlayView } from './components/overlay.js';
import { branchOf } from './components/sidebar.js';
import { withHome } from './format.js';
import { glyphs } from './glyphs.js';
import {
  detailsView,
  filterItems,
  helpView,
  historyItems,
  pickerView,
  SETTINGS,
  settingsView,
  workItems,
  type PickerItem,
} from './overlays.js';
import { workRunKey } from './pty/use-agent-pty.js';
import type { PanelState } from './use-panel.js';
import { withoutMouse } from './use-prefix-input.js';
import type { SelectionState } from './use-selection.js';
import type { StatusEventInit } from './use-status.js';
import {
  closeSessionDialog,
  deleteBlockedDialog,
  deleteSessionDialog,
  deleteWorkBlockedDialog,
  deleteWorkDialog,
  exitDialog,
  launchDialog,
  resumeDialog,
  resumePreview,
  summaryDialog,
  type DialogSpec,
} from './work-dialogs.js';
import { workKey } from './work-rows.js';

/** Что может быть открыто; одновременно — не больше одного (§4.0). */
export type OverlayKind =
  | 'details'
  | 'works'
  | 'history'
  | 'help'
  /** Настройки: поля файла, `Enter` переключает или открывает ввод (3.4). */
  | 'settings'
  | 'sidebar'
  /** Подтверждение 4.5–4.11: тело рисует `dialog.tsx` внутри рамки. */
  | 'confirm';

/** Действие, открывающее оверлей: клавиша префикса или `Enter` в сайдбаре. */
export type OverlayAction =
  | Exclude<OverlayKind, 'confirm'>
  | 'launch'
  | 'resume'
  | 'summary'
  | 'close'
  | 'delete'
  | 'deleteWork'
  | 'exit';

export interface OverlaysOptions {
  /** Проект харнесса: в нём заводятся работы и ищется история (5.3). */
  projectPath: string;
  prefixName: string;
  /** Все работы, включая чужие проекты: их показывает пикер работ (4.2). */
  works: readonly WorkEntry[];
  /** Индекс логов провайдера: пикер истории, токены и ветка. */
  sessions: readonly SessionIndex[];
  index: (session: WorkSession) => SessionIndex | undefined;
  /** Что известно про лог провайдера: по нему живость сессии без pid (5.4). */
  log: (session: WorkSession) => ActivityLog | null;
  activityOf: (sessionId: string) => SessionActivity | null;
  stateOf: (session: WorkSession) => DotState;
  workState: (key: string) => DotState | null;
  /** Выбранная работа и её сессия: о них детали, запуск и возобновление. */
  entry: WorkEntry | undefined;
  session: WorkSession | null;
  /** Ключ панели выбранной сессии; `null` — сессии нет. */
  runKey: string | null;
  /** Сессии выбранной работы в порядке дерева: по ним ходит оверлей сайдбара. */
  order: readonly string[];
  /** Ветка проекта из `.git/HEAD`: запасной источник для пикера работ (4.2). */
  branch: (projectPath: string) => string | null;
  panel: PanelState;
  selection: SelectionState;
  /** Настройки как они сейчас применены: их показывает и правит оверлей 4.14. */
  config: HarnasConfig;
  /** Ключи из окружения: файл их не перекроет, строка тусклая (3.4). */
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
  updateConfig: (patch: Partial<HarnasConfig>) => void;
  /** Закрепить чужую работу в сайдбаре до выхода (2.1, решение №3). */
  pin: (key: string) => void;
  push: (events: readonly StatusEventInit[]) => void;
  fail: (reason: unknown) => void;
  exit: () => void;
}

export interface OverlaysState {
  kind: OverlayKind | null;
  /** Вид оверлея-списка; `null` — открыт не список. */
  view: OverlayView | null;
  /** Подтверждение внутри рамки: его тело рисует `dialog.tsx` (4.5–4.11). */
  confirm: { id: number; spec: DialogSpec } | null;
  /** Своя ширина открытого оверлея: по ней считается раскладка (§4.0). */
  desired: number | null;
  /** Прокрутка тела и строка, которую надо держать в окне. */
  scroll: number;
  focus: number | undefined;
  open: (action: OverlayAction) => void;
  close: () => void;
  submit: () => void;
}

/** Ширина подтверждений — их вид не зависит от содержимого (§4.0). */
const CONFIRM = 48;
const PICKER = 56;
const DETAILS = 64;

/** Патч из одного поля: ключ приходит из `SETTINGS` строкой, а не литералом. */
function patchOf<K extends keyof HarnasConfig>(
  key: K,
  value: HarnasConfig[K],
): Partial<HarnasConfig> {
  const patch: Partial<HarnasConfig> = {};
  patch[key] = value;
  return patch;
}

const byRecency = (a: SessionIndex, b: SessionIndex): number =>
  String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? ''));

export function useOverlays(options: OverlaysOptions): OverlaysState {
  const { projectPath, prefixName, works, sessions, index, entry, session, runKey } = options;
  const { log } = options;
  const { order, branch, panel, selection, pin, push, fail, exit } = options;
  const { config, fromEnv, updateConfig } = options;

  const [kind, setKind] = useState<OverlayKind | null>(null);
  const [filter, setFilter] = useState('');
  const [at, setAt] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  // Сессии, которым дозаказали авто-резюме: пока считается, это видно в деталях
  // (макет 4.1), а не только в строке статуса.
  const [summarizing, setSummarizing] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<{ id: number; spec: DialogSpec; run: () => void } | null>(
    null,
  );
  const confirmId = useRef(0);
  const g = glyphs();

  const visible: OverlayKind | null = kind;

  const close = useCallback(() => {
    setKind(null);
    setConfirm(null);
    setEditing(null);
    setFilter('');
    setAt(0);
    setScroll(0);
  }, []);

  const askConfirm = useCallback((spec: DialogSpec, run: () => void) => {
    setConfirm({ id: confirmId.current++, spec, run });
    setKind('confirm');
  }, []);

  // Работы глобального индекса и сессии истории текущего проекта — списки
  // пикеров; фильтр применяется к готовым строкам (4.2, 4.3).
  const workRows = useMemo(
    () =>
      workItems(
        works,
        options.workState,
        (item) => branchOf(item, index, branch),
        (item) => workKey(item.projectPath, item.map.work.id),
        g,
      ),
    [works, options.workState, index, branch, g],
  );
  const history = useMemo(
    () =>
      sessions
        .filter((item) => item.projectPath === projectPath && item.provider === 'claude')
        .sort(byRecency),
    [sessions, projectPath],
  );
  const historyRows = useMemo(() => historyItems(history, g), [history, g]);

  const rows: readonly PickerItem[] =
    kind === 'works' ? workRows : kind === 'history' ? historyRows : [];
  const shown = useMemo(() => filterItems(rows, filter), [rows, filter]);

  /** Выбранная строка пикера; `undefined` — фильтр не оставил ничего. */
  const chosen = shown[Math.min(at, Math.max(0, shown.length - 1))];

  /** Цель работы правится прямо в деталях (решение №8). */
  const saveGoal = useCallback(
    (goal: string) => {
      setEditing(null);
      if (entry === undefined) return;
      void updateMap(entry.projectPath, entry.map.work.id, (map) => {
        map.work.goal = goal;
      }).catch(fail);
    },
    [entry, fail],
  );

  /** `Enter` в пикере истории: регистрация в текущей работе и `--resume` (5.3). */
  const resumeFromHistory = useCallback(
    (item: SessionIndex) => {
      close();
      const project = entry?.projectPath ?? projectPath;
      void (async () => {
        const workId =
          entry?.map.work.id ??
          (await createWork(projectPath, { title: UNTITLED_WORK, goal: '' })).work.id;
        const created = await registerResumed(project, workId, item.id, item.title ?? item.id);
        panel.start(project, workId, created, 'resume');
        // Работа могла быть заведена парой строк выше: ключ передаётся явно (5.3).
        selection.attach(created.id, workKey(project, workId));
      })().catch(fail);
    },
    [close, entry, projectPath, panel, selection, fail],
  );

  const open = useCallback(
    (action: OverlayAction) => {
      const guard = (message: string): void => push([{ text: message }]);

      if (
        action === 'works' ||
        action === 'history' ||
        action === 'help' ||
        action === 'settings' ||
        action === 'sidebar'
      ) {
        setFilter('');
        setAt(0);
        setScroll(0);
        setEditing(null);
        setKind(action);
        return;
      }

      if (action === 'exit') {
        // SIGHUP при выходе получают только PTY-дети харнесса (решение №5).
        const live = works.flatMap((item) =>
          item.map.sessions
            .filter((one) => panel.alive(workRunKey(item.projectPath, item.map.work.id, one.id)))
            .map((one) => one.label),
        );
        if (live.length === 0) return exit();
        askConfirm(exitDialog(live), exit);
        return;
      }

      if (action === 'deleteWork') {
        if (entry === undefined) return guard('работа не выбрана');
        const { projectPath: project, map } = entry;
        const id = map.work.id;
        void (async () => {
          // Как и у сессии: живую не у харнесса закрыть нечем, а без записи она
          // осталась бы работать в никуда (5.5). Свои PTY панель закроет сама.
          for (const one of map.sessions) {
            if (one.status !== 'active' || panel.alive(workRunKey(project, id, one.id))) continue;
            const { alive } = await checkSession(one, {
              lastRecordAt: log(one)?.lastRecordAt ?? null,
            });
            if (alive) return askConfirm(deleteWorkBlockedDialog(id, one, g, CONFIRM - 2), close);
          }
          const dialog = deleteWorkDialog(id, map.work.title, map.sessions.length, g, CONFIRM - 2);
          askConfirm(dialog, () => {
            close();
            const ids = map.sessions.map((one) => one.id);
            panel.removeWork({ projectPath: project, workId: id }, ids, () =>
              push([{ text: 'работа удалена' }]),
            );
          });
        })().catch(fail);
        return;
      }

      if (entry === undefined || session === null) return guard('сессия не выбрана');
      const project = entry.projectPath;
      const workId = entry.map.work.id;

      if (action === 'details') {
        setScroll(0);
        setEditing(null);
        setKind('details');
        return;
      }

      if (action === 'launch') {
        if (session.status !== 'pending') return guard(`«${session.label}» уже запускалась`);
        // Бриф перечитывается с диска: между созданием и запуском его правят
        // своим редактором (макет 4.5).
        void readBrief(project, workId, session.id)
          .then((brief) =>
            askConfirm(launchDialog(project, workId, session, brief, g, CONFIRM - 2), () => {
              close();
              panel.start(project, workId, session, 'launch');
              selection.attach(session.id);
            }),
          )
          .catch(fail);
        return;
      }

      if (action === 'resume') {
        if (session.status === 'pending' || session.status === 'active') {
          return guard(`«${session.label}» не завершена — возобновлять нечего`);
        }
        void planResume(project, workId, session)
          .then((plan) => {
            const command = resumePreview(plan.command, plan.args, session.providerSessionId);
            askConfirm(resumeDialog(session, command, g), () => {
              close();
              panel.start(project, workId, session, 'resume');
              selection.attach(session.id);
            });
          })
          .catch(fail);
        return;
      }

      if (action === 'summary') {
        if (session.status !== 'exited') {
          return guard(`«${session.label}»: резюме дозаказывают вышедшей сессии`);
        }
        askConfirm(summaryDialog(session, g), () => {
          close();
          push([{ text: `авто-резюме для «${session.label}» считается…` }]);
          setSummarizing((now) => new Set([...now, session.id]));
          void requestAutoSummary(project, workId, session.id)
            .then(() => push([{ text: `авто-резюме для «${session.label}» готово` }]))
            .catch(fail)
            .finally(() =>
              setSummarizing((now) => new Set([...now].filter((id) => id !== session.id))),
            );
        });
        return;
      }

      if (action === 'delete') {
        const atHarness = runKey !== null && panel.alive(runKey);
        void (async () => {
          // Живую сессию, чей процесс не у нас, удалять нельзя: закрыть её нечем,
          // а без записи она осталась бы работать в никуда (раздел C). Живость
          // считает та же `checkSession`, что и сверка карты: у CLI-сессии с
          // `pid: null` её решает свежесть журнала.
          if (!atHarness && session.status === 'active') {
            const { alive } = await checkSession(session, {
              lastRecordAt: log(session)?.lastRecordAt ?? null,
            });
            if (alive) return askConfirm(deleteBlockedDialog(session, g, CONFIRM - 2), close);
          }
          const children = entry.map.sessions
            .filter((item) => item.parent === session.id)
            .map((item) => item.label);
          askConfirm(deleteSessionDialog(session, children, g, CONFIRM - 2), () => {
            close();
            panel.remove({ projectPath: project, workId }, session.id, () =>
              push([{ text: 'сессия удалена' }]),
            );
          });
        })().catch(fail);
        return;
      }

      // 'close': SIGHUP процессу панели (макет 4.8).
      if (session.status !== 'active') return guard(`«${session.label}» не запущена`);
      if (runKey === null || !panel.alive(runKey)) {
        return guard(`«${session.label}» запущена вне харнесса — закрыть её нечем`);
      }
      askConfirm(closeSessionDialog(session, g), () => {
        close();
        panel.close(runKey);
      });
    },
    [works, entry, session, runKey, log, panel, selection, askConfirm, close, push, fail, exit, g],
  );

  /**
   * Событие о клавише, которую разбираем прямо сейчас (оверлей настроек).
   * Отдельной микрозадачей: гашение событий по нажатию (`use-actions`,
   * `onCapture`) читает тот же чанк stdin позже нас и погасило бы это событие,
   * не показав его (дизайн координации, раздел 5).
   */
  const report = useCallback(
    (text: string) => {
      queueMicrotask(() => push([{ text }]));
    },
    [push],
  );

  /** Ходьба по сессиям в оверлее сайдбара (§1.3). */
  const walk = useCallback(
    (delta: number) => {
      if (order.length === 0) return;
      const now = Math.max(0, order.indexOf(selection.session ?? ''));
      const next = order[(now + delta + order.length) % order.length];
      if (next !== undefined) selection.selectSession(next);
    },
    [order, selection],
  );

  useInput(
    (raw, key) => {
      // Ink разбирает stdin параллельно с харнессом и отдаёт клик мышью обычным
      // текстом: без чистки он печатался бы в фильтр пикера или в поле цели.
      // Пока оверлей открыт, мышь не делает ничего (дизайн 3.1).
      const input = withoutMouse(raw);
      if (raw !== '' && input === '') return;

      if (key.escape) {
        if (editing !== null) return setEditing(null);
        return close();
      }

      if (kind === 'settings') {
        const setting = SETTINGS[at];
        if (setting === undefined) return;
        if (editing !== null) {
          if (key.return) {
            // Ввод открыт только у текстовых ключей: булевы переключаются на месте.
            const parsed = parseSetting(setting.key as TypedSettingKey, editing);
            // Битое значение — событие, а ввод остаётся открытым (решение плана).
            if ('error' in parsed) return report(parsed.error);
            updateConfig(patchOf(setting.key, parsed.value));
            return setEditing(null);
          }
          if (key.backspace || key.delete) return setEditing([...editing].slice(0, -1).join(''));
          if (key.ctrl || key.meta || input === '') return;
          return setEditing(editing + input);
        }
        if (input === 'j' || key.downArrow) {
          return setAt((now) => Math.min(now + 1, SETTINGS.length - 1));
        }
        if (input === 'k' || key.upArrow) return setAt((now) => Math.max(0, now - 1));

        // Тема — третий вид поля: не булева и не типизированная, ввода текста
        // нет. `←`/`→` листают `THEME_NAMES` по кругу и сразу пишут файл, как
        // булевы; `Enter` на этой строке делает то же, что `→` — иначе строка
        // выглядела бы мёртвой (план кусок 2, задача D).
        if (setting.key === 'theme' && (key.leftArrow || key.rightArrow || key.return)) {
          if (fromEnv.includes(setting.key)) {
            const name = ENV_NAMES[setting.key];
            return report(`${setting.key} задано окружением ${name} — файл его не перекроет`);
          }
          const names: readonly string[] = THEME_NAMES;
          const delta = key.leftArrow ? -1 : 1;
          const from = Math.max(0, names.indexOf(config.theme));
          const next = names[(from + delta + names.length) % names.length];
          if (next !== undefined) updateConfig(patchOf('theme', next));
          return;
        }

        if (!key.return) return;
        if (fromEnv.includes(setting.key)) {
          const name = ENV_NAMES[setting.key];
          return report(`${setting.key} задано окружением ${name} — файл его не перекроет`);
        }
        const value = config[setting.key];
        // Булеву `Enter` переключает сразу, остальным открывает ввод (решение плана).
        if (typeof value === 'boolean') return updateConfig(patchOf(setting.key, !value));
        return setEditing(String(value));
      }

      if (kind === 'details') {
        if (editing !== null) {
          if (key.return) return saveGoal(editing);
          if (key.backspace || key.delete) return setEditing([...editing].slice(0, -1).join(''));
          if (key.ctrl || key.meta || input === '') return;
          return setEditing(editing + input);
        }
        if (input === 'e') return setEditing(entry?.map.work.goal ?? '');
      }

      if (kind === 'sidebar') {
        if (input === 'b') return close();
        if (input === 'j' || key.downArrow) return walk(1);
        if (input === 'k' || key.upArrow) return walk(-1);
        if (key.return) {
          if (selection.session !== null) selection.attach(selection.session);
          close();
        }
        return;
      }

      if (kind === 'works' || kind === 'history') {
        if (key.downArrow) return setAt((now) => Math.min(now + 1, Math.max(0, shown.length - 1)));
        if (key.upArrow) return setAt((now) => Math.max(0, now - 1));
        if (key.return) {
          if (chosen === undefined) return;
          if (kind === 'works') {
            pin(chosen.key);
            selection.selectWork(chosen.key);
            close();
            return;
          }
          const item = history.find((one) => one.id === chosen.key);
          if (item !== undefined) resumeFromHistory(item);
          return;
        }
        if (key.backspace || key.delete) {
          setAt(0);
          return setFilter((now) => [...now].slice(0, -1).join(''));
        }
        if (key.ctrl || key.meta || input === '') return;
        setAt(0);
        return setFilter((now) => now + input);
      }

      // Справка и детали: набор текста фильтрует справку, `↑↓/jk` листают тело.
      if (key.downArrow || input === 'j') return setScroll((now) => now + 1);
      if (key.upArrow || input === 'k') return setScroll((now) => Math.max(0, now - 1));
      if (kind === 'help') {
        if (key.backspace || key.delete) {
          return setFilter((now) => [...now].slice(0, -1).join(''));
        }
        if (key.ctrl || key.meta || input === '') return;
        setScroll(0);
        setFilter((now) => now + input);
      }
    },
    { isActive: visible !== null && visible !== 'confirm' },
  );

  const view = useMemo<OverlayView | null>(() => {
    if (kind === 'works') {
      return pickerView({
        title: 'работы',
        items: shown,
        filter,
        at,
        footer: ' Enter — выбрать · Esc',
        g,
      });
    }
    if (kind === 'history') {
      return pickerView({
        // Заголовок — путь проекта с тильдой, а не одно его имя (макет 4.3).
        title: `история · ${withHome(projectPath)}`,
        items: shown,
        filter,
        at,
        footer: ` Enter — возобновить в «${entry?.map.work.title ?? UNTITLED_WORK}» · Esc`,
        g,
      });
    }
    if (kind === 'help') return helpView(prefixName, filter, configPath(), g);
    if (kind === 'settings') {
      return settingsView({ config, fromEnv, at, editing, configFile: configPath(), g });
    }
    if (kind === 'details' && entry !== undefined && session !== null) {
      return detailsView({
        entry,
        session,
        state: options.stateOf(session),
        activity: options.activityOf(session.id),
        index: index(session),
        atHarness: runKey !== null && panel.alive(runKey),
        editing,
        summarizing: summarizing.has(session.id),
        prefix: prefixName,
        g,
      });
    }
    return null;
  }, [
    kind,
    shown,
    filter,
    at,
    entry,
    session,
    editing,
    config,
    fromEnv,
    summarizing,
    prefixName,
    projectPath,
    index,
    runKey,
    panel,
    options.stateOf,
    options.activityOf,
    g,
  ]);

  const desired =
    visible === null
      ? null
      : visible === 'confirm'
        ? CONFIRM
        : visible === 'details'
          ? DETAILS
          : PICKER;

  return {
    kind: visible,
    view,
    confirm: confirm === null ? null : { id: confirm.id, spec: confirm.spec },
    desired,
    scroll,
    // Шапка и линейка настроек не строки списка: фокус считается от них (4.14).
    focus: kind === 'works' || kind === 'history' || kind === 'settings' ? at + 2 : undefined,
    open,
    close,
    submit: () => confirm?.run(),
  };
}
