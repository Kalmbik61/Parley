import { randomUUID } from 'node:crypto';
import { stripEscapes, type LaunchPlan } from '@parley/core';
import { refKey, type KimiRequest, type KimiResponse, type KimiState, type SendResult, type SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { PtyProcess } from '../pty/pty-process.js';
import { sanitizeForSend } from '../pty/send.js';
import { createKimiAcp, KimiAcpError } from './acp.js';

export type KimiOutput =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string; messageId: string }
  | { kind: 'end'; reason: string; error?: string };

interface KimiSessionHooks {
  output(ref: SessionRef, event: KimiOutput): void;
  hasHistory(ref: SessionRef): boolean;
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
    draft: string[];
    draftBytes: number;
  }

  const live = new Map<string, Live>();
  const emptyState = (): KimiState => ({ requests: [], config: [] });

  function requireSession(ref: SessionRef): Live {
    const session = live.get(refKey(ref));
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

  async function start(ref: SessionRef, launch: KimiLaunch): Promise<{ process: PtyProcess; sessionId: string; activate(): void }> {
    const key = refKey(ref);
    if (live.has(key)) throw new HostError('conflict', 'Kimi Code session is already running');
    const initialOutput: KimiOutput[] = [];
    let initialChars = 0;
    let replayPrompt: string | undefined;
    let replayed = false;
    let turnId: string = randomUUID();
    let published = emptyState();
    const dataListeners = new Set<(data: string) => void>();

    function output(event: KimiOutput): void {
      if (session.ready) hooks.output(ref, event);
      else if (initialChars < 2 * 1024 * 1024 && initialOutput.length < 4096) {
        if (event.kind !== 'end') initialChars += event.text.length;
        initialOutput.push(event);
      }
    }

    function flushReplayPrompt(): void {
      if (replayPrompt === undefined) return;
      output({ kind: 'prompt', text: replayPrompt });
      replayPrompt = undefined;
    }

    function publishState(state: KimiState): void {
      if (live.get(key) !== session) return;
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
      loadHistory: launch.sessionId !== undefined && !hooks.hasHistory(ref),
      onState: (state) => { if (session.ready) publishState(state); },
      onText(text, history, author) {
        if (history && author === 'user') {
          if (replayPrompt === undefined) {
            if (replayed) output({ kind: 'end', reason: 'end_turn' });
            turnId = randomUUID();
          }
          replayPrompt = ((replayPrompt ?? '') + text).slice(0, 64 * 1024);
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
        turnId = randomUUID();
        output({ kind: 'prompt', text });
        hooks.activity(ref, 'working');
      },
      onTurnEnd(reason, error) {
        if (live.get(key) !== session || !session.ready) return;
        output({ kind: 'end', reason, ...(error === undefined ? {} : { error: error.message }) });
        hooks.activity(ref, 'ended');
      },
    });
    const session: Live = { acp, ready: false, draft: [], draftBytes: 0 };
    live.set(key, session);
    acp.onExit(() => {
      if (live.get(key) === session) live.delete(key);
      dataListeners.clear();
    });

    try {
      const sessionId = await acp.connect();
      // 2.7.3 exposes model aliases and thinking levels as select config options.
      // Read options again after switching model: the supported levels may change.
      for (const [configId, value] of [['model', launch.model], ['thinking', launch.effort]] as const) {
        if (value === undefined) continue;
        await acp.setConfig(configId, value);
        if (acp.state().config.find((option) => option.id === configId)?.currentValue !== value) {
          throw new KimiAcpError(`Kimi Code did not apply the selected ${configId}`, 'invalid');
        }
      }
      const pid = acp.pid;
      if (pid === undefined || live.get(key) !== session || !acp.connected()) throw new KimiAcpError('Kimi Code ACP disconnected', 'disconnected');
      hooks.authChanged?.(true);
      flushReplayPrompt();
      if (replayed) output({ kind: 'end', reason: 'end_turn' });
      return {
        sessionId,
        process: {
          pid,
          write(data) {
            if (!session.ready) return;
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
        activate() {
          if (live.get(key) !== session || !acp.connected()) throw new HostError('not_found', 'Kimi Code session is not running');
          session.ready = true;
          for (const event of initialOutput) hooks.output(ref, event);
          initialOutput.length = 0;
          publishState(acp.state());
          hooks.activity(ref, 'ready');
          if (launch.prompt !== undefined) submit(ref, session, launch.prompt);
        },
      };
    } catch (error) {
      if (error instanceof KimiAcpError && error.code === 'sign-in') hooks.authChanged?.(false);
      await acp.close();
      hostError(error);
    }
  }

  return {
    start,
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
