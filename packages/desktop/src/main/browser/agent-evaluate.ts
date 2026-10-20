/**
 * Скрипты агента в главном мире страницы (`browser_evaluate`, решение владельца 2026-10-20).
 *
 * Единственный вход скриптов агента (`Inspector.sendAgentScript`); проверки доступа, паузы и `human_busy` — до вызова,
 * в `agent-ops.ts`. Срок держит свой главный таймер `evalMs`: по нему `Runtime.terminateExecution` и `timeout`
 * (`timeout` у `Runtime.evaluate` — только страховка, у `callFunctionOn` его нет). Зависший промис CDP не отпускает,
 * поэтому ждём не ответ, а гонку ответа, таймера и `signal` (Stop, пауза, выключатель).
 */
import type { WebContents } from 'electron';
import { AGENT_LIMITS, type BrowserAgentArgs, type BrowserAgentEvaluateResult } from '@parley/protocol';
import { AgentOpError } from './agent-errors.js';
import { urlForAgent } from './agent-url.js';

export interface AgentScriptSender {
  send<T = unknown>(id: number, method: string, params?: Record<string, unknown>): Promise<T>;
  sendAgentScript<T = unknown>(
    id: number,
    method: 'Runtime.evaluate' | 'Runtime.callFunctionOn',
    params: Record<string, unknown>,
  ): Promise<T>;
}

export interface AgentScripts {
  evaluateOf(
    contents: WebContents,
    agentId: string,
    args: BrowserAgentArgs<'evaluate'>,
    element: number | null,
    signal: AbortSignal,
  ): Promise<BrowserAgentEvaluateResult>;
}

interface CdpEvalResponse {
  result?: { type?: string; value?: unknown; description?: string; unserializableValue?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** Не длиннее `max` байт UTF-8, кодовая точка не рвётся. */
function clipBytes(text: string, max: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= max) return { text, truncated: false };
  let end = max;
  // Байт 10xxxxxx — продолжение точки: отступаем к её началу.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

export function createAgentScripts(deps: { inspector: AgentScriptSender; evalMs?: number }): AgentScripts {
  const { inspector } = deps;
  const evalMs = deps.evalMs ?? AGENT_LIMITS.evalMs;

  async function evaluateOf(
    contents: WebContents,
    _agentId: string,
    args: BrowserAgentArgs<'evaluate'>,
    element: number | null,
    signal: AbortSignal,
  ): Promise<BrowserAgentEvaluateResult> {
    const id = contents.id;
    let objectId: string | null = null;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const terminate = (): void => {
      void inspector.send(id, 'Runtime.terminateExecution', {}).catch(() => undefined);
    };

    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
        reject(new AgentOpError('timeout', 'The script ran longer than 10 s and was stopped.'));
      }, evalMs);
      onAbort = (): void => {
        terminate();
        const reason: unknown = signal.reason;
        reject(reason instanceof AgentOpError ? reason : new AgentOpError('timeout', 'The script was stopped.'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    // Гонка проигравшая — отказ guard не должен стать необработанным.
    guard.catch(() => undefined);

    const run = async (): Promise<CdpEvalResponse> => {
      if (element !== null && args.function !== undefined) {
        const resolved = await inspector.send<{ object?: { objectId?: string } }>(id, 'DOM.resolveNode', {
          backendNodeId: element,
        });
        objectId = resolved.object?.objectId ?? null;
        if (objectId === null) throw new AgentOpError('stale_ref', 'The element is gone; take a new snapshot.');
        return inspector.sendAgentScript<CdpEvalResponse>(id, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: args.function,
          arguments: [{ objectId }],
          returnByValue: true,
          awaitPromise: true,
          userGesture: false,
        });
      }
      const expression = args.expression ?? `(${args.function ?? 'undefined'})()`;
      return inspector.sendAgentScript<CdpEvalResponse>(id, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
        timeout: evalMs + 1000,
      });
    };

    try {
      const response = await Promise.race([run(), guard]);
      if (timedOut) throw new AgentOpError('timeout', 'The script ran longer than 10 s and was stopped.');
      const details = response.exceptionDetails;
      let outcome: 'value' | 'exception' = 'value';
      let type = response.result?.type ?? 'undefined';
      let text: string;
      if (details) {
        outcome = 'exception';
        type = 'exception';
        text = details.exception?.description ?? details.text ?? 'The script threw an exception.';
      } else if (type === 'undefined') {
        text = 'undefined';
      } else if (response.result && 'value' in response.result) {
        text = JSON.stringify(response.result.value) ?? 'undefined';
      } else {
        const what = response.result?.description ?? response.result?.unserializableValue ?? type;
        text = `The value could not be returned as JSON (${what}); return a plain value.`;
      }
      const clipped = clipBytes(text, AGENT_LIMITS.evalBytes);
      return {
        tab: args.tab,
        url: urlForAgent(contents.getURL()),
        outcome,
        text: clipped.text,
        type,
        truncated: clipped.truncated,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (objectId !== null) void inspector.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  return { evaluateOf };
}
