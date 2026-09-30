/**
 * Привязка сессии харнесса к rollout-логу Codex (спека комнат Organic, 3.6 и исследование Codex,
 * раздел 11): Codex пишет в те же `sessions/` логи подагентов и внутренних тредов, а «откатанные»
 * треды называет `rollout-<время>-<тред>_<rollout>.jsonl`. Ни то ни другое не должно ни занять
 * место настоящей сессии при привязке по cwd и времени, ни сломать разбор id.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexSessions } from '../codex/discover.js';
import { indexCodexSession } from '../codex/index-session.js';
import { PROVIDERS } from '../providers.js';
import { linkProviderSession, readSessionMetrics } from './metrics.js';

const THREAD = '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const ROLLOUT_ID = '019ce3d6-0001-7be2-922e-b8185a8d0002';
const SUBAGENT = '019ce3d5-aaaa-7be2-922e-b8185a8d0003';
const START = '2026-03-12T09:59:59.000Z';
const CWD = '/Users/dev/проект';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harnas-codex-link-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

/** Что `session_meta` Codex несёт сверх id и cwd: источник треда и его родитель. */
interface MetaExtras {
  source?: unknown;
  parent_thread_id?: unknown;
}

/** Кладёт лог в `<root>/2026/03/12/<имя файла>` с `session_meta` заданного треда. */
async function writeLog(
  fileName: string,
  id: string,
  at: string,
  extras: MetaExtras = {},
  cwd = CWD,
): Promise<string> {
  const dir = path.join(root, '2026', '03', '12');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await writeFile(
    file,
    line({
      timestamp: at,
      type: 'session_meta',
      payload: { id, timestamp: at, cwd, cli_version: '0.159.0', ...extras },
    }) +
      line({
        timestamp: at,
        type: 'turn_context',
        payload: { type: 'turn_context', cwd, model: 'gpt-6-sol' },
      }),
  );
  return file;
}

const link = (): Promise<string | null> =>
  linkProviderSession(PROVIDERS.codex, { cwd: CWD, startedAt: START }, { codexRoot: root });

describe('имя файла с «_» (откатанные треды)', () => {
  it('rollout-<время>-<тред>_<rollout>.jsonl — id это тред, а не rollout', async () => {
    await writeLog(`rollout-2026-03-12T10-00-00-${THREAD}_${ROLLOUT_ID}.jsonl`, THREAD, START);
    const [found] = await discoverCodexSessions(root);
    expect(found?.id).toBe(THREAD);
  });

  it('обычное имя — по-прежнему id из суффикса', async () => {
    await writeLog(`rollout-2026-03-12T10-00-00-${THREAD}.jsonl`, THREAD, START);
    const [found] = await discoverCodexSessions(root);
    expect(found?.id).toBe(THREAD);
  });

  it('незнакомое имя — id из имени файла без расширения, как и раньше', async () => {
    await writeLog('rollout-2026-03-12T10-00-00-наша-сессия.jsonl', 'наша-сессия', START);
    const [found] = await discoverCodexSessions(root);
    expect(found?.id).toBe('rollout-2026-03-12T10-00-00-наша-сессия');
  });

  it('метрики откатанного треда находятся по id треда, который знает карта', async () => {
    await writeLog(`rollout-2026-03-12T10-00-00-${THREAD}_${ROLLOUT_ID}.jsonl`, THREAD, START);
    const metrics = await readSessionMetrics('codex', THREAD, { codexRoot: root });
    expect(metrics).not.toBeNull();
  });

  it('привязка по cwd и времени возвращает id треда из session_meta', async () => {
    await writeLog(`rollout-2026-03-12T10-00-00-${THREAD}_${ROLLOUT_ID}.jsonl`, THREAD, START);
    expect(await link()).toBe(THREAD);
  });
});

describe('логи подагентов и внутренних тредов не привязываются', () => {
  const REAL_AT = '2026-03-12T10:00:05.000Z';
  /** Подагент запускается раньше настоящей сессии — раньше он и выигрывал «ближайшую к запуску». */
  const OTHER_AT = '2026-03-12T10:00:01.000Z';

  const realLog = (): Promise<string> =>
    writeLog(`rollout-2026-03-12T10-00-05-${THREAD}.jsonl`, THREAD, REAL_AT, { source: 'cli' });

  it('parent_thread_id задан — подагент, даже если source у него cli', async () => {
    await realLog();
    await writeLog(`rollout-2026-03-12T10-00-01-${SUBAGENT}.jsonl`, SUBAGENT, OTHER_AT, {
      source: 'cli',
      parent_thread_id: THREAD,
    });
    expect(await link()).toBe(THREAD);
  });

  it('source — объект {subagent: …}: подагент', async () => {
    await realLog();
    await writeLog(`rollout-2026-03-12T10-00-01-${SUBAGENT}.jsonl`, SUBAGENT, OTHER_AT, {
      source: { subagent: { thread_spawn: { parent_thread_id: THREAD, depth: 1 } } },
    });
    expect(await link()).toBe(THREAD);
  });

  it('source — объект {internal: …}: внутренний тред', async () => {
    await realLog();
    await writeLog(`rollout-2026-03-12T10-00-01-${SUBAGENT}.jsonl`, SUBAGENT, OTHER_AT, {
      source: { internal: 'memory_consolidation' },
    });
    expect(await link()).toBe(THREAD);
  });

  it('source — exec (неинтерактивный запуск): тоже не сессия харнесса', async () => {
    await realLog();
    await writeLog(`rollout-2026-03-12T10-00-01-${SUBAGENT}.jsonl`, SUBAGENT, OTHER_AT, {
      source: 'exec',
    });
    expect(await link()).toBe(THREAD);
  });

  it('остался один лишь подагент — привязки нет, а не чужой тред', async () => {
    await writeLog(`rollout-2026-03-12T10-00-01-${SUBAGENT}.jsonl`, SUBAGENT, OTHER_AT, {
      source: 'cli',
      parent_thread_id: THREAD,
    });
    expect(await link()).toBeNull();
  });

  it('source — cli без родителя привязывается', async () => {
    await realLog();
    expect(await link()).toBe(THREAD);
  });

  it('старый лог без source и parent_thread_id привязывается: поля появились позже', async () => {
    await writeLog(`rollout-2026-03-12T10-00-05-${THREAD}.jsonl`, THREAD, REAL_AT);
    expect(await link()).toBe(THREAD);
  });

  it('parent_thread_id: null (поле есть, значения нет) — не подагент', async () => {
    await writeLog(`rollout-2026-03-12T10-00-05-${THREAD}.jsonl`, THREAD, REAL_AT, {
      source: 'cli',
      parent_thread_id: null,
    });
    expect(await link()).toBe(THREAD);
  });
});

describe('индекс лога Codex помечает порождённые треды', () => {
  it('spawned — только у подагента, внутреннего треда и неинтерактивного запуска', async () => {
    const at = '2026-03-12T10:00:00.000Z';
    const cases: Array<[string, MetaExtras, boolean]> = [
      ['cli', { source: 'cli' }, false],
      ['без source', {}, false],
      ['родитель', { source: 'cli', parent_thread_id: THREAD }, true],
      ['subagent', { source: { subagent: 'review' } }, true],
      ['internal', { source: { internal: 'x' } }, true],
      ['exec', { source: 'exec' }, true],
    ];
    for (const [name, extras, expected] of cases) {
      const file = await writeLog(
        `rollout-2026-03-12T10-00-00-${name}.jsonl`,
        `id-${name}`,
        at,
        extras,
      );
      expect((await indexCodexSession(file)).spawned === true, name).toBe(expected);
    }
  });
});
