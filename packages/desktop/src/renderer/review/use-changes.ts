/**
 * Загрузка «Изменений» сессии (кусок 8.2a, спека 11.1, 11.5): одна на вкладку
 * «Изменения» (8.2b) и вкладку диффа (8.3), с правилами обновления спеки 11.1.
 * Всегда `patch: false`: разметке и Monaco текст патча не нужен, а ответ без него мал.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MergeCheck, WorkEntry } from '@harnas/core';
import { HOST_ERROR_REASONS, refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { changesErrorText, type ChangesSource } from './state.js';
import { useReviewStore } from './store.js';

/** Спека 11.1: обновление не чаще раза в 2 с — кроме `refresh()`. */
const THROTTLE_MS = 2000;

type Mode = 'none' | 'pending' | 'worktree' | 'project';

/** Загрузка diff/mergeCheck или changes.project по сессии, всегда с patch: false; обновление по правилам 11.1, не чаще раза в 2 с. */
export function useChanges(input: {
  bridge: HarnasBridge;
  entry: WorkEntry;
  sessionId: string | null;
  /** false — без mergeCheck: вкладке диффа (8.3) нужны файлы и сигналы обновления, а не проверка. По умолчанию true. */
  mergeCheck?: boolean;
}): { source: ChangesSource | null; loading: boolean; error: string | null; refresh(): void } {
  const { bridge, entry, sessionId } = input;
  const withCheck = input.mergeCheck ?? true;
  const projectPath = entry.projectPath;
  const workId = entry.map.work.id;
  const session = sessionId === null ? undefined : entry.map.sessions.find((candidate) => candidate.id === sessionId);
  const worktree = session?.worktree ?? null;
  const mode: Mode =
    session === undefined ? 'none' : worktree === null ? 'project' : worktree.createdAt === null ? 'pending' : 'worktree';
  const branch = worktree?.branch ?? '';
  const base = worktree?.base ?? '';

  const [source, setSource] = useState<ChangesSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Карта на момент подписки — точка отсчёта «карта изменилась»; сам эффект от неё не зависит,
  // иначе каждое событие работы перезапускало бы загрузку мимо дросселя.
  const mapRef = useRef(entry.map);
  mapRef.current = entry.map;
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    setError(null);
    if (mode === 'none' || sessionId === null) {
      setSource(null);
      setLoading(false);
      refreshRef.current = () => {};
      return undefined;
    }
    if (mode === 'pending') {
      // Worktree ещё не на диске: хосту нечего отвечать. Появится — сменится mode и эффект.
      setSource({ kind: 'pending' });
      setLoading(false);
      refreshRef.current = () => {};
      return undefined;
    }

    const ref: SessionRef = { projectPath, workId, sessionId };
    const key = refKey(ref);
    let disposed = false;
    let seq = 0;
    let lastAt = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setSource(null);

    const fetchSource = async (): Promise<ChangesSource> => {
      if (mode === 'project') {
        return { kind: 'project', changes: await bridge.call('changes.project', { ref, patch: false }) };
      }
      const diff = await bridge.call('worktrees.diff', { ref, patch: false });
      let check: MergeCheck | null = null;
      if (withCheck && diff.commits.length > 0) {
        try {
          check = await bridge.call('worktrees.mergeCheck', { ref });
        } catch (err) {
          // Фоновая проверка тело вкладки не ломает: без неё кнопка — «Слить», как при unsupported.
          console.warn('[harnas] worktrees.mergeCheck', decodeIpcError(err));
        }
      }
      return { kind: 'worktree', branch, base, diff, check };
    };

    const run = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      lastAt = Date.now();
      seq += 1;
      const mine = seq;
      setLoading(true);
      // Ответ прежнего запроса (другой сессии или устаревший) отбрасывается: победил свежий.
      const current = (): boolean => !disposed && mine === seq;
      fetchSource().then(
        (next) => {
          if (!current()) return;
          // Каждая загрузка — новый объект: по нему вкладка диффа перечитывает стороны (8.3).
          setSource(next);
          setError(null);
          setLoading(false);
        },
        (err: unknown) => {
          if (!current()) return;
          const info = decodeIpcError(err);
          if (info.data?.['reason'] === HOST_ERROR_REASONS.worktreeMissing) {
            // Папки worktree нет (отброшен не из этого окна или до перезапуска): признак в сторе —
            // вкладки показывают своё состояние и снимают загрузку, повторов нет (раунд 8, пункт 1).
            console.warn('[harnas] changes', info.code, info.message);
            useReviewStore.getState().markDiscarded(key);
            setLoading(false);
            return;
          }
          setError(changesErrorText(info));
          setLoading(false);
        },
      );
    };

    const request = (): void => {
      if (timer !== null) return;
      const wait = lastAt + THROTTLE_MS - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    };

    // Событие несёт весь снимок, объекты у каждого события новые, а карты малы: сравнение
    // строкой. Изменение другой работы вкладку не будит (решение сверки M16).
    let lastMap = JSON.stringify(mapRef.current);
    const offWorks = bridge.on('works.changed', (snapshot) => {
      const mine = snapshot.entries.find((e) => e.projectPath === projectPath && e.map.work.id === workId);
      if (mine === undefined) return;
      const json = JSON.stringify(mine.map);
      if (json === lastMap) return;
      lastMap = json;
      request();
    });

    const offActivity = useActivityStore.subscribe((state, prev) => {
      if (prev.byRef[key]?.activity.activity === 'working' && state.byRef[key]?.activity.activity !== 'working') request();
    });

    // Связь вернулась — заново (fix-7.3): оболочка при обрыве не перемонтируется.
    const offHost = useHostStore.subscribe((state, prev) => {
      if (state.connections !== prev.connections) request();
    });

    refreshRef.current = run;
    run();

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      offWorks();
      offActivity();
      offHost();
      refreshRef.current = () => {};
    };
  }, [bridge, projectPath, workId, sessionId, mode, branch, base, withCheck]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { source, loading, error, refresh };
}
