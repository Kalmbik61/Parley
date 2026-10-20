/**
 * Скачивания агента (решение плана «Папка скачиваний»): файл, начатый во время операции агента на его странице,
 * ложится без диалога в `<root>/<хеш работы, 12 hex>/<id сессии>/` (каталог 0700, файл 0600), хранится
 * `AGENT_LIMITS.downloadDays` суток, до `downloadBytes` на файл, в списке сессии — `downloads` последних.
 * Маршрут (идёт ли скачивание сюда или к человеку) решает не этот модуль, а страж по окну операции агента.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { chmod, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadItem } from 'electron';
import { AGENT_LIMITS, type BrowserAgentDownload } from '@parley/protocol';
import { cleanupDrops } from '../drops.js';
import { urlForAgent } from './agent-url.js';

export interface AgentDownloadOwner {
  workKey: string;
  sessionId: string;
  /** Страница, с которой началось скачивание (`tN`). */
  tab?: string | null;
}

export interface AgentDownloads {
  claim(item: DownloadItem, owner: AgentDownloadOwner): BrowserAgentDownload;
  list(workKey: string, sessionId: string): BrowserAgentDownload[];
  dirOf(workKey: string, sessionId: string): string;
  sweep(maxAgeMs: number, now?: number): Promise<number>;
}

/** Имя файла: basename, без управляющих символов, до 200 кодовых точек, пустое — `download`. */
const NAME_LIMIT = 200;

function safeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '');
  const name = [...base].slice(0, NAME_LIMIT).join('').trim();
  return name === '' || name === '.' || name === '..' ? 'download' : name;
}

/** Занято: файл уже на диске или имя выдано скачиванию, которое ещё не создало файл (Electron пишет его позже). */
function freePath(dir: string, name: string, taken: (file: string) => boolean): string {
  const busy = (file: string): boolean => existsSync(file) || taken(file);
  const first = path.join(dir, name);
  if (!busy(first)) return first;
  const ext = path.extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  for (let n = 2; ; n += 1) {
    const next = path.join(dir, `${stem} (${n}).${ext.slice(1)}`.replace(/\.$/, ''));
    if (!busy(next)) return next;
  }
}

export function createAgentDownloads(deps: { root: string; now?(): number }): AgentDownloads {
  const now = deps.now ?? Date.now;
  const records = new Map<string, BrowserAgentDownload[]>();
  let counter = 0;

  const dirOf = (workKey: string, sessionId: string): string =>
    path.join(deps.root, createHash('sha256').update(workKey).digest('hex').slice(0, 12), sessionId);
  const keyOf = (workKey: string, sessionId: string): string => `${workKey}\n${sessionId}`;

  return {
    dirOf,
    claim(item, owner) {
      const dir = dirOf(owner.workKey, owner.sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // У уже существующей папки `mode` не действует.
      chmodSync(dir, 0o700);
      const name = safeName(item.getFilename());
      const key = keyOf(owner.workKey, owner.sessionId);
      const issued = new Set((records.get(key) ?? []).map((entry) => entry.path));
      const file = freePath(dir, name, (candidate) => issued.has(candidate));
      item.setSavePath(file);
      counter += 1;
      const record: BrowserAgentDownload = {
        id: `d${counter}`,
        tab: owner.tab ?? null,
        name: path.basename(file),
        path: file,
        url: urlForAgent(item.getURL()),
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: null,
        startedAt: new Date(now()).toISOString(),
      };
      const list = records.get(key) ?? [];
      list.push(record);
      while (list.length > AGENT_LIMITS.downloads) list.shift();
      records.set(key, list);

      const total = item.getTotalBytes();
      record.totalBytes = total > 0 ? total : null;
      item.on('updated', () => {
        record.receivedBytes = item.getReceivedBytes();
        const size = item.getTotalBytes();
        record.totalBytes = size > 0 ? size : null;
        if (record.receivedBytes > AGENT_LIMITS.downloadBytes || size > AGENT_LIMITS.downloadBytes) {
          record.note = 'Cancelled: larger than 200 MB.';
          item.cancel();
        }
      });
      item.on('done', (_event: unknown, state: string) => {
        record.receivedBytes = item.getReceivedBytes();
        if (state === 'completed') {
          record.state = 'completed';
          void chmod(file, 0o600).catch(() => undefined);
        } else if (state === 'cancelled' || state === 'interrupted') {
          record.state = state;
        }
      });
      return record;
    },
    list(workKey, sessionId) {
      return [...(records.get(keyOf(workKey, sessionId)) ?? [])];
    },
    async sweep(maxAgeMs, at = now()) {
      let removed = 0;
      let works: string[];
      try {
        works = await readdir(deps.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      for (const work of works) {
        const workDir = path.join(deps.root, work);
        let sessions: string[];
        try {
          sessions = await readdir(workDir);
        } catch {
          continue;
        }
        for (const session of sessions) {
          const dir = path.join(workDir, session);
          try {
            removed += await cleanupDrops(dir, maxAgeMs, at);
            // rmdir не трогает непустую папку.
            await rmdir(dir);
          } catch {
            /* непустая или не папка — оставляем */
          }
        }
        try {
          await rmdir(workDir);
        } catch {
          /* ещё есть сессии */
        }
      }
      return removed;
    },
  };
}
