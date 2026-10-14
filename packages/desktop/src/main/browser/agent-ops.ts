/**
 * Операции агента над браузером окна в main (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1–5.2, 7; этап B2:
 * `open`). Событие хоста `browser.agentOp` приходит сюда (`host-connection.ts#answerBrowserAgentOps`), ответ уходит
 * методом `browser.agentResult`.
 *
 * Агент называет только адрес: работу вкладки задаёт хост по токену сессии (`ref` события), а не аргументы. Адрес должен
 * быть http(s) на loopback (`shared/loopback.ts`) и до окна доходит без учётных данных. Раскладка — дело окна:
 * место вкладки, предел 10, повтор уже открытой страницы и тост решает рендерер (`renderer/browser/agent-open.ts`), main
 * просит его событием `browser:agent-open-tab`, ждёт ответ не дольше `AGENT_LIMITS.openMs` и переводит его в ответ агенту.
 * Страницу main не трогает: ни гостя, ни CDP, ни ожидания загрузки (это этапы C и D).
 *
 * Вкладку агент называет коротким id (`t1`, `t2`…): у каждой работы свой счёт, id держится, пока жив main. Этапы C и D
 * опираются на те же id.
 */
import { randomUUID } from 'node:crypto';
import { AGENT_LIMITS, browserAgentArgs } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentErrorCode, BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentResult } from '@parley/protocol';
import type { AgentOpenTab, AgentOpenTabResult } from '../../shared/browser-types.js';
import { isLoopbackUrl } from '../../shared/loopback.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';

export interface AgentOpsDeps {
  /** «Let agents use the browser» (`UiFile.browser.agentsAllowed`): читается на каждую операцию. */
  agentsAllowed(): Promise<boolean>;
  /** Просит окно открыть вкладку (`browser:agent-open-tab`); `false` — окно не готово слушать. */
  openTab(e: AgentOpenTab): boolean;
  /** Сколько ждать ответа окна; по умолчанию `AGENT_LIMITS.openMs`. Тестам — меньше. */
  openMs?: number;
}

export interface AgentOps {
  run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>;
  /** Ответ окна на `browser:agent-open-tab` (канал `browser:agent-open-tab-result`); чужой и поздний id молча игнорируется. */
  openTabResult(requestId: string, result: AgentOpenTabResult): void;
}

/** Отказ операции с кодом протокола; текст читает агент. */
export class AgentOpError extends Error {
  readonly code: BrowserAgentErrorCode;

  constructor(code: BrowserAgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentOpError';
    this.code = code;
  }
}

/** Схема аргументов по имени операции: хост другой версии может прислать незнакомую. */
type ArgsSchema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const ARGS: Partial<Record<string, ArgsSchema>> = browserAgentArgs;

const ok = (result: unknown): BrowserAgentResult => ({ ok: true, result });
const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Пояснение агенту, когда работа вне LRU окна: вкладка в раскладке есть, гостя пока нет. */
export const NOT_MOUNTED_NOTE = "The workspace is not open in Parley's window, so the page loads when the human opens it.";

/** Адрес, который агент может открыть: http(s) на loopback, без учётных данных; иначе `null`. Фрагмент (#…) остаётся: им бывают маршруты SPA. */
export function loopbackHref(raw: string): string | null {
  if (!isLoopbackUrl(raw)) return null;
  const parsed = new URL(raw);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

export function createAgentOps(deps: AgentOpsDeps): AgentOps {
  const openMs = deps.openMs ?? AGENT_LIMITS.openMs;
  /** Ждущие ответа окна: id просьбы → продолжение. */
  const pendingOpens = new Map<string, (result: AgentOpenTabResult | 'no_window' | 'timeout') => void>();
  /** id агента по работе и вкладке; счёт — свой у каждой работы. */
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();

  function agentIdFor(workKey: string, tabId: string): string {
    const key = `${workKey}\n${tabId}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const next = (counters.get(workKey) ?? 0) + 1;
    counters.set(workKey, next);
    const id = `t${next}`;
    ids.set(key, id);
    return id;
  }

  function askWindow(event: AgentOpenTab): Promise<AgentOpenTabResult | 'no_window' | 'timeout'> {
    return new Promise((resolve) => {
      const done = (result: AgentOpenTabResult | 'no_window' | 'timeout'): void => {
        clearTimeout(timer);
        pendingOpens.delete(event.requestId);
        resolve(result);
      };
      const timer = setTimeout(() => done('timeout'), openMs);
      pendingOpens.set(event.requestId, done);
      let sent = false;
      try {
        sent = deps.openTab(event);
      } catch {
        // Окно закрыто посреди вызова — как будто его нет.
      }
      if (!sent) done('no_window');
    });
  }

  async function openOf(request: BrowserAgentOpEvent, args: BrowserAgentArgs<'open'>): Promise<BrowserAgentOpenResult> {
    const url = loopbackHref(args.url);
    if (url === null) {
      throw new AgentOpError('not_loopback', 'Only http(s) pages on localhost can be opened: pass an absolute URL such as http://localhost:5173/.');
    }
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const answer = await askWindow({ requestId: randomUUID(), workKey, url, sessionId: request.ref.sessionId, session: request.label });
    if (answer === 'no_window') throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    if (answer === 'timeout') throw new AgentOpError('timeout', `The window did not place the tab within ${Math.round(openMs / 1000)} s.`);
    if ('error' in answer) {
      throw answer.error === 'limit'
        ? new AgentOpError('bad_request', 'This workspace already has 10 browser tabs, the most Parley allows. Ask the human to close one.')
        : new AgentOpError('window_not_connected', "Parley's window does not know this workspace yet: try again in a moment.");
    }
    return { tab: agentIdFor(workKey, answer.tabId), url, reused: answer.reused, notes: answer.mounted ? [] : [NOT_MOUNTED_NOTE] };
  }

  return {
    async run(request) {
      const schema = ARGS[request.op];
      if (schema === undefined) {
        return failure('unsupported', `This window does not know the operation ${String(request.op)}: ask the human to restart Parley.`);
      }
      const parsed = schema.safeParse(request.args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? 'args' : issue.path.map(String).join('.');
        return failure('bad_request', `Invalid arguments for ${request.op}: ${where} — ${issue?.message ?? 'invalid'}.`);
      }
      if (!(await deps.agentsAllowed())) {
        return failure('access_denied', 'The human turned off agent access to the browser (Settings → Browser → Let agents use the browser).');
      }
      try {
        switch (request.op) {
          case 'open':
            return ok(await openOf(request, parsed.data as BrowserAgentArgs<'open'>));
        }
      } catch (error) {
        if (error instanceof AgentOpError) return failure(error.code, error.message);
        return failure('unsupported', error instanceof Error ? error.message : String(error));
      }
    },
    openTabResult(requestId, result) {
      pendingOpens.get(requestId)?.(result);
    },
  };
}
