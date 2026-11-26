import { MAX_OSC_LENGTH } from './codex-terminal.js';

export type TerminalStatus =
  | { state: 'idle' | 'working' | 'done' | 'error' }
  | { state: 'blocked'; kind?: 'auth' | 'permission' | 'question' };

/** Only PTY launch families with confirmed OSC 7501 reports in Parley. */
export function programStatusApp(provider: string | null): string | null {
  // Qwen Code 0.27.2: see the Qwen provider design amendment (2026-11-11).
  if (provider === 'qwen') return 'qwen-code';
  // OpenCode 2.3.0: local serve + --server/-s, without Herdr (parity capture 2026-11-27).
  return provider === 'opencode' ? 'opencode' : null;
}

export interface ProgramStatusReport {
  /** Display-only data. Null is an explicit clear, not an ignored report. */
  status: TerminalStatus | null;
  /** Private to the host decoder and legacy Qwen adapter. Never forward as terminal status. */
  fields: ReadonlyMap<string, string>;
}

const PREFIX = '7501;';
// OSC bodies must not contain control characters, even in fields we don't consume.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** Parses one root record for the registered app. Nested records are not retained or delivered. */
export function programStatusOf(body: string, app: string): ProgramStatusReport | null {
  // The reader bounds its pending tail. Also bound complete frames before splitting them.
  if (!body.startsWith(PREFIX) || body.length + 2 > MAX_OSC_LENGTH || CONTROL.test(body)) return null;

  const fields = new Map<string, string>();
  for (const pair of body.slice(PREFIX.length).split(':')) {
    const at = pair.indexOf('=');
    const key = pair.slice(0, at);
    if (at <= 0 || !/^[a-z][a-z0-9_-]*$/.test(key) || fields.has(key)) return null;
    fields.set(key, pair.slice(at + 1));
  }

  if ((fields.get('id') ?? '') !== '') return null;
  const state = fields.get('state');
  const sender = fields.get('app');
  if (sender !== app && !(state === 'clear' && sender === undefined)) return null;

  switch (state) {
    case 'clear':
      return { status: null, fields };
    case 'idle':
    case 'working':
    case 'done':
    case 'error':
      return { status: { state }, fields };
    case 'blocked': {
      const kind = fields.get('kind');
      return { status: kind === 'auth' || kind === 'permission' || kind === 'question' ? { state, kind } : { state }, fields };
    }
    default:
      return null;
  }
}
