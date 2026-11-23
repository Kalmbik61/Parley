import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  kimiConfigOption, kimiElicitationSchema, kimiPermissionOption,
  type KimiConfigOption, type KimiPermissionContent, type KimiRequest, type KimiResponse, type KimiState,
} from '@parley/protocol';
import type { ExitInfo } from '../pty/pty-process.js';

export interface KimiMcpServer {
  type: 'stdio';
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export class KimiAcpError extends Error {
  constructor(message: string, readonly code: 'missing-cli' | 'sign-in' | 'disconnected' | 'protocol' | 'busy' | 'invalid', readonly rpcCode?: number) {
    super(message);
  }
}

interface KimiAcpOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpServers: KimiMcpServer[];
  sessionId?: string;
  clientVersion?: string;
  elicitationForm?: boolean;
  canShowElicitation?: (request: Extract<KimiRequest, { kind: 'elicitation' }>) => boolean;
  /** Replays previous messages when the host has no conversation to show. */
  loadHistory?: boolean;
  onText?: (text: string, history: boolean, author: 'agent' | 'user') => void;
  onState?: (state: KimiState) => void;
  onTurnStart?: (text: string) => void;
  onTurnEnd?: (reason: string, error?: KimiAcpError) => void;
}

type RpcId = string | number;
type JsonObject = Record<string, unknown>;
const record = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
const isId = (id: unknown): id is RpcId => typeof id === 'string' || typeof id === 'number';
const MAX_LINE = 4 * 1024 * 1024;
const RPC_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 5_000;
const MAX_PERMISSION_BLOCKS = 4;
const MAX_PREVIEW_CHARS = 4096;

function permissionContent(raw: unknown): KimiPermissionContent[] {
  if (!Array.isArray(raw)) return [];
  const blocks: KimiPermissionContent[] = [];
  for (const input of raw.slice(0, MAX_PERMISSION_BLOCKS)) {
    const block = record(input);
    if (block['type'] === 'content') {
      const content = record(block['content']);
      const text = content['text'];
      if (content['type'] !== 'text' || typeof text !== 'string') continue;
      blocks.push({
        type: 'content', content: { type: 'text', text: text.slice(0, MAX_PREVIEW_CHARS) },
        ...(text.length > MAX_PREVIEW_CHARS ? { truncated: true } : {}),
      });
    } else if (block['type'] === 'diff') {
      const { path, oldText, newText } = block;
      if (typeof path !== 'string' || typeof newText !== 'string') continue;
      const truncated = [path, oldText, newText].some((value) => typeof value === 'string' && value.length > MAX_PREVIEW_CHARS);
      blocks.push({
        type: 'diff', path: path.slice(0, MAX_PREVIEW_CHARS), newText: newText.slice(0, MAX_PREVIEW_CHARS),
        ...(typeof oldText === 'string' ? { oldText: oldText.slice(0, MAX_PREVIEW_CHARS) } : oldText === null ? { oldText } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    }
  }
  return blocks;
}


interface Waiter {
  resolve(value: JsonObject): void;
  reject(error: KimiAcpError): void;
}

interface PromptTurn {
  rpcId: number;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface Pending {
  rpcId: RpcId;
  request: KimiRequest;
}

export function createKimiAcp(options: KimiAcpOptions) {
  const grouped = process.platform !== 'win32';
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: grouped, windowsHide: true,
  });
  // ACP reserves stdout for messages. Drain stderr without logging provider output or credentials.
  child.stderr.resume();
  const decoder = new StringDecoder('utf8');
  const outgoing = new Map<number, Waiter>();
  const pending = new Map<string, Pending>();
  const exitListeners = new Set<(exit: ExitInfo) => void>();
  let line = '';
  let config: KimiConfigOption[] = [];
  let configRevision = 0;
  let changingConfig = false;
  let nextId = 0;
  let sessionId = options.sessionId;
  let connected = false;
  let dead: KimiAcpError | undefined;
  let closing: Promise<void> | undefined;
  let turn: PromptTurn | undefined;
  let replaying = false;

  const state = (): KimiState => ({ config: [...config], requests: [...pending.values()].map(({ request }) => request) });
  const publish = (): void => options.onState?.(state());

  function kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (child.pid === undefined) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  function disconnect(error: KimiAcpError): void {
    if (dead !== undefined) return;
    dead = error;
    connected = false;
    for (const waiter of outgoing.values()) waiter.reject(error);
    outgoing.clear();
    pending.clear();
    config = [];
    publish();
  }

  child.once('exit', () => {
    disconnect(new KimiAcpError('Kimi Code ACP disconnected', 'disconnected'));
    // Close may be delayed by inherited descriptors held by a surviving MCP process.
    kill('SIGKILL');
  });
  const exited = new Promise<void>((resolve) => {
    child.once('close', (exitCode, signal) => {
      disconnect(new KimiAcpError('Kimi Code ACP disconnected', 'disconnected'));
      const exit = { exitCode: exitCode ?? (signal === null ? 1 : 128 + constants.signals[signal]), signal: signal === null ? null : constants.signals[signal] };
      for (const listener of exitListeners) listener(exit);
      exitListeners.clear();
      resolve();
    });
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    disconnect(error.code === 'ENOENT'
      ? new KimiAcpError('Kimi Code CLI was not found. Install the Node-based Kimi Code CLI and check PATH.', 'missing-cli')
      : new KimiAcpError('Kimi Code CLI could not be started', 'disconnected'));
  });
  child.stdin.on('error', () => {
    disconnect(new KimiAcpError('Kimi Code ACP stdin closed', 'disconnected'));
    kill();
  });
  child.stdout.on('data', (data: Buffer) => {
    const parts = decoder.write(data).split('\n');
    for (const part of parts.slice(0, -1)) {
      if (line.length + part.length > MAX_LINE) return failFrame();
      if (line.length + part.length > 0) {
        try {
          receive(record(JSON.parse(line + part)));
        } catch {
          return failFrame();
        }
      }
      line = '';
    }
    line += parts.at(-1) ?? '';
    if (line.length > MAX_LINE) failFrame();
  });

  function failFrame(): void {
    disconnect(new KimiAcpError('Invalid frame from Kimi Code ACP', 'protocol'));
    kill();
  }

  function write(fields: JsonObject): void {
    if (dead !== undefined) throw dead;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...fields }) + '\n');
  }

  function request(method: string, params: JsonObject, timeoutMs: number | null = RPC_TIMEOUT_MS): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        outgoing.delete(id);
        reject(new KimiAcpError(`Kimi Code ACP did not answer ${method}`, 'protocol'));
      }, timeoutMs);
      timer?.unref();
      const finish = <T>(settle: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        settle(value);
      };
      outgoing.set(id, { resolve: finish(resolve), reject: finish(reject) });
      try {
        write({ id, method, params });
      } catch (error) {
        outgoing.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function setOptions(raw: unknown): boolean {
    if (!Array.isArray(raw)) return false;
    config = raw.flatMap((value: unknown) => {
      const parsed = kimiConfigOption.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    configRevision += 1;
    publish();
    return true;
  }

  function receive(message: JsonObject): void {
    if (dead !== undefined || message['jsonrpc'] !== '2.0') return;
    const { id, method } = message;
    if (typeof method !== 'string') {
      const waiter = typeof id === 'number' ? outgoing.get(id) : undefined;
      if (typeof id !== 'number' || waiter === undefined) return;
      outgoing.delete(id);
      if (message['error'] === undefined) {
        waiter.resolve(record(message['result']));
      } else {
        const code = record(message['error'])['code'];
        waiter.reject(code === -32000
          ? new KimiAcpError('Kimi Code is not signed in. Run kimi login and try again.', 'sign-in', code)
          : new KimiAcpError('Kimi Code rejected the ACP request', 'protocol', typeof code === 'number' ? code : undefined));
      }
      return;
    }

    const params = record(message['params']);
    if (method === 'session/update' && params['sessionId'] === sessionId && sessionId !== undefined) {
      const update = record(params['update']);
      const kind = update['sessionUpdate'];
      if (kind === 'config_option_update') setOptions(update['configOptions']);
      const content = record(update['content']);
      if ((kind === 'agent_message_chunk' || kind === 'user_message_chunk') && content['type'] === 'text' && typeof content['text'] === 'string') {
        if (replaying || (turn !== undefined && !turn.cancelled && kind === 'agent_message_chunk')) options.onText?.(content['text'], replaying, kind === 'user_message_chunk' ? 'user' : 'agent');
      }
      return;
    }
    if (method === '$/cancel_request' && id === undefined) {
      const cancelled = [...pending.entries()].find(([, entry]) => entry.rpcId === params['requestId']);
      if (cancelled !== undefined) {
        pending.delete(cancelled[0]);
        publish();
      }
      return;
    }
    if (!isId(id)) return;

    const invalid = () => write({ id, error: { code: -32602, message: 'Invalid ACP request' } });
    if (method === 'session/request_permission' || method === 'elicitation/create') {
      if (!connected || !turn || turn.cancelled || pending.size >= 16) return invalid();
      const requestId = randomUUID();
      const belongsToTurn = params['sessionId'] === sessionId
        || (method === 'elicitation/create' && params['sessionId'] === undefined && params['requestId'] === turn.rpcId);
      if (!belongsToTurn) return invalid();
      if ([...pending.values()].some(({ rpcId }) => rpcId === id)) return;
      if (method === 'session/request_permission') {
        const call = record(params['toolCall']);
        const rawOptions = params['options'];
        const toolCallId = call['toolCallId'];
        if (!Array.isArray(rawOptions) || rawOptions.length > 32 || typeof toolCallId !== 'string' || toolCallId.length > 1024) return invalid();
        const choices = rawOptions.map((option: unknown) => kimiPermissionOption.safeParse(option));
        if (choices.length === 0 || choices.some((option) => !option.success)) return invalid();
        const permissionOptions = choices.flatMap((option) => option.success ? [option.data] : []);
        if (new Set(permissionOptions.map((option) => option.optionId)).size !== choices.length ||
          permissionOptions.some((option) => option.name.length > 1024)) return invalid();
        const requestedContent = call['content'];
        const request: KimiRequest = {
          kind: 'permission', id: requestId, toolCallId,
          title: typeof call['title'] === 'string' ? call['title'].slice(0, 512) : 'Kimi Code',
          options: permissionOptions,
          content: permissionContent(requestedContent),
          ...(Array.isArray(requestedContent) && requestedContent.length > MAX_PERMISSION_BLOCKS ? { contentTruncated: true } : {}),
        };
        pending.set(requestId, { rpcId: id, request });
      } else {
        if (JSON.stringify(params).length > 64 * 1024) return invalid();
        const schema = kimiElicitationSchema.safeParse(params['requestedSchema']);
        const message = params['message'];
        const toolCallId = params['toolCallId'];
        if (!options.elicitationForm || params['mode'] !== 'form' || typeof message !== 'string' || !schema.success) return invalid();
        const request = {
          kind: 'elicitation' as const, id: requestId, message, requestedSchema: schema.data,
          ...(typeof toolCallId === 'string' ? { toolCallId } : {}),
        };
        // An RPC error allows Kimi to retry this question over request_permission.
        if (options.canShowElicitation?.(request) === false) return invalid();
        pending.set(requestId, { rpcId: id, request });
      }
      publish();
      return;
    }
    write({ id, error: { code: -32601, message: 'Unsupported ACP client method' } });
  }

  function respond(requestId: string, response: KimiResponse): void {
    const entry = pending.get(requestId);
    if (entry === undefined || entry.request.kind !== response.kind) {
      throw new KimiAcpError('This Kimi Code request is no longer pending', 'invalid');
    }
    let result: JsonObject;
    if (response.kind === 'permission' && entry.request.kind === 'permission') {
      const optionId = response.optionId;
      if (optionId !== null && !entry.request.options.some((option) => option.optionId === optionId)) {
        throw new KimiAcpError('Unknown Kimi Code permission option', 'invalid');
      }
      result = { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } };
    } else if (response.kind === 'elicitation') {
      result = response.action === 'accept' ? { action: 'accept', content: response.content } : { action: response.action };
    } else {
      return;
    }
    write({ id: entry.rpcId, result });
    pending.delete(requestId);
    publish();
  }

  function clearRequests(answer: boolean): void {
    for (const [id, { request: card }] of pending) {
      if (answer && dead === undefined) respond(id, card.kind === 'permission'
        ? { kind: 'permission', optionId: null }
        : { kind: 'elicitation', action: 'cancel' });
    }
    if (pending.size > 0) {
      pending.clear();
      publish();
    }
  }

  async function initialize(timeoutMs?: number): Promise<JsonObject> {
    const result = await request('initialize', {
      protocolVersion: 1,
      ...(options.clientVersion === undefined ? {} : { clientInfo: { name: 'Parley', version: options.clientVersion } }),
      clientCapabilities: options.elicitationForm ? { elicitation: { form: {} } } : {},
    }, timeoutMs);
    const agent = record(result['agentInfo']);
    if (result['protocolVersion'] !== 1 || agent['name'] !== 'Kimi Code CLI') {
      throw new KimiAcpError('Install the Node-based Kimi Code CLI with support for kimi acp.', 'protocol');
    }
    return result;
  }

  async function checkAuth(): Promise<boolean | null> {
    try {
      const result = await initialize(3_000);
      if (record(record(result['agentCapabilities'])['sessionCapabilities'])['list'] == null) return null;
      // Use a read-only session method so the CLI applies the same authentication policy it uses for sessions.
      await request('session/list', { cwd: options.cwd }, 2_000);
      return true;
    } catch (error) {
      return error instanceof KimiAcpError && error.code === 'sign-in' ? false : null;
    }
  }

  async function connect(): Promise<string> {
    const result = await initialize();
    const capabilities = record(result['agentCapabilities']);
    const params = { cwd: options.cwd, mcpServers: options.mcpServers };
    let opened: JsonObject;
    if (sessionId === undefined) {
      opened = await request('session/new', params);
      if (typeof opened['sessionId'] !== 'string' || opened['sessionId'] === '') {
        throw new KimiAcpError('Kimi Code did not return a session id', 'protocol');
      }
      sessionId = opened['sessionId'];
    } else {
      const resume = record(capabilities['sessionCapabilities'])['resume'] != null;
      if (capabilities['loadSession'] === true && (options.loadHistory === true || !resume)) {
        replaying = options.loadHistory === true;
        try {
          opened = await request('session/load', { ...params, sessionId });
        } finally {
          replaying = false;
        }
      } else {
        opened = await request('session/resume', { ...params, sessionId });
      }
      if (opened['sessionId'] !== undefined && opened['sessionId'] !== sessionId) {
        throw new KimiAcpError('Kimi Code returned a different session id', 'protocol');
      }
    }
    setOptions(opened['configOptions']);
    connected = true;
    return sessionId;
  }

  async function prompt(text: string): Promise<string> {
    if (!connected || sessionId === undefined || closing !== undefined) throw new KimiAcpError('Kimi Code session is disconnected', 'disconnected');
    if (turn !== undefined || changingConfig) throw new KimiAcpError('Kimi Code is busy', 'busy');
    const current: PromptTurn = { rpcId: nextId + 1, cancelled: false };
    turn = current;
    options.onTurnStart?.(text);
    let reason = 'error';
    let failure: KimiAcpError | undefined;
    try {
      const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, null);
      reason = typeof result['stopReason'] === 'string' ? result['stopReason'] : 'end_turn';
      return reason;
    } catch (error) {
      failure = error as KimiAcpError;
      throw error;
    } finally {
      clearTimeout(current.timer);
      clearRequests(false);
      turn = undefined;
      options.onTurnEnd?.(reason, failure);
    }
  }

  function cancel(): void {
    if (dead !== undefined || turn === undefined || turn.cancelled) return;
    turn.cancelled = true;
    write({ method: 'session/cancel', params: { sessionId } });
    clearRequests(true);
    turn.timer = setTimeout(() => kill('SIGKILL'), CANCEL_TIMEOUT_MS);
    turn.timer.unref();
  }

  async function setConfig(configId: string, value: string | boolean): Promise<KimiConfigOption[]> {
    if (!connected || sessionId === undefined || closing !== undefined) throw new KimiAcpError('Kimi Code session is disconnected', 'disconnected');
    if (turn !== undefined || changingConfig) throw new KimiAcpError('Kimi Code is busy', 'busy');
    const choice = config.find((option) => option.id === configId);
    const valid = choice?.type === 'boolean' ? typeof value === 'boolean' : choice?.options.some((option) =>
      'group' in option ? option.options.some((item) => item.value === value) : option.value === value);
    if (!valid) throw new KimiAcpError('Unknown Kimi Code configuration option or value', 'invalid');
    const revision = configRevision;
    changingConfig = true;
    try {
      const result = await request('session/set_config_option', { sessionId, configId, value });
      if (revision === configRevision && !setOptions(result['configOptions'])) {
        throw new KimiAcpError('Kimi Code did not confirm the configuration', 'protocol');
      }
      return state().config;
    } finally {
      changingConfig = false;
    }
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      try {
        if (connected && sessionId !== undefined) {
          cancel();
          await request('session/close', { sessionId }, 1_000);
        }
      } catch {
        // Older agents may not implement session/close. The process still gets stopped.
      } finally {
        kill();
      }
      const force = setTimeout(() => kill('SIGKILL'), 1_000);
      force.unref();
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    })();
    return closing;
  }

  return {
    get pid() { return child.pid; },
    busy: () => turn !== undefined || changingConfig,
    checkAuth, connect, prompt, cancel, respond, setConfig, state, close, kill,
    onExit(listener: (exit: ExitInfo) => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}
