#!/usr/bin/env node
// Сборка нативной проверки Code Mode (план T4a): `packages/core/native/procinfo-probe.c` → arm64-бинарь
// `packages/core/native/darwin-arm64/procinfo-probe` и `manifest.json` рядом.
//
// Порядок важен для подписи: бинарь подписывается ad-hoc ЗДЕСЬ (`codesign -s - -f -i dev.parley.procinfo-probe`), потом
// считается его sha256 и пишется манифест, потом `pnpm deploy` уносит каталог вместе с @parley/core в приложение, а
// electron-builder его не переподписывает (`mac.signIgnore` в electron-builder.yml). Иначе в приложении лежали бы другие
// байты, чем в манифесте, и Code Mode был бы недоступен. Сборка — до deploy, один раз; в рантайме ничего не компилируется.
//
// Использование: node scripts/build-procinfo-probe.mjs (скрипт `dist` вызывает его перед deploy).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE = path.resolve(here, '../../core/native/procinfo-probe.c');
export const OUT_DIR = path.resolve(here, '../../core/native/darwin-arm64');
export const IDENTIFIER = 'dev.parley.procinfo-probe';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });

/**
 * Собирает, подписывает ad-hoc и описывает бинарь в `outDir`. Каталог пересоздаётся: старый бинарь или манифест не
 * переживают неудачную сборку. Манифест пишется последним, так что его наличие значит, что все шаги прошли.
 */
export function buildProcinfoProbe({ source = SOURCE, outDir = OUT_DIR, cc = '/usr/bin/cc' } = {}) {
  if (process.platform !== 'darwin') throw new Error('the procinfo probe builds on macOS only');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const binary = path.join(outDir, 'procinfo-probe');
  const tmp = `${binary}.tmp`;
  run(cc, ['-arch', 'arm64', '-O2', '-Wall', '-Wextra', '-Werror', '-o', tmp, source]);
  run('/usr/bin/codesign', ['-s', '-', '-f', '-i', IDENTIFIER, tmp]);
  run('/usr/bin/codesign', ['-v', tmp]);
  const archs = run('/usr/bin/lipo', ['-archs', tmp]).trim();
  if (archs !== 'arm64') throw new Error(`the procinfo probe is not an arm64 binary: ${archs}`);
  renameSync(tmp, binary);
  const manifest = {
    v: 1,
    arch: 'arm64',
    identifier: IDENTIFIER,
    signature: 'adhoc',
    sourceSha256: sha256(readFileSync(source)),
    binarySha256: sha256(readFileSync(binary)),
    compiler: run(cc, ['--version']).split('\n')[0].trim(),
  };
  writeFileSync(path.join(outDir, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(path.join(outDir, 'manifest.json.tmp'), path.join(outDir, 'manifest.json'));
  return { binary, manifest };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { binary, manifest } = buildProcinfoProbe();
    console.log(`procinfo probe: ${binary} (sha256 ${manifest.binarySha256}, ${manifest.compiler})`);
  } catch (error) {
    console.error(`build-procinfo-probe: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
