/**
 * Описание субагента из его `meta.json` (Parley 0.2.0, активность агентов): путь строится от
 * транскрипта родителя, читается только этот файл, любой сбой — `null`. Каталоги — временные.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSubagentMeta } from './subagent-meta.js';

let root = '';
/** Транскрипт родителя; рядом с ним (без `.jsonl`) лежит каталог субагентов. */
let transcript = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-meta-'));
  transcript = path.join(root, '-proj', 'sess.jsonl');
  await mkdir(path.join(root, '-proj', 'sess', 'subagents'), { recursive: true });
});

afterEach(async () => {
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
});
