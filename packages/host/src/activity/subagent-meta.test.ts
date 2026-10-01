/**
 * Описание субагента из его `meta.json` (Parley 0.2.0, активность агентов): путь строится от
 * транскрипта родителя, читается только этот файл, любой сбой — `null`. Каталоги — временные.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSubagentMeta } from './subagent-meta.js';

const run = promisify(execFile);

let root = '';
/** Транскрипт родителя; рядом с ним (без `.jsonl`) лежит каталог субагентов. */
let transcript = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-meta-'));
  // Корень истории Claude — временный: `meta.json` читается только внутри корней истории.
  process.env['PARLEY_CLAUDE_PROJECTS_DIR'] = root;
  transcript = path.join(root, '-proj', 'sess.jsonl');
  await mkdir(path.join(root, '-proj', 'sess', 'subagents'), { recursive: true });
});

afterEach(async () => {
  delete process.env['PARLEY_CLAUDE_PROJECTS_DIR'];
  await rm(root, { recursive: true, force: true });
});

const metaFile = (id: string): string =>
  path.join(root, '-proj', 'sess', 'subagents', `agent-${id}.meta.json`);

describe('readSubagentMeta', () => {
  it('читает agentType и description из <транскрипт без .jsonl>/subagents/agent-<id>.meta.json', async () => {
    await writeFile(
      metaFile('a4a0fb93b5a2dbaf7'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Orca mobile app research',
        requestNonInteractive: false,
        requestShape: 'x',
        spawnDepth: 1,
        toolUseId: 'toolu_01',
      }),
    );

    expect(await readSubagentMeta(transcript, 'a4a0fb93b5a2dbaf7')).toEqual({
      agentType: 'general-purpose',
      description: 'Orca mobile app research',
    });
  });

  it('транскрипт вне корней истории Claude — файл не читается, даже если он есть (ревью 0.2.0, п. 14)', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'parley-meta-outside-'));
    try {
      await mkdir(path.join(outside, 'sess', 'subagents'), { recursive: true });
      await writeFile(
        path.join(outside, 'sess', 'subagents', 'agent-a1.meta.json'),
        JSON.stringify({ agentType: 'general-purpose', description: 'не отсюда' }),
      );
      expect(await readSubagentMeta(path.join(outside, 'sess.jsonl'), 'a1')).toBeNull();
      // Тот же файл читается, если его корень назван явно.
      expect(await readSubagentMeta(path.join(outside, 'sess.jsonl'), 'a1', [outside])).toEqual({
        agentType: 'general-purpose',
        description: 'не отсюда',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('файла ещё нет — null: хост попробует при следующем обновлении', async () => {
    expect(await readSubagentMeta(transcript, 'a1')).toBeNull();
    expect(await readSubagentMeta(path.join(root, 'нет', 'sess.jsonl'), 'a1')).toBeNull();
  });

  it('битый JSON, не объект и файл без нужных полей — null', async () => {
    await writeFile(metaFile('broken'), '{не json');
    await writeFile(metaFile('list'), '["a"]');
    await writeFile(metaFile('empty'), JSON.stringify({ agentType: '', description: '  ' }));
    await writeFile(metaFile('numbers'), JSON.stringify({ agentType: 1, description: {} }));

    for (const id of ['broken', 'list', 'empty', 'numbers']) {
      expect(await readSubagentMeta(transcript, id), id).toBeNull();
    }
  });

  it('одно поле из двух — тоже годится, второе null', async () => {
    await writeFile(metaFile('only-type'), JSON.stringify({ agentType: 'explorer' }));
    await writeFile(metaFile('only-text'), JSON.stringify({ description: 'Docs lookup' }));

    expect(await readSubagentMeta(transcript, 'only-type')).toEqual({
      agentType: 'explorer',
      description: null,
    });
    expect(await readSubagentMeta(transcript, 'only-text')).toEqual({
      agentType: null,
      description: 'Docs lookup',
    });
  });

  it('транскрипт без суффикса .jsonl — тот же каталог', async () => {
    await writeFile(metaFile('a1'), JSON.stringify({ description: 'без суффикса' }));

    expect(await readSubagentMeta(path.join(root, '-proj', 'sess'), 'a1')).toEqual({
      agentType: null,
      description: 'без суффикса',
    });
  });

  it('id с разделителем пути и относительный транскрипт не читаются вовсе', async () => {
    // Файл, до которого `agent-x/../../escape` добрался бы подъёмом из каталога субагентов.
    await writeFile(
      path.join(root, '-proj', 'sess', 'escape.meta.json'),
      JSON.stringify({ description: 'ЧУЖОЙ ФАЙЛ' }),
    );

    expect(await readSubagentMeta(transcript, 'x/../../escape')).toBeNull();
    expect(await readSubagentMeta(transcript, '..')).toBeNull();
    expect(await readSubagentMeta(transcript, '')).toBeNull();
    expect(await readSubagentMeta('-proj/sess.jsonl', 'a1')).toBeNull();
  });

  it('FIFO с таким именем не блокирует чтение: null сразу, а не зависший поток пула', async () => {
    const fifo = metaFile('pipe');
    await run('mkfifo', [fifo]);

    const outcome = await Promise.race([
      readSubagentMeta(transcript, 'pipe'),
      new Promise<'завис'>((resolve) => setTimeout(() => resolve('завис'), 1500)),
    ]);
    // Если чтение всё же повисло на open, развязываем его: поток пула не должен остаться заблокированным.
    if (outcome === 'завис') await open(fifo, 'r+').then((handle) => handle.close());

    expect(outcome).toBeNull();
  });

  it('символическая ссылка (даже на настоящий файл) и каталог с таким именем не читаются', async () => {
    const real = path.join(root, 'real.json');
    await writeFile(real, JSON.stringify({ description: 'за ссылкой' }));
    await symlink(real, metaFile('link'));
    await mkdir(metaFile('dir'));

    expect(await readSubagentMeta(transcript, 'link')).toBeNull();
    expect(await readSubagentMeta(transcript, 'dir')).toBeNull();
  });

  it('предел размера — 64 КБ: ровно столько читается, на байт больше — нет', async () => {
    // `{"description":"` и `"}` — 18 знаков, остальное — наполнитель до нужного размера.
    const sized = (bytes: number): string =>
      JSON.stringify({ description: 'x'.repeat(bytes - 18) });
    await writeFile(metaFile('fits'), sized(64 * 1024));
    await writeFile(metaFile('big'), sized(64 * 1024 + 1));

    expect((await readSubagentMeta(transcript, 'fits'))?.description).toHaveLength(64 * 1024 - 18);
    expect(await readSubagentMeta(transcript, 'big')).toBeNull();
  });
});
