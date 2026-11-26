import { randomUUID } from 'node:crypto';
import { confirmStartupChoice, recogniseKimiFolderTrust, type FolderTrustMenu } from '../feed/folder-trust.js';
import { setTimeout as delay } from 'node:timers/promises';
import { captureKimiFollowUp, type FeedDecision, type KimiFollowUpMode, type KimiPermissionMode } from '@parley/core';
import { refKey, type KimiRequest, type SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { Log } from '../log.js';
import { PASTE_END, PASTE_START } from '../pty/codex-input.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { typeAndSubmit } from '../pty/type-and-submit.js';
import { KIMI_ENTER_DELAY_MS, type KimiSendTarget } from '../pty/send.js';
import { KIMI_STEER_KEY, kimiComposer, kimiSelectiveSteerKey, kimiLazyStartup, kimiScreenVersion, kimiModeMenu, kimiParleyCount, kimiPermissionMenu, kimiQuestionMenu, kimiQuestionReview, kimiStartedId, kimiStartupDialog } from './native-screen.js';
import { createKimiWire, KIMI_SESSION_ID, projectKimiWire, proveKimiEmptyStartup, record, type KimiWireEvent } from './native-wire.js';

export interface KimiNativeBinding {
  home: string;
  cwd: string;
  legacyArchive?: string;
  legacyProviderId?: string;
}

export type KimiBootstrapOwner = { nonce: string; pid: number; generation: string };
export const KIMI_BOOTSTRAP_INTERRUPTED = 'Kimi first-turn setup was interrupted after session creation could have started. Startup input stays blocked. The conversation and queued messages were kept. Stop this session and create a new Kimi session.';

type Bootstrap = {
  nonce: string;
  deadline?: number;
  task?: Promise<void>;
  rotating?: true;
  failed?: true;
  expects?: { previous: string | null };
  observedId?: string;
};

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
  toolNames?: readonly string[];
  busy: boolean;
  compacting?: boolean;
  endedByHookAt?: number;
  rebinding?: symbol;
  followUpAtLaunch?: () => KimiFollowUpMode | undefined;
  fenced: boolean;
  pending: Map<string, Pending>;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  wire?: Awaited<ReturnType<typeof createKimiWire>>;
  permissionMode?: KimiPermissionMode;
  manualTask?: Promise<void>;
  manualConfirmed?: true;
  manualFailed?: true;
  bootstrap?: Bootstrap;
  wasReady?: boolean;
  publishedActivity?: string;
  publishedRequests?: string;
  pastStartup?: true;
  trust?: { id: string; menu: FolderTrustMenu; revision: number; answering: boolean; answered?: true };
};

interface Options {
  pty: PtyManager;
  log: Pick<Log, 'warn'>;
  bind(ref: SessionRef, binding: KimiNativeBinding, id: string, pid: number, bootstrap?: { owner: KimiBootstrapOwner; previous: string | null }): Promise<void>;
  bootstrap(ref: SessionRef, binding: KimiNativeBinding, owner: KimiBootstrapOwner, id: string | null, action: 'arm' | 'verify' | 'complete'): Promise<void>;
  event(ref: SessionRef, id: string, event: KimiWireEvent, historical?: boolean): void;
  reset(ref: SessionRef, sameId: boolean): void;
  requests(ref: SessionRef, requests: KimiRequest[], unresolved: boolean): void;
  activity(ref: SessionRef, state: 'ready' | 'working' | 'blocked' | 'ended'): void;
  startupFailed(ref: SessionRef, generation: string, message?: string): void;
  readyChanged(ref: SessionRef): void;
  fence(ref: SessionRef): void;
}

const POLL_MS = 120;
const STARTUP_WAIT_MS = 15_000;
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

// Only host-authored proof errors are suitable for a Chat diagnostic.
class KimiStartupProofError extends Error {}

export function createKimiNativeSession(options: Options) {
  const { pty } = options;
  const liveByRef = new Map<string, Live>();
  const get = (ref: SessionRef) => liveByRef.get(refKey(ref));
  const matches = (live: Live) => {
    const handle = pty.get(live.ref);
    return get(live.ref) === live && handle !== undefined && handle.pid === live.pty?.pid && handle.generation === live.pty.generation;
  };
  const view = (live: Live) => pty.screenText(live.ref) ?? [];
  const kActivity = (live: Live, state: 'ready' | 'working' | 'blocked' | 'ended') => {
    if (live.publishedActivity === state) return;
    live.publishedActivity = state;
    options.activity(live.ref, state);
  };
  const beginWork = (live: Live) => {
    live.busy = true;
    if (live.pending.size === 0) kActivity(live, 'working');
  };
  const endWork = (live: Live) => {
    live.busy = false;
    live.pending.clear();
    kActivity(live, 'ended');
  };

  function trustMenu(live: Live, screen: readonly string[]) {
    if (live.pastStartup || live.fenced || live.busy || live.pending.size || live.bootstrap?.task || live.bootstrap?.failed ||
        live.manualTask || live.manualFailed) return;
    return recogniseKimiFolderTrust(screen, live.binding.cwd);
  }

  function publishRequests(live: Live): void {
    if (!matches(live) || live.pty?.generation === undefined) return;
    const screen = view(live);
    const rawRevision = pty.get(live.ref)?.inputRevision?.() ?? 0;
    const cards: KimiRequest[] = [];
    if (live.busy || live.pending.size || kimiComposer(screen)) live.pastStartup = true;
    const menu = trustMenu(live, screen);
    if (!menu) delete live.trust;
    else {
      const revision = pty.get(live.ref)?.rawInputRevision?.() ?? 0;
      if (live.trust?.menu.fingerprint !== menu.fingerprint || live.trust.revision !== revision) {
        live.trust = { id: 'folder-trust:' + randomUUID(), menu, revision, answering: false };
      }
      cards.push({ kind: 'elicitation', id: live.trust.id, message: menu.detail, requestedSchema: {
        type: 'object', required: ['answer'], properties: { answer: { type: 'string', title: menu.title, enum: menu.options } },
      } });
    }
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
    const unresolved = live.pending.size > 0 || menu !== undefined;
    const state = JSON.stringify([cards, unresolved]);
    if (live.publishedRequests !== state) {
      live.publishedRequests = state;
      options.requests(live.ref, cards, unresolved);
    }
    if (unresolved) kActivity(live, 'blocked');
  }

  function sendTarget(ref: SessionRef, draft: boolean, steer: boolean): KimiSendTarget | undefined {
    const live = get(ref);
    const handle = pty.get(ref);
    if (live === undefined || !matches(live) || !handle?.bracketedPaste() || !live.listed ||
        live.fenced || live.rebinding !== undefined || live.compacting || live.pending.size !== 0 ||
        live.bootstrap !== undefined || (live.permissionMode === 'manual' && live.manualConfirmed !== true)) return;
    // Close the gap between submit and the provider repaint/first turn hook.
    if (Date.now() - (handle.submittedAt?.() ?? 0) < 350) return;
    const screen = view(live);
    const hasEditor = (mode: Parameters<typeof kimiComposer>[1]) => kimiComposer(screen, mode)?.empty === !draft;
    if (!live.busy) return hasEditor('idle') ? { id: live.id, mode: 'idle' } : undefined;
    if (!steer || live.id === null) return;
    if (hasEditor('steer')) return { id: live.id, mode: 'steer', key: KIMI_STEER_KEY };
    if (!hasEditor('selective-steer')) return;
    const followUp = live.followUpAtLaunch?.();
    if (followUp !== undefined) return { id: live.id, mode: 'steer', key: kimiSelectiveSteerKey(followUp) };
  }

  function ready(ref: SessionRef, draft = false): boolean {
    return sendTarget(ref, draft, false) !== undefined;
  }

  function ownerOf(live: Live, boot: Bootstrap): KimiBootstrapOwner | undefined {
    const handle = live.pty;
    if (handle?.generation === undefined) return undefined;
    return { nonce: boot.nonce, pid: handle.pid, generation: handle.generation };
  }

  function failBootstrap(live: Live, why: string, proofFailure?: string): void {
    const boot = live.bootstrap;
    if (!boot || boot.failed) return;
    boot.failed = true;
    delete boot.expects;
    if (!matches(live)) return;
    kActivity(live, 'blocked');
    if (live.pty?.generation !== undefined) {
      const retry = live.permissionMode === 'manual'
        ? 'Kimi could not confirm its startup screen and Always Ask mode. Startup input is blocked. Stop and resume this session to retry.'
        : 'Kimi could not confirm its startup screen or permission mode. Startup input is blocked. Stop and resume this session to retry.';
      const recovery = boot.rotating ? KIMI_BOOTSTRAP_INTERRUPTED
        : proofFailure === undefined ? retry : 'Startup input is blocked. Stop and resume this session to retry.';
      options.startupFailed(live.ref, live.pty.generation, proofFailure === undefined ? recovery : `${proofFailure} ${recovery}`);
    }
    options.log.warn('Kimi first-turn bootstrap stopped', { ref: live.ref, reason: why });
  }

  function bootstrapFresh(live: Live): void {
    const boot = live.bootstrap;
    if (!boot || boot.failed || boot.task) return;
    const screen = view(live);
    if (kimiStartupDialog(screen) !== undefined) {
      boot.deadline = Date.now() + STARTUP_WAIT_MS;
      return;
    }
    const handle = pty.get(live.ref);
    const owner = ownerOf(live, boot);
    const version = kimiScreenVersion(screen);
    const label = version === undefined ? 'Kimi' : `Kimi ${version}`;
    if (!kimiLazyStartup(screen) || !handle || !owner || handle.bracketedPaste() !== true || handle.hasDraft() || kimiComposer(screen)?.empty !== true) {
      if (Date.now() >= (boot.deadline ??= Date.now() + STARTUP_WAIT_MS)) {
        failBootstrap(live, 'no verified lazy composer', `${label} did not show a supported empty startup editor with bracketed paste.`);
      }
      return;
    }

    const input = handle.rawInputRevision?.();
    const valid = () => input !== undefined && matches(live) && !boot.failed && live.bootstrap === boot && !live.fenced &&
      pty.get(live.ref)?.rawInputRevision?.() === input && live.pending.size === 0 && kimiStartupDialog(view(live)) === undefined;
    const requireCurrent = () => { if (!valid()) throw new KimiStartupProofError('The startup input or generation changed'); };
    async function wait<T>(probe: () => T | undefined | Promise<T | undefined>, reason: string): Promise<T> {
      const deadline = Date.now() + STARTUP_WAIT_MS;
      while (valid() && Date.now() < deadline) {
        const result = await probe();
        requireCurrent();
        if (result !== undefined) return result;
        await delay(40);
      }
      requireCurrent();
      throw new KimiStartupProofError(reason);
    }
    const composer = () => kimiComposer(view(live));
    const idle = () => wait(() => composer()?.empty === true ? true : undefined, 'The native editor did not become empty');
    async function command(text: '/permission' | '/new' | '/mcp', beforeEnter?: () => void | Promise<void>) {
      await idle();
      requireCurrent();
      if (pty.get(live.ref)?.bracketedPaste() !== true || pty.get(live.ref)?.hasDraft()) throw new KimiStartupProofError('The editor is not exclusively owned by startup');
      const pasted = () => composer()?.empty === false && view(live).some(line => /^│ >\s*(\/permission|\/new|\/mcp)\s*│$/.exec(line.trim())?.[1] === text);
      pty.write(live.ref, `${PASTE_START}${text}${PASTE_END}`);
      await delay(KIMI_ENTER_DELAY_MS);
      await wait(() => pasted() ? true : undefined, `The exact ${text} startup command was not painted`);
      await beforeEnter?.();
      requireCurrent();
      if (!pasted()) throw new KimiStartupProofError('The startup command was changed before Return');
      pty.write(live.ref, '\r');
    }
    const modeMenu = () => wait(() => kimiModeMenu(view(live)), 'Permission mode could not be confirmed');
    const newIdentity = (previous: string | null) => wait(() => {
      const id = live.id;
      return id !== null && id !== previous && boot.observedId === id && kimiStartedId(view(live)) === id ? id : undefined;
    }, 'The authenticated new provider identity did not match Terminal');
    async function wireReady(id: string) {
      const names = live.toolNames;
      if (!names) return undefined;
      const proof = await proveKimiEmptyStartup({ ...live.binding, sessionId: id }, names);
      if (proof === 'unsafe') throw new KimiStartupProofError('The full native wire did not prove an empty conversation and exact tool catalog');
      return proof === 'ready' && live.toolNames === names ? names : undefined;
    }

    boot.task = (async () => {
      if (live.id !== null || live.busy) throw new KimiStartupProofError('Startup did not own an unbound conversation');
      await command('/permission');
      let menu = await modeMenu();
      const intended = live.permissionMode === undefined ? menu.current : { manual: 0, yolo: 1, auto: 2 }[live.permissionMode];
      if (menu.current !== intended && live.permissionMode === 'manual') {
        if (menu.selected !== 0) pty.write(live.ref, '\x1b[A'.repeat(menu.selected));
        await wait(() => kimiModeMenu(view(live))?.selected === 0 ? true : undefined, 'Always Ask could not be selected');
        requireCurrent();
        pty.write(live.ref, '\r');
        await command('/permission');
        menu = await modeMenu();
      }
      if (menu.current !== intended) throw new KimiStartupProofError('The native initial permission mode does not match the requested mode');
      requireCurrent();
      pty.write(live.ref, '\x1b');
      await idle();
      if (!kimiLazyStartup(view(live))) throw new KimiStartupProofError('The native lazy identity disappeared');
      await command('/new', async () => {
        requireCurrent();
        await options.bootstrap(live.ref, live.binding, owner, null, 'arm');
        boot.rotating = true;
        requireCurrent();
        boot.expects = { previous: null };
      });
      const first = await newIdentity(null);
      await command('/mcp');
      const catalog = await wait(async () => {
        const names = await wireReady(first);
        return names && kimiParleyCount(view(live)) === names.length ? names : undefined;
      }, 'The complete Parley tool catalog could not be confirmed');
      await command('/new', async () => {
        await options.bootstrap(live.ref, live.binding, owner, first, 'verify');
        if (live.id !== first || await wireReady(first) !== catalog || kimiParleyCount(view(live)) !== catalog.length) {
          throw new KimiStartupProofError('The empty bootstrap identity or discovery changed before rotation');
        }
        requireCurrent();
        boot.expects = { previous: first };
      });
      const final = await newIdentity(first);
      await command('/permission');
      if ((await modeMenu()).current !== intended) throw new KimiStartupProofError('The final native permission mode changed');
      requireCurrent();
      pty.write(live.ref, '\x1b');
      await idle();
      await wait(() => wireReady(final), 'The final conversation did not confirm the full Parley tool catalog');
      requireCurrent();
      await options.bootstrap(live.ref, live.binding, owner, final, 'complete');
      requireCurrent();
      if (live.permissionMode === 'manual') live.manualConfirmed = true;
      delete live.bootstrap;
    })().catch((error: unknown) => failBootstrap(live, error instanceof Error ? error.message : 'unverified startup',
      error instanceof KimiStartupProofError ? `${label} startup failed. ${error.message}.` : undefined));
  }

  function bootstrapManual(live: Live): void {
    if (live.bootstrap || live.permissionMode !== 'manual' || live.manualConfirmed || live.manualTask || live.manualFailed || !live.listed || live.busy || live.fenced) return;
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
      if (!matches(live)) return;
      live.manualFailed = true;
      kActivity(live, 'blocked');
      if (live.pty?.generation !== undefined) options.startupFailed(live.ref, live.pty.generation);
      options.log.warn('Kimi Always Ask mode could not be verified before the first prompt', { ref: live.ref });
    }).finally(() => { delete live.manualTask; });
  }

  function read(live: Live): Promise<void> {
    const task = live.queue.then(async () => {
      if (get(live.ref) !== live || live.wire === undefined || live.id === null || live.fenced) return;
      const result = await live.wire.read();
      if (get(live.ref) !== live) return;
      const ownsProcess = matches(live);
      if (result.limitation !== undefined) options.event(live.ref, live.id, { kind: 'unsupported', at: Date.now() });
      for (const row of result.rows) {
        const event = projectKimiWire(row);
        if (event === undefined) continue;
        const current = live.pty !== undefined && event.at >= live.pty.startedAt;
        if (ownsProcess && current) {
          if (event.kind === 'compact' || event.kind === 'compact-cancel') live.compacting = false;
          // An authenticated interrupt can arrive before the reader drains the old step.
          if (event.at > (live.endedByHookAt ?? -Infinity)) {
            if (event.kind === 'compact-start') live.compacting = true;
            if (event.kind === 'working' || event.kind === 'prompt' || event.kind === 'compact-start') beginWork(live);
            if (event.kind === 'end' || event.kind === 'compact' || event.kind === 'compact-cancel') endWork(live);
            if (event.kind === 'request' && live.pending.size < 32) live.pending.set(event.id, event);
            if (event.kind === 'resolved' && live.pending.delete(event.id) && live.pending.size === 0) beginWork(live);
          }
        }
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
      bootstrapFresh(live);
      bootstrapManual(live);
      const isReady = ready(live.ref);
      if (isReady && (live.publishedActivity === undefined || live.publishedActivity === 'blocked')) kActivity(live, 'ready');
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
      const boot = live.bootstrap;
      let transition: { owner: KimiBootstrapOwner; previous: string | null } | undefined;
      if (boot !== undefined) {
        if (boot.failed || boot.observedId === id) return true;
        const owner = ownerOf(live, boot);
        if (!boot.expects || !owner || !matches(live) || boot.expects.previous !== live.id || id === live.id) {
          failBootstrap(live, 'unexpected native SessionStart');
          return true;
        }
        transition = { owner, previous: boot.expects.previous };
        boot.observedId = id;
        delete boot.expects;
      }
      // Hold the guarded sender while source identity is changing.
      const rebind = Symbol();
      live.rebinding = rebind;
      const task = live.queue.then(async () => {
        if (!matches(live) || live.pty === undefined || boot?.failed) return;
        await options.bind(ref, live.binding, id, live.pty.pid, transition);
        if (!matches(live)) return;
        if (live.id !== id) {
          live.compacting = false;
          delete live.endedByHookAt;
          if (live.id !== null) {
            if (live.busy || live.pending.size > 0) endWork(live);
            options.reset(ref, false);
          }
          live.pending.clear();
          live.id = id;
          live.wire = await createKimiWire({ ...live.binding, sessionId: id });
          live.busy = false;
        }
        if (live.rebinding === rebind) delete live.rebinding;
      });
      live.queue = task.catch(() => {
        if (boot) failBootstrap(live, 'authenticated bootstrap identity could not be bound');
        live.fenced = true;
        options.fence(ref);
        options.log.warn('Kimi native provider binding could not be verified', { ref });
      });
    } else if (live.bootstrap && body.hook_event_name === 'UserPromptSubmit') {
      failBootstrap(live, 'a human or model turn arrived before readiness');
    } else if (id === live.id && matches(live) && body.hook_event_name === 'UserPromptSubmit') {
      beginWork(live);
    } else if (id === live.id && matches(live) && (body.hook_event_name === 'StopFailure' || body.hook_event_name === 'Interrupt')) {
      live.endedByHookAt = Date.now();
      endWork(live);
    }
    return true;
  }

  async function decide(ref: SessionRef, id: string, decision: FeedDecision) {
    const live = get(ref);
    const trust = live?.trust;
    if (live && trust && id === trust.id) {
      if (decision.kind !== 'question' || trust.answering || trust.answered) return FALLBACK;
      const answer = decision.values?.answer ?? decision.answers[trust.menu.title];
      const target = trust.menu.options.findIndex(label => label === answer);
      const selected = () => {
        if (!matches(live) || live.trust !== trust || (pty.get(ref)?.rawInputRevision?.() ?? 0) !== trust.revision) return;
        const seen = trustMenu(live, view(live));
        return seen?.fingerprint === trust.menu.fingerprint ? seen.selected : undefined;
      };
      if (target < 0) return FALLBACK;
      trust.answering = true;
      try {
        const result = await confirmStartupChoice(target, trust.menu.options.length, selected, key => pty.write(ref, key));
        if (result === 'changed') return STALE;
        if (result === 'timeout') return FALLBACK;
        trust.answered = true;
        return { applied: true, state: 'answered' as const };
      } finally {
        trust.answering = false;
      }
    }
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
    async prepare(ref: SessionRef, binding: KimiNativeBinding, id: string | null, instructions: string, permissionMode?: KimiPermissionMode, bootstrapNonce?: string) {
      if (id !== null && !KIMI_SESSION_ID.test(id)) throw new HostError('conflict', 'The saved Kimi ID is not a stock native session ID.');
      const wire = id === null ? undefined : await createKimiWire({ ...binding, sessionId: id });
      const followUpAtLaunch = await captureKimiFollowUp(binding.home);
      const live: Live = { ref, binding, id, instructions, listed: false, busy: false, fenced: false,
        pending: new Map(), queue: Promise.resolve(), ...(wire === undefined ? {} : { wire }), ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(bootstrapNonce === undefined ? {} : { bootstrap: { nonce: bootstrapNonce } }),
        ...(followUpAtLaunch === undefined ? {} : { followUpAtLaunch }) };
      liveByRef.set(refKey(ref), live);
    },
    abort(ref: SessionRef) {
      const live = get(ref);
      if (live?.timer !== undefined) clearTimeout(live.timer);
      liveByRef.delete(refKey(ref));
    },
    has(ref: SessionRef) { return get(ref) !== undefined; },
    instructions(ref: SessionRef) { return get(ref)?.instructions; },
    interrupt(ref: SessionRef) {
      const live = get(ref);
      if (live?.bootstrap) failBootstrap(live, 'the session was stopped');
    },
    allowRaw(ref: SessionRef, data: string) {
      const live = get(ref);
      if (!live || (!live.bootstrap && (live.permissionMode !== 'manual' || live.manualConfirmed))) return true;
      if (live.bootstrap?.task || live.bootstrap?.failed || live.manualTask || live.manualFailed) return false;
      const dialog = kimiStartupDialog(view(live));
      if (dialog === 'trust') return ['\r', '\n', ' ', '\x1b[A', '\x1b[B', '\x1b', '\x03'].includes(data);
      return dialog === 'login' && (data === '\x03' || data === '\x1b');
    },
    listed(ref: SessionRef, names: readonly string[]) {
      const live = get(ref);
      if (!live) return;
      const sorted = [...names].sort();
      if (live.toolNames?.join('\0') !== sorted.join('\0')) live.toolNames = sorted;
      live.listed = true;
    },
    onHook,
    ready,
    sendTarget,
    decide,
  };
}

export type KimiNativeSessions = ReturnType<typeof createKimiNativeSession>;
