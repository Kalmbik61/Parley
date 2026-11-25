import { randomUUID } from 'node:crypto';
import { stripEscapes, type LaunchPlan } from '@parley/core';
import { refKey, type KimiRequest, type KimiResponse, type KimiState, type SendResult, type SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { PtyProcess } from '../pty/pty-process.js';
import { sanitizeForSend } from '../pty/send.js';
import { kimiHome, kimiTerminalEnv } from '../providers/kimi-env.js';
import { createKimiAcp, KimiAcpError } from './acp.js';

export type KimiOutput =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string; messageId: string }
  | { kind: 'end'; reason: string; error?: string };

export interface KimiReplayChunk {
  author: 'agent' | 'user';
  text: string;
  messageId?: string;
}

export interface KimiHistoryProjection {
  check(): void;
  writeCheckpoint(archive: string): Promise<void>;
  publish(): void;
}

interface KimiSessionHooks {
  output(ref: SessionRef, event: KimiOutput): void;
  hasHistory(ref: SessionRef): boolean;
  prepareHistory?(ref: SessionRef, archive: string, chunks: readonly KimiReplayChunk[], preferLive: boolean): Promise<KimiHistoryProjection>;
  checkBinding?(ref: SessionRef, home: string, id: string): void;
  activity(ref: SessionRef, state: 'ready' | 'working' | 'blocked' | 'ended', detail?: string): void;
  requestsChanged?(ref: SessionRef, requests: KimiState['requests']): void;
  canShowElicitation?(request: Extract<KimiRequest, { kind: 'elicitation' }>): boolean;
  authChanged?(signedIn: boolean): void;
}

interface KimiLaunch extends NonNullable<LaunchPlan['kimiAcp']> {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  reconcileAt?: { archive: string; cwd: string; home: string; kind: 'handoff' | 'checkpoint' };
}

function hostError(error: unknown): never {
  if (!(error instanceof KimiAcpError)) throw error;
  const code = error.code === 'busy' ? 'conflict' : error.code === 'disconnected' ? 'not_found' : 'bad_request';
  throw new HostError(code, error.message, { reason: `kimi-${error.code}` });
}

export function createKimiSessions(host: HostContext, hooks: KimiSessionHooks) {
  interface Live {
    acp: ReturnType<typeof createKimiAcp>;
    ready: boolean;
    frozen: boolean;
    launch: KimiLaunch;
    home: string;
    id?: string;
    draft: string[];
    draftBytes: number;
  }

  const live = new Map<string, Live>();
  const emptyState = (): KimiState => ({ requests: [], config: [] });

  function checkBinding(ref: SessionRef, home: string, id: string): void {
    for (const [key, candidate] of live) {
      if (key !== refKey(ref) && candidate.home === home && candidate.id === id) {
        throw new HostError('conflict', 'Another Parley session owns this Kimi conversation');
      }
    }
    hooks.checkBinding?.(ref, home, id);
  }

  function requireSession(ref: SessionRef): Live {
    const session = live.get(refKey(ref));
    if (session?.frozen) throw new HostError('conflict', 'Kimi Chat is switching ownership');
    if (!session?.ready || !session.acp.connected()) throw new HostError('not_found', 'Kimi Code session is not running');
    return session;
  }

  function submit(ref: SessionRef, session: Live, text: string): void {
    void session.acp.prompt(text).catch((error: unknown) => {
      // The turn's hook has already sent the error to Chat. Keep the host log free of prompt contents.
      if (error instanceof KimiAcpError && error.code === 'sign-in') hooks.authChanged?.(false);
      host.log.warn('Kimi Code turn did not complete', { ref, reason: error instanceof KimiAcpError ? error.code : 'unknown' });
    });
  }

  async function start(ref: SessionRef, launch: KimiLaunch): Promise<{
    process: PtyProcess;
    sessionId: string;
    activate(): void;
    prepareActivation(): { publish(): void; writeCheckpoint?: KimiHistoryProjection['writeCheckpoint'] };
  }> {
    const key = refKey(ref);
    const home = await kimiHome(launch.env, launch.cwd);
    const strictReplay = launch.reconcileAt !== undefined;
    if (strictReplay && (home !== launch.reconcileAt?.home || launch.cwd !== launch.reconcileAt.cwd)) {
      throw new HostError('conflict', 'The original Kimi home or working directory no longer matches');
    }
    if (launch.sessionId !== undefined) checkBinding(ref, home, launch.sessionId);
    if (live.has(key)) throw new HostError('conflict', 'Kimi Code session is already running');
    const initialOutput: KimiOutput[] = [];
    const historyChunks: KimiReplayChunk[] = [];
    let initialChars = 0;
    let overflow = false;
    let replayPrompt: string | undefined;
    let replayed = false;
    let turnId: string = randomUUID();
    let published = emptyState();
    const dataListeners = new Set<(data: string) => void>();

    function reserveHistory(chars: number, length: number): boolean {
      if (overflow || initialChars + chars > 2 * 1024 * 1024 || length >= 4096) {
        overflow = true;
        return false;
      }
      initialChars += chars;
      return true;
    }

    function output(event: KimiOutput): void {
      if (live.get(key) !== session || session.frozen) return;
      if (session.ready) hooks.output(ref, event);
      else {
        const chars = event.kind === 'end' ? 0 : event.text.length;
        if (reserveHistory(chars, initialOutput.length)) initialOutput.push(event);
      }
    }

    function flushReplayPrompt(): void {
      if (replayPrompt === undefined) return;
      output({ kind: 'prompt', text: replayPrompt });
      replayPrompt = undefined;
    }

    function publishState(state: KimiState): void {
      if (live.get(key) !== session || session.frozen) return;
      if (JSON.stringify(published.requests) !== JSON.stringify(state.requests)) {
        host.broadcast('kimi.requests', { ref, requests: state.requests });
        hooks.requestsChanged?.(ref, state.requests);
        if (session.ready && session.acp.busy()) {
          const request = state.requests[0];
          hooks.activity(ref, request === undefined ? 'working' : 'blocked', request?.kind === 'permission' ? request.title : request?.message);
        }
      }
      if (JSON.stringify(published.config) !== JSON.stringify(state.config)) host.broadcast('kimi.configChanged', { ref, config: state.config });
      published = state;
    }

    const acp = createKimiAcp({
      ...launch,
      clientVersion: host.version,
      elicitationForm: hooks.requestsChanged !== undefined,
      ...(hooks.canShowElicitation === undefined ? {} : { canShowElicitation: hooks.canShowElicitation }),
      loadHistory: launch.sessionId !== undefined && (strictReplay || !hooks.hasHistory(ref)),
      requireHistory: strictReplay,
      onState: (state) => { if (session.ready) publishState(state); },
      onText(text, history, author, messageId) {
        if (live.get(key) !== session || session.frozen || (history && overflow)) return;
        if (history && strictReplay) {
          if (reserveHistory(text.length + (messageId?.length ?? 0), historyChunks.length)) {
            historyChunks.push({ author, text, ...(messageId === undefined ? {} : { messageId }) });
          }
          return;
        }
        if (history && author === 'user') {
          if (replayPrompt === undefined) {
            if (replayed) output({ kind: 'end', reason: 'end_turn' });
            turnId = randomUUID();
          }
          if ((replayPrompt?.length ?? 0) + text.length > 64 * 1024) {
            overflow = true;
            return;
          }
          replayPrompt = (replayPrompt ?? '') + text;
          replayed = true;
          return;
        }
        flushReplayPrompt();
        replayed ||= history;
        output({ kind: 'text', messageId: turnId, text });
        if (session.ready) {
          const displayed = stripEscapes(text).replaceAll('\r', '').replaceAll('\n', '\r\n');
          for (const listener of dataListeners) listener(displayed);
        }
      },
      onTurnStart(text) {
        if (live.get(key) !== session || session.frozen) return;
        turnId = randomUUID();
        output({ kind: 'prompt', text });
        hooks.activity(ref, 'working');
      },
      onTurnEnd(reason, error) {
        if (live.get(key) !== session || !session.ready || session.frozen) return;
        output({ kind: 'end', reason, ...(error === undefined ? {} : { error: error.message }) });
        hooks.activity(ref, 'ended');
      },
    });
    const session: Live = { acp, ready: false, frozen: false, draft: [], draftBytes: 0, home, launch,
      ...(launch.sessionId === undefined ? {} : { id: launch.sessionId }) };
    live.set(key, session);
    acp.onExit(() => {
      if (live.get(key) === session) live.delete(key);
      dataListeners.clear();
    });

    try {
      const sessionId = await acp.connect();
      checkBinding(ref, home, sessionId);
      session.id = sessionId;
      // 2.7.3 exposes model aliases and thinking levels as select config options.
      // Read options again after switching model: the supported levels may change.
      for (const [configId, value] of [['model', launch.model], ['thinking', launch.effort]] as const) {
        if (value === undefined) continue;
        await acp.setConfig(configId, value);
        if (acp.state().config.find((option) => option.id === configId)?.currentValue !== value) {
          throw new KimiAcpError(`Kimi Code did not apply the selected ${configId}`, 'invalid');
        }
      }
      // Match session/new, not the Parley launch verb. In Kimi 2.7.3 this leaves Plan even if the
      // opening ACP snapshot already says "default", so an explicit Always Ask must still send the RPC.
      if (launch.sessionId === undefined && launch.kimiPermissionMode !== undefined) {
        await acp.setConfig('mode', launch.kimiPermissionMode === 'manual' ? 'default' : launch.kimiPermissionMode);
      }
      const pid = acp.pid;
      if (pid === undefined || live.get(key) !== session || !acp.connected()) throw new KimiAcpError('Kimi Code ACP disconnected', 'disconnected');
      hooks.authChanged?.(true);
      flushReplayPrompt();
      if (replayed) output({ kind: 'end', reason: 'end_turn' });
      if (strictReplay && overflow) throw new KimiAcpError('Kimi history exceeds the handback replay limit. Chat remains unchanged.', 'protocol');
      if (overflow) {
        // Keep only closed turns in an ordinary bounded replay. A dangling prompt would make Chat
        // look busy and keep its outbox closed even though this ACP owner is idle.
        initialOutput.length = initialOutput.findLastIndex(({ kind }) => kind === 'end') + 1;
        host.log.warn('Kimi Code cold history reached its display limit', { ref });
      }
      const restoreHistory = launch.reconcileAt === undefined ? undefined
        : await hooks.prepareHistory?.(ref, launch.reconcileAt.archive, historyChunks, launch.reconcileAt.kind === 'checkpoint');
      const isCurrent = () => live.get(key) === session && acp.connected();
      if (!isCurrent()) throw new KimiAcpError('Kimi Code ACP disconnected', 'disconnected');
      function prepareActivation(): { publish(): void; writeCheckpoint?: KimiHistoryProjection['writeCheckpoint'] } {
        if (!isCurrent()) throw new HostError('not_found', 'Kimi Code session is not running');
        restoreHistory?.check();
        return {
          ...(restoreHistory === undefined ? {} : { writeCheckpoint: (archive: string) => restoreHistory.writeCheckpoint(archive) }),
          publish() {
            restoreHistory?.publish();
            // A child may exit just after durable release. The validated history is still usable,
            // but this process must not publish readiness or accept prompts after exit.
            if (!isCurrent()) return;
            if (!strictReplay) for (const event of initialOutput) hooks.output(ref, event);
            session.ready = true;
            initialOutput.length = 0;
            publishState(acp.state());
            hooks.activity(ref, 'ready');
            if (launch.reconcileAt?.kind !== 'handoff' && launch.prompt !== undefined) submit(ref, session, launch.prompt);
          },
        };
      }
      return {
        sessionId,
        process: {
          pid,
          write(data) {
            if (!session.ready || session.frozen || live.get(key) !== session) return;
            if (data === '\x1b' || data === '\x03') {
              if (data === '\x03') {
                session.draft = [];
                session.draftBytes = 0;
              }
              acp.cancel();
              return;
            }
            if (data === '\x15') {
              session.draft = [];
              session.draftBytes = 0;
              return;
            }
            if (data !== '\r') {
              if (acp.busy()) return;
              session.draftBytes += Buffer.byteLength(data);
              if (session.draftBytes <= 64 * 1024) session.draft.push(data);
              return;
            }
            const draft = session.draft.join('');
            const withinLimit = session.draftBytes <= 64 * 1024;
            session.draft = [];
            session.draftBytes = 0;
            if (withinLimit && draft.trim() !== '' && !acp.busy()) submit(ref, session, sanitizeForSend(draft));
          },
          resize() {},
          kill(signal) {
            if (signal === 'SIGKILL') acp.kill(signal);
            else void acp.close();
          },
          onExit: acp.onExit,
          onData(listener) {
            dataListeners.add(listener);
            return () => dataListeners.delete(listener);
          },
        },
        activate: () => prepareActivation().publish(),
        prepareActivation,
      };
    } catch (error) {
      if (error instanceof KimiAcpError && error.code === 'sign-in') hooks.authChanged?.(false);
      await acp.close();
      hostError(error);
    }
  }

  return {
    start,
    takeover(ref: SessionRef, id: string) {
      const session = requireSession(ref);
      if (session.id !== id) throw new HostError('conflict', 'The running ACP session is not the bound Kimi conversation');
      if (!session.acp.supportsHistoryLoad()) {
        throw new HostError('conflict', 'This Kimi Code CLI cannot reload Chat history. Chat remains in control.', { reason: 'kimi-replay-unavailable' });
      }
      if (session.draftBytes > 0) throw new HostError('conflict', 'Send or clear the Terminal draft first.', { reason: 'kimi-draft' });
      if (session.acp.busy() || session.acp.state().requests.length > 0) {
        throw new HostError('conflict', 'Wait for Kimi to finish its turn or answer its request first.', { reason: 'kimi-busy' });
      }
      checkBinding(ref, session.home, id);
      session.frozen = true;
      return {
        command: session.launch.command,
        cwd: session.launch.cwd,
        home: session.home,
        // Take only user settings from the host, not the ACP launch's Parley layer.
        env: { ...kimiTerminalEnv(process.env),
          ...(session.launch.env.HOME === undefined ? {} : { HOME: session.launch.env.HOME }),
          KIMI_CODE_HOME: session.home },
        unfreeze: () => { if (live.get(refKey(ref)) === session) session.frozen = false; },
      };
    },
    state: (ref: SessionRef): KimiState => {
      const session = live.get(refKey(ref));
      return session?.ready ? session.acp.state() : emptyState();
    },
    send(ref: SessionRef, text: string, sendNow: boolean): SendResult {
      const session = requireSession(ref);
      const clean = sanitizeForSend(text);
      if (session.acp.busy()) return { inserted: false, submitted: false, reason: session.acp.state().requests.length === 0 ? 'busy' : 'blocked' };
      if (!sendNow) return { inserted: false, submitted: false, reason: 'blocked' };
      // ACP sends a separate prompt; it neither submits nor replaces the terminal draft.
      submit(ref, session, clean);
      return { inserted: true, submitted: true, reason: null };
    },
    respond(ref: SessionRef, requestId: string, response: KimiResponse): void {
      try {
        requireSession(ref).acp.respond(requestId, response);
      } catch (error) {
        hostError(error);
      }
    },
    async setConfig(ref: SessionRef, configId: string, value: string | boolean) {
      try {
        return await requireSession(ref).acp.setConfig(configId, value);
      } catch (error) {
        hostError(error);
      }
    },
    stopAll: () => Promise.all([...live.values()].map((session) => session.acp.close())),
  };
}

export type KimiSessions = ReturnType<typeof createKimiSessions>;
