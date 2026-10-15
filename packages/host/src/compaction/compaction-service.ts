/**
 * Сжатие контекста по клику человека (спека 2026-10-15, 5): хост печатает агенту `/compact <фокус>`, когда тот
 * свободен, а до того держит просьбу (`pending`, одна на сессию). Сам хост сжатие не начинает. С печати и до конца
 * сжатия держит `sessions.exclusive` этой сессии — `pty.send`, будильник и смена модели/effort ему уступают;
 * ждущую просьбу будильник видит через `holds`. Конец сжатия — `PostCompact` (Claude, GLM), запись `compacted`
 * новее печати (Codex), выход процесса или таймаут.
 */

import { hookedSince } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { CompactResult, NoticeKind, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { CODEX_SUBMIT_DELAY_MS, KEY_ENTER } from '../pty/codex-input.js';
import { stripEscapes } from '../pty/draft.js';
import { choiceInProgress } from '../pty/effort-switch.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { typeAndSubmit } from '../pty/type-and-submit.js';
import type { SwitchLock } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { CompactionTrack } from './context-view.js';

/** Сколько ждать отчёта о конце сжатия (спека 5.5). */
export const COMPACT_TIMEOUT_MS = 5 * 60_000;
/** Предел инструкции после очистки (спека 5.3): `/compact ` + 350 знаков кириллицы ≤ 709 байт — ниже порога «вставки» Claude Code. */
export const MAX_INSTRUCTIONS = 350;

// Управляющие байты и DEL — в пробел: инструкция уходит одной строкой.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]+/g;

/** Строка команды: Codex — голый `/compact` (спека 2.7); фокус — одна строка до 350 знаков, пусто — без фокуса. */
export function compactCommand(provider: string | null, instructions: string | null): string {
  if (provider === 'codex' || instructions === null) return '/compact';
  const line = stripEscapes(instructions).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (line.length > MAX_INSTRUCTIONS) throw new HostError('bad_request', 'instructions are longer than 350 characters');
  return line === '' ? '/compact' : `/compact ${line}`;
}

export interface CompactionService {
  compact(ref: SessionRef, instructions: string | null): CompactResult;
  /** Снять ждущую просьбу; `false` — её нет или сжатие уже идёт. */
  cancel(ref: SessionRef): boolean;
  /** Просьба ждёт или сжатие идёт: будильник указатель этой сессии не печатает. */
  holds(ref: SessionRef): boolean;
  /** HTTP-хук сессии (тот же, что у ленты): `PostCompact` — конец сжатия. */
  onHook(ref: SessionRef, body: Record<string, unknown>): void;
  start(): void;
  stop(): void;
}

export interface CompactionDeps {
  host: Pick<HostContext, 'log' | 'broadcast'>;
  pty: PtyManager;
  activity: Pick<ActivityService, 'get' | 'onChange' | 'onLogChange' | 'setCompaction' | 'codexCompactedAt'>;
  exclusive: SwitchLock;
  wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;
  timeoutMs?: number;
}

interface Running {
  ref: SessionRef;
  codex: boolean;
  /** Когда ушёл Enter; до этого запись `compacted` Codex — не наша. */
  submittedAt: number | null;
  done(): void;
}

export function createCompactionService(deps: CompactionDeps): CompactionService {
  const timeoutMs = deps.timeoutMs ?? COMPACT_TIMEOUT_MS;
  const pending = new Map<string, { ref: SessionRef; text: string }>();
  const running = new Map<string, Running>();
  /** Конец последнего сжатия сессии (ISO): окно прячет прежнюю цифру до наблюдения новее. */
  const finished = new Map<string, string>();
  const unsubscribe: Array<() => void> = [];

  const publish = (ref: SessionRef, phase: CompactionTrack['phase']): void =>
    deps.activity.setCompaction(ref, { phase, finishedAt: finished.get(refKey(ref)) ?? null });

  function notice(kind: NoticeKind, ref: SessionRef, text: string): void {
    deps.host.log.info('сжатие: уведомление', { kind, ref });
    deps.host.broadcast('host.notice', { kind, ref, text, at: new Date().toISOString() });
  }

  /** Свободен, без диалога и ползунка, без смены модели, поле ввода пусто, указатель письма не в полёте. */
  function ready(ref: SessionRef, handle: PtyHandle): boolean {
    const state = deps.activity.get(ref)?.activity.activity;
    if (state !== 'idle' && state !== 'unseen') return false;
    if (choiceInProgress(ref, { pty: deps.pty, switching: (target) => deps.exclusive.held(target) })) return false;
    if (handle.hasDraft()) return false;
    return !deps.wake.inFlight(ref);
  }

  function finish(ref: SessionRef, at: string | null): void {
    const key = refKey(ref);
    if (at !== null) finished.set(key, at);
    const entry = running.get(key);
    if (entry !== undefined) entry.done();
    else publish(ref, pending.has(key) ? 'pending' : null);
  }

  function begin(ref: SessionRef, handle: PtyHandle, text: string): void {
    const key = refKey(ref);
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry: Running = { ref, codex: handle.provider === 'codex', submittedAt: null, done: () => release() };
    running.set(key, entry);
    publish(ref, 'running');

    const run = async (): Promise<void> => {
      const attempt = typeAndSubmit({ pty: deps.pty, enterDelayMs: deps.wake.enterDelayMs }, ref, text, true, {
        hostDraft: true,
        beforeEnter: () => deps.activity.get(ref)?.activity.activity !== 'blocked',
        ...(entry.codex ? { delayMs: CODEX_SUBMIT_DELAY_MS, submitKey: () => KEY_ENTER } : {}),
      });
      const outcome = await attempt.done;
      if (outcome !== 'submitted') {
        notice('compact-failed', ref, `compaction of ${ref.sessionId} was not sent (${outcome})`);
        return;
      }
      entry.submittedAt = Date.now();
      const timer = setTimeout(() => {
        notice('compact-failed', ref, `compaction of ${ref.sessionId} did not report back`);
        release();
      }, timeoutMs);
      try {
        await settled;
      } finally {
        clearTimeout(timer);
      }
    };

    let job: Promise<void>;
    try {
      job = deps.exclusive(ref, run);
    } catch (error) {
      job = Promise.reject(error);
    }
    void job
      .catch((error: unknown) => deps.host.log.warn('сжатие: сбой', { ref, error: String(error) }))
      .finally(() => {
        running.delete(key);
        publish(ref, pending.has(key) ? 'pending' : null);
      });
  }

  /** Ждущая просьба: процесса нет — снять с уведомлением; агент свободен — печатать. */
  function tryStart(ref: SessionRef): boolean {
    const key = refKey(ref);
    const request = pending.get(key);
    if (request === undefined || running.has(key)) return false;
    const handle = deps.pty.get(ref);
    if (handle === undefined) {
      pending.delete(key);
      publish(ref, null);
      notice('compact-cancelled', ref, `${ref.sessionId} stopped — compaction cancelled`);
      return false;
    }
    if (!ready(ref, handle)) return false;
    pending.delete(key);
    begin(ref, handle, request.text);
    return true;
  }

  return {
    compact(ref, instructions) {
      const handle = deps.pty.get(ref);
      if (handle === undefined) return { state: 'refused', reason: 'asleep' };
      const text = compactCommand(handle.provider, instructions);
      // Ни одного хука с запуска — что на экране, неизвестно (вопрос доверия к папке): как `pty.send`.
      if (!hookedSince(deps.activity.get(ref)?.activity, handle.startedAt)) return { state: 'refused', reason: 'unknown-screen' };
      const key = refKey(ref);
      if (running.has(key)) return { state: 'started' };
      pending.set(key, { ref, text });
      if (tryStart(ref)) return { state: 'started' };
      publish(ref, 'pending');
      return { state: 'pending' };
    },
    cancel(ref) {
      if (!pending.delete(refKey(ref))) return false;
      publish(ref, null);
      return true;
    },
    holds: (ref) => pending.has(refKey(ref)) || running.has(refKey(ref)),
    onHook(ref, body) {
      if (body['hook_event_name'] === 'PostCompact') finish(ref, new Date().toISOString());
    },
    start() {
      unsubscribe.push(
        deps.activity.onChange((ref) => {
          tryStart(ref);
        }),
        deps.pty.on('draft', (ref) => {
          tryStart(ref);
        }),
        deps.pty.on('host-draft', (ref) => {
          tryStart(ref);
        }),
        deps.pty.on('exit', (ref) => {
          const key = refKey(ref);
          if (pending.delete(key)) {
            publish(ref, null);
            notice('compact-cancelled', ref, `${ref.sessionId} stopped — compaction cancelled`);
          }
          running.get(key)?.done();
        }),
        deps.activity.onLogChange(() => {
          for (const entry of running.values()) {
            if (!entry.codex || entry.submittedAt === null) continue;
            const at = deps.activity.codexCompactedAt(entry.ref);
            if (at !== null && Date.parse(at) >= entry.submittedAt) finish(entry.ref, at);
          }
        }),
      );
    },
    stop() {
      for (const off of unsubscribe.splice(0)) off();
      for (const entry of running.values()) entry.done();
      pending.clear();
    },
  };
}
