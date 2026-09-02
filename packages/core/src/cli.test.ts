import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { SchemaReportResult } from './schema-report.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.ts');
const FIXTURES = path.join(here, '..', 'test', 'fixtures', 'projects');

/** Запускаем исходник через tsx: тест проверяет контракт, а не артефакт сборки. */
async function cli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run('pnpm', ['exec', 'tsx', CLI, ...args], {
      cwd: path.join(here, '..', '..', '..'),
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

describe('harnas-core CLI', () => {
  it('index печатает в stdout только JSON', async () => {
    const { stdout, code } = await cli('index', '--root', FIXTURES);
    expect(code).toBe(0);

    const index = JSON.parse(stdout);
    expect(index).toHaveLength(3);
    expect(index[0]).toHaveProperty('primaryModel');
    expect(index[0]).toHaveProperty('subsessionCount');
    expect(Object.keys(index[0].tokens)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite']);
  }, 60_000);

  it('session отдаёт сессию с подсессиями', async () => {
    const { stdout, code } = await cli('session', 's000001', '--root', FIXTURES);
    expect(code).toBe(0);

    const tree = JSON.parse(stdout);
    expect(tree.session.id).toBe('s000001');
    expect(tree.subsessions).toHaveLength(1);
  }, 60_000);

  it('неизвестная сессия — ошибка в stderr и ненулевой код', async () => {
    const { stdout, stderr, code } = await cli('session', 'нет-такой', '--root', FIXTURES);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('не найдена');
  }, 60_000);

  it('неизвестная команда не печатает JSON', async () => {
    const { stdout, code } = await cli('чепуха');
    expect(code).toBe(1);
    expect(stdout).toBe('');
  }, 60_000);
});

describe('harnas-core schema', () => {
  it('отчёт по схеме печатается в stdout как JSON', async () => {
    const { stdout, code } = await cli('schema', '--root', FIXTURES);
    expect(code).toBe(0);

    const result = JSON.parse(stdout) as SchemaReportResult;
    expect(result.files).toBeGreaterThan(3);
    expect(result.records).toBeGreaterThan(100);
    expect(result.report['user']?.count).toBeGreaterThan(0);
    // Мапы с путями схлопнуты: в именах полей путей быть не должно.
    const names = Object.values(result.report).flatMap((type) => Object.keys(type.fields));
    expect(names.some((name) => name.includes('/'))).toBe(false);
  }, 60_000);

  it('неизвестный провайдер отвергается', async () => {
    const { stdout, stderr, code } = await cli('schema', '--provider', 'выдумка');
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Неизвестный провайдер');
  }, 60_000);
});
