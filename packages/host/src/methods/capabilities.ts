import { homedir } from 'node:os';
import path from 'node:path';
import { isClaudeCode, scanClaudeCapabilities } from '@parley/core';
import type { Capabilities } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

type Scan = (options: { home: string; projectPath: string }) => Promise<Capabilities>;

/**
 * `capabilities.list` — подсказки поля ввода вида «Chat» (живая проверка 2026-10-02): команды, скиллы
 * и субагенты Claude Code из папок человека и проекта. Только чтение; у других провайдеров списков нет.
 * Снимка работ метод не читает, поэтому `worksReady` его не ждёт.
 */
export function createCapabilitiesList(scan: Scan = scanClaudeCapabilities): Handler<'capabilities.list'> {
  return async (params) => {
    if (!path.isAbsolute(params.projectPath)) {
      throw new HostError('bad_request', 'projectPath must be an absolute path');
    }
    if (!isClaudeCode(params.provider)) return { commands: [], skills: [], agents: [] };
    return scan({ home: homedir(), projectPath: params.projectPath });
  };
}
