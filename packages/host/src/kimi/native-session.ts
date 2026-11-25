import { setTimeout as delay } from 'node:timers/promises';
import type { FeedDecision, KimiPermissionMode } from '@parley/core';
import { refKey, type KimiRequest, type SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { Log } from '../log.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { typeAndSubmit } from '../pty/type-and-submit.js';
import { KIMI_ENTER_DELAY_MS } from '../pty/send.js';
import { kimiComposer, kimiModeMenu, kimiPermissionMenu, kimiQuestionMenu, kimiQuestionReview } from './native-screen.js';
import { createKimiWire, KIMI_SESSION_ID, projectKimiWire, record, type KimiWireEvent } from './native-wire.js';

export interface KimiNativeBinding {
  home: string;
  cwd: string;
  legacyArchive?: string;
  legacyProviderId?: string;
}

type Pending = Extract<KimiWireEvent, { kind: 'request' }> & {
  acted?: true;
  shown?: { generation: string; inputRevision: number; fingerprint: string };
};

type Live = {
  ref: SessionRef;
  binding: KimiNativeBinding;
  instructions: string;
  id: string | null;
  pty?: PtyHandle;
  listed: boolean;
  busy: boolean;
  fenced: boolean;
  pending: Map<string, Pending>;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  wire?: Awaited<ReturnType<typeof createKimiWire>>;
  permissionMode?: KimiPermissionMode;
  manualTask?: Promise<void>;
  manualConfirmed?: true;
  manualFailed?: true;
  wasReady?: boolean;
  publishedActivity?: string;
  publishedRequests?: string;
};

interface Options {
  pty: PtyManager;
  log: Pick<Log, 'warn'>;
  bind(ref: SessionRef, binding: KimiNativeBinding, id: string, pid: number): Promise<void>;
  event(ref: SessionRef, id: string, event: KimiWireEvent, historical?: boolean): void;
  reset(ref: SessionRef, sameId: boolean): void;
  requests(ref: SessionRef, requests: KimiRequest[], unresolved: boolean): void;
  activity(ref: SessionRef, state: 'ready' | 'working' | 'blocked' | 'ended'): void;
  readyChanged(ref: SessionRef): void;
  fence(ref: SessionRef): void;
}

const POLL_MS = 120;
const FALLBACK = { applied: false, state: 'pending' as const };
const SENT = { applied: true, state: 'pending' as const };
const STALE = { applied: false, state: 'stale' as const };

function questionValues(p: Pending): { question: string; labels: string[] } | undefined {
  const questions = p.request.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return;
  const question = record(questions[0]);
  if (typeof question?.question !== 'string' || question.question.length > 240 || (question.multiSelect !== undefined && question.multiSelect !== false) ||
      !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return;
  const labels = question.options.map(option => record(option)?.label);
  if (labels.some(label => typeof label !== 'string' || label.length === 0 || label.length > 120) || new Set(labels).size !== labels.length) return;
  return { question: question.question, labels: labels as string[] };
}

export function createKimiNativeSession(options: Options) {
  const { pty } = options;
  const liveByRef = new Map<string, Live>();
  const get = (ref: SessionRef) => liveByRef.get(refKey(ref));
  const matches = (live: Live) => get(live.ref) === live && live.pty?.pid === pty.get(live.ref)?.pid;
  const view = (live: Live) => pty.screenText(live.ref) ?? [];
  const kActivity = (live: Live, state: 'ready' | 'working' | 'blocked' | 'ended') => {
    if (live.publishedActivity === state) return;
    live.publishedActivity = state;
    options.activity(live.ref, state);
  };

  function publishRequests(live: Live): void {
    if (!matches(live) || live.pty?.generation === undefined) return;
    const screen = view(live);
    const rawRevision = pty.get(live.ref)?.inputRevision?.() ?? 0;
    const cards: KimiRequest[] = [];
    for (const pending of live.pending.values()) {
      if (pending.acted || pending.at < live.pty.startedAt) continue;
      const toolCallId = pending.request.toolCallId;
      if (typeof toolCallId !== 'string') continue;
      if (pending.interaction === 'approval' && typeof pending.request.action === 'string') {
        const menu = kimiPermissionMenu(screen, pending.request.action);
        if (menu === undefined) continue;
        pending.shown ??= { generation: live.pty.generation, inputRevision: rawRevision, fingerprint: menu.fingerprint };
        cards.push({ kind: 'permission', id: pending.id, toolCallId, title: pending.request.action, options: menu.options, content: [] });
      } else if (pending.interaction === 'question') {
        const data = questionValues(pending);
        if (data === undefined) continue;
        const menu = kimiQuestionMenu(screen, data.question, data.labels);
        if (menu === undefined) continue;
        pending.shown ??= { generation: live.pty.generation, inputRevision: rawRevision, fingerprint: menu.fingerprint };
        cards.push({ kind: 'elicitation', id: pending.id, toolCallId, message: data.question, requestedSchema: {
          type: 'object', required: ['answer'], properties: { answer: { type: 'string', title: data.question, enum: menu.labels } },
        } });
      }
    }
    const unresolved = live.pending.size > 0;
    const state = JSON.stringify([cards, unresolved]);
    if (live.publishedRequests !== state) {
      live.publishedRequests = state;
      options.requests(live.ref, cards, unresolved);
    }
    if (unresolved) kActivity(live, 'blocked');
  }

  function ready(ref: SessionRef, draft = false): boolean {
    const live = get(ref);
    if (live === undefined || !matches(live) || !live.listed || live.busy || live.fenced || live.pending.size !== 0 ||
        (live.permissionMode === 'manual' && live.manualConfirmed !== true)) return false;
    // Close the gap between Return and the provider repaint/first turn hook.
    if (Date.now() - (pty.get(ref)?.submittedAt?.() ?? 0) < 350) return false;
    const composer = kimiComposer(view(live));
    return composer !== undefined && (draft ? !composer.empty : composer.empty);
  }

  function bootstrapManual(live: Live): void {
    if (live.permissionMode !== 'manual' || live.manualConfirmed || live.manualTask || live.manualFailed || !live.listed || live.busy || live.fenced) return;
    const handle = pty.get(live.ref);
    if (handle?.bracketedPaste() !== true || handle.hasDraft() || kimiComposer(view(live))?.empty !== true) return;
    const rawRevision = handle.inputRevision?.();
    const valid = () => matches(live) && pty.get(live.ref)?.inputRevision?.() === rawRevision && !live.busy && live.pending.size === 0;
    async function wait<T>(read: () => T | undefined): Promise<T> {
      for (let i = 0; i < 80 && valid(); i++) {
        const value = read();
        if (value !== undefined) return value;
        await delay(25);
      }
      throw new Error('Native permission selector changed');
    }
    async function open() {
      const attempt = typeAndSubmit({ pty, enterDelayMs: KIMI_ENTER_DELAY_MS }, live.ref, '/permission', true, {
        wrap: 'paste', beforeEnter: () => valid() && kimiComposer(view(live))?.empty === false,
      });
      if (await attempt.done !== 'submitted') throw new Error('Native permission selector did not open');
      return wait(() => kimiModeMenu(view(live)));
    }
    live.manualTask = (async () => {
      const mode = await open();
      if (mode.current !== 0) {
        if (mode.selected !== 0) pty.write(live.ref, '\x1b[A'.repeat(mode.selected));
        await wait(() => kimiModeMenu(view(live))?.selected === 0 ? true : undefined);
        if (!valid()) throw new Error('Native permission selector changed');
        pty.write(live.ref, '\r');
        await wait(() => kimiComposer(view(live))?.empty === true ? true : undefined);
        const actual = await open();
        if (actual.current !== 0) throw new Error('Always Ask did not become current');
      }
      if (!valid()) throw new Error('Native permission selector changed');
      pty.write(live.ref, '\x1b');
      await wait(() => kimiComposer(view(live))?.empty === true ? true : undefined);
      live.manualConfirmed = true;
    })().catch(() => {
      live.manualFailed = true;
      options.log.warn('Kimi Always Ask mode could not be verified before the first prompt', { ref: live.ref });
    }).finally(() => { delete live.manualTask; });
  }

  function read(live: Live): Promise<void> {
    const task = live.queue.then(async () => {
      if (get(live.ref) !== live || live.wire === undefined || live.id === null || live.fenced) return;
      const result = await live.wire.read();
      if (get(live.ref) !== live) return;
      if (result.limitation !== undefined) options.event(live.ref, live.id, { kind: 'unsupported', at: Date.now() });
      for (const row of result.rows) {
        const event = projectKimiWire(row);
        if (event === undefined) continue;
        const current = live.pty !== undefined && event.at >= live.pty.startedAt;
        if (current && (event.kind === 'prompt' || event.kind === 'compact-start')) {
          live.busy = true;
          kActivity(live, 'working');
        }
        if (current && (event.kind === 'end' || event.kind === 'compact')) {
          live.busy = false;
          kActivity(live, 'ended');
        }
        if (event.kind === 'request' && current && live.pending.size < 32) live.pending.set(event.id, event);
        if (event.kind === 'resolved' && live.pending.delete(event.id) && current && live.pending.size === 0) kActivity(live, 'working');
        options.event(live.ref, live.id, event, !current);
      }
    });
    live.queue = task.catch(() => {
      options.log.warn('Kimi native wire could not be read', { ref: live.ref });
    });
    return live.queue;
  }

  function tick(live: Live): void {
    if (!matches(live)) return;
    void read(live).finally(() => {
      if (!matches(live)) return;
      live.timer = setTimeout(() => tick(live), POLL_MS);
      live.timer.unref();
      publishRequests(live);
      bootstrapManual(live);
      const isReady = ready(live.ref);
      if (isReady && live.publishedActivity === undefined) kActivity(live, 'ready');
      if (isReady && live.wasReady !== true) options.readyChanged(live.ref);
      live.wasReady = isReady;
    }).catch(() => { options.log.warn('Kimi native screen state could not be projected', { ref: live.ref }); });
  }

  function onHook(ref: SessionRef, body: Record<string, unknown>): boolean {
    const live = get(ref);
    if (!live || body.client_type !== 'kimi_code_cli' || body.cwd !== live.binding.cwd ||
        typeof body.session_id !== 'string' || !KIMI_SESSION_ID.test(body.session_id)) return false;
    const id = body.session_id;
    if (body.hook_event_name === 'SessionStart') {
      // Hold the guarded sender while source identity is changing.
      const old = live.id;
      live.busy = old !== null && old !== id;
      const task = live.queue.then(async () => {
        if (!matches(live) || live.pty === undefined) return;
        await options.bind(ref, live.binding, id, live.pty.pid);
        if (!matches(live)) return;
        if (live.id !== id) {
          if (live.id !== null) options.reset(ref, false);
          live.pending.clear();
          live.id = id;
          live.wire = await createKimiWire({ ...live.binding, sessionId: id });
        }
        live.busy = false;
      });
      live.queue = task.catch(() => {
        live.fenced = true;
        options.fence(ref);
        options.log.warn('Kimi native provider binding could not be verified', { ref });
      });
    } else if (id === live.id && body.hook_event_name === 'UserPromptSubmit') {
      live.busy = true;
      kActivity(live, 'working');
    } else if (id === live.id && (body.hook_event_name === 'StopFailure' || body.hook_event_name === 'Interrupt')) {
      live.busy = false;
      kActivity(live, 'ended');
    }
    return true;
  }

  async function decide(ref: SessionRef, id: string, decision: FeedDecision) {
    const live = get(ref);
    const pending = live?.pending.get(id);
    if (!live || !pending || !matches(live) || live.fenced) return STALE;
    const shown = pending.shown;
    if (shown === undefined || pending.acted) return FALLBACK;
    const stable = () => {
      const handle = pty.get(ref);
      return matches(live) && live.pending.get(id) === pending && handle?.generation === shown.generation &&
        (handle.inputRevision?.() ?? 0) === shown.inputRevision;
    };
    if (!stable()) return STALE;
    if (pending.interaction === 'approval' && decision.kind === 'permission' && typeof pending.request.action === 'string') {
      const menu = kimiPermissionMenu(view(live), pending.request.action);
      const choice = menu?.options.find(option => option.optionId === decision.optionId);
      if (choice === undefined || menu!.fingerprint !== shown.fingerprint ||
          choice.kind.startsWith('allow_') !== (decision.behavior === 'allow')) return FALLBACK;
      pending.acted = true;
      pty.write(ref, choice.optionId);
      // Feedback opens a second native composer. Leave it in Terminal unless its exact shape is supported.
      return choice.kind === 'reject_always' ? FALLBACK : SENT;
    }
    if (pending.interaction === 'question' && decision.kind === 'question') {
      const data = questionValues(pending);
      const choice = decision.values?.answer;
      if (data === undefined || typeof choice !== 'string') return FALLBACK;
      const menu = kimiQuestionMenu(view(live), data.question, data.labels);
      const key = menu?.keys[menu.labels.indexOf(choice)];
      if (!key || menu?.fingerprint !== shown.fingerprint) return FALLBACK;
      pending.acted = true;
      // The reviewed answer must be visible under the same wire request, generation and raw-input revision.
      pty.write(ref, key);
      if (choice === 'Other' && !data.labels.includes(choice)) return FALLBACK;
      for (let i = 0; i < 20; i++) {
        await delay(25);
        if (!stable()) return STALE;
        if (!kimiQuestionReview(view(live), data.question, choice)) continue;
        pty.write(ref, '\r');
        return SENT;
      }
    }
    return FALLBACK;
  }

  pty.on('start', (ref) => {
    const live = get(ref);
    const handle = pty.get(ref);
    if (live === undefined || handle?.kimiNative !== true) return;
    live.pty = handle;
    tick(live);
  });
  pty.on('draft', (ref) => {
    const live = get(ref);
    if (live !== undefined) live.wasReady = false;
  });
  pty.on('exit', (ref) => {
    const live = get(ref);
    if (live === undefined) return;
    if (live.timer !== undefined) clearTimeout(live.timer);
    void read(live).finally(() => {
      if (get(ref) !== live) return;
      options.requests(ref, [], false);
      liveByRef.delete(refKey(ref));
    });
  });

  return {
    async prepare(ref: SessionRef, binding: KimiNativeBinding, id: string | null, instructions: string, permissionMode?: KimiPermissionMode) {
      if (id !== null && !KIMI_SESSION_ID.test(id)) throw new HostError('conflict', 'The saved Kimi ID is not a stock native session ID.');
      const wire = id === null ? undefined : await createKimiWire({ ...binding, sessionId: id });
      const live: Live = { ref, binding, id, instructions, listed: false, busy: false, fenced: false,
        pending: new Map(), queue: Promise.resolve(), ...(wire === undefined ? {} : { wire }), ...(permissionMode === undefined ? {} : { permissionMode }) };
      liveByRef.set(refKey(ref), live);
    },
    abort(ref: SessionRef) {
      const live = get(ref);
      if (live?.timer !== undefined) clearTimeout(live.timer);
      liveByRef.delete(refKey(ref));
    },
    has(ref: SessionRef) { return get(ref) !== undefined; },
    instructions(ref: SessionRef) { return get(ref)?.instructions; },
    allowRaw(ref: SessionRef) {
      const live = get(ref);
      if (!live || live.permissionMode !== 'manual' || live.manualConfirmed) return true;
      return live.manualTask === undefined && view(live).some(line => /Trust this folder\?|(?:Sign in|Log in) to (?:Kimi|continue)/i.test(line));
    },
    listed(ref: SessionRef) { const live = get(ref); if (live) live.listed = true; },
    onHook,
    ready,
    decide,
  };
}

export type KimiNativeSessions = ReturnType<typeof createKimiNativeSession>;
