/**
 * Упаковка нативной проверки Code Mode (план T4a): исходник в @parley/core, сборка и подпись ad-hoc ДО deploy, манифест
 * с хешами, `mac.signIgnore`, чтобы electron-builder не переподписал бинарь, и проверка собранных приложений. Сборка в
 * тесте идёт только во временный каталог; без компилятора тест сборки пропускается и считается НЕ ВЫПОЛНЕННЫМ.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const read = (p: string): string => readFileSync(path.join(repoRoot, p), 'utf8');
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const canBuild = process.platform === 'darwin' && existsSync('/usr/bin/cc') && spawnSync('/usr/bin/cc', ['--version']).status === 0;
if (!canBuild) console.warn('procinfo-packaging: build test NOT RUN — needs macOS with /usr/bin/cc');

describe('порядок сборки и игнор', () => {
  it('dist собирает проверку после окна и до deploy хоста, один раз', () => {
    const dist = (JSON.parse(read('packages/desktop/package.json')) as { scripts: Record<string, string> }).scripts.dist!;
    const steps = dist.split(' && ');
    const build = steps.indexOf('node scripts/build-procinfo-probe.mjs');
    expect(build).toBeGreaterThan(steps.indexOf('pnpm build'));
    expect(build).toBeLessThan(steps.findIndex((s) => s.includes('deploy')));
    expect(steps.filter((s) => s.includes('build-procinfo-probe'))).toHaveLength(1);
  });

  it('собранный каталог в .gitignore, исходник — нет', () => {
    const lines = read('.gitignore').split('\n');
    expect(lines).toContain('packages/core/native/darwin-arm64/');
    expect(lines.some((l) => !l.startsWith('#') && (l.includes('procinfo-probe.c') || l === 'packages/core/native/'))).toBe(false);
    expect(spawnSync('git', ['check-ignore', '-q', 'packages/core/native/procinfo-probe.c'], { cwd: repoRoot }).status).toBe(1);
    expect(spawnSync('git', ['check-ignore', '-q', 'packages/core/native/darwin-arm64/procinfo-probe'], { cwd: repoRoot }).status).toBe(0);
  });

  it('electron-builder не переподписывает проверку: signIgnore совпадает с путём внутри приложения и только с ним', () => {
    // Блок `signIgnore:` внутри `mac:` — ровно один шаблон.
    const block = /^ {2}signIgnore:\n((?: {4}- .*\n)+)/m.exec(read('packages/desktop/electron-builder.yml'));
    expect(block).not.toBeNull();
    const patterns = block![1]!.trim().split('\n').map((l) => l.replace(/^\s*- '(.*)'$/, '$1'));
    expect(patterns).toEqual(['/@parley/core/native/darwin-arm64/procinfo-probe$']);
    const re = new RegExp(patterns[0]!);
    const inApp = '/x/Parley.app/Contents/Resources/host/node_modules/.pnpm/@parley+core@file+packages+core_zod@4.5.4/node_modules/@parley/core/native/darwin-arm64/procinfo-probe';
    expect(re.test(inApp)).toBe(true);
    for (const other of [`${inApp}.c`, inApp.replace('procinfo-probe', 'manifest.json'), '/x/Parley.app/Contents/Resources/node/bin/node', '/x/node-pty/prebuilds/darwin-arm64/spawn-helper']) {
      expect(re.test(other), other).toBe(false);
    }
  });

  it('проверка собранных приложений сверяет байты с манифестом, подпись и запуск обеих архитектур', () => {
    const script = read('scripts/release/verify-packaged-apps.sh');
    expect(script).toContain('check_code_mode_probe "$app" "$resources"');
    expect(script).toContain('lipo -archs "$probe")" = "arm64"');
    expect(script).toContain('binarySha256');
    expect(script).toContain('codesign -v "$probe"');
    expect(script).toContain('run_code_mode_probe mac-arm64 ok');
    expect(script).toContain('run_code_mode_probe mac refuse arch -x86_64');
  });
});

describe.skipIf(!canBuild)('build-procinfo-probe.mjs (во временный каталог)', () => {
  it('собирает arm64, подписывает ad-hoc до манифеста и записывает хеши исходника и бинаря', async () => {
    const { buildProcinfoProbe, IDENTIFIER } = (await import('../scripts/build-procinfo-probe.mjs')) as {
      buildProcinfoProbe: (o: { outDir: string }) => { binary: string; manifest: Record<string, unknown> };
      IDENTIFIER: string;
    };
    const out = mkdtempSync(path.join(tmpdir(), 'parley-probe-build-'));
    try {
      const { binary, manifest } = buildProcinfoProbe({ outDir: out });
      expect(Object.keys(manifest).sort()).toEqual(['arch', 'binarySha256', 'compiler', 'identifier', 'signature', 'sourceSha256', 'v']);
      expect(manifest).toMatchObject({ v: 1, arch: 'arm64', identifier: IDENTIFIER, signature: 'adhoc' });
      expect(manifest.sourceSha256).toBe(sha256(readFileSync(path.join(repoRoot, 'packages/core/native/procinfo-probe.c'))));
      expect(manifest.binarySha256).toBe(sha256(readFileSync(binary)));
      expect(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'))).toEqual(manifest);
      expect(execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim()).toBe('arm64');
      const sig = spawnSync('/usr/bin/codesign', ['-dv', binary], { encoding: 'utf8' }).stderr;
      expect(sig).toContain(`Identifier=${IDENTIFIER}`);
      expect(sig).toContain('Signature=adhoc');
      expect(spawnSync('/usr/bin/codesign', ['-v', binary]).status).toBe(0);
      // Сам бинарь сразу печатает маркер старта, потом отчёт без содержимого argv.
      const run = spawnSync(binary, [String(process.pid), 'PARLEY_TEST_MARKER_0123456789'], { encoding: 'utf8', env: {} });
      expect(run.stdout.split('\n')[0]).toBe('PARLEY_PROCINFO_PROBE_STARTED 1');
      expect(run.stdout).not.toContain('PARLEY_TEST_MARKER');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
