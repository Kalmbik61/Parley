/**
 * Страж настроек первого релиза (план релиза 0.1.0, V1 и V2): версия одна на все пакеты, метаданные и
 * лицензия на месте, а `electron-builder.yml` держит значения, которые нельзя менять случайно, — прежде
 * всего `appId`: после первого публичного релиза его смена стирает настройки и разрешения macOS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');

interface Manifest {
  name: string;
  version: string;
  license?: string;
  author?: string;
  homepage?: string;
  repository?: { type?: string; url?: string };
}

const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest;

describe('версия и метаданные (V1)', () => {
  const manifests = [
    repoRoot,
    path.join(repoRoot, 'packages', 'core'),
    path.join(repoRoot, 'packages', 'protocol'),
    path.join(repoRoot, 'packages', 'host'),
    desktopRoot,
  ].map(manifest);

  it('версия одна на корень и все четыре пакета: именно её показывает окно (app.getVersion) и хост (Host x.y.z)', () => {
    expect(manifests.map((m) => m.name)).toEqual([
      'parley',
      '@parley/core',
      '@parley/protocol',
      '@parley/host',
      '@parley/desktop',
    ]);
    const versions = new Set(manifests.map((m) => m.version));
    expect(versions.size, `версии пакетов: ${[...versions].join(', ')}`).toBe(1);
    expect([...versions][0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('корень и окно: MIT, автор, домашняя страница и репозиторий', () => {
    for (const m of [manifests[0], manifests[4]]) {
      expect(m?.license, m?.name).toBe('MIT');
      expect(m?.author, m?.name).toBe('Evgeniy');
      expect(m?.homepage, m?.name).toBe('https://github.com/Kalmbik61/Parley');
      expect(m?.repository, m?.name).toEqual({ type: 'git', url: 'https://github.com/Kalmbik61/Parley.git' });
    }
  });

  it('LICENSE в корне — MIT с правообладателем Evgeniy', () => {
    const license = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');

    expect(license.startsWith('MIT License\n')).toBe(true);
    expect(license).toContain('\nCopyright (c) 2026 Evgeniy\n');
    expect(license).toContain('Permission is hereby granted, free of charge');
  });
});

describe('упаковка macOS (V2)', () => {
  const builder = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');

  it('appId dev.parley.desktop: после первого релиза не меняется', () => {
    expect(builder).toMatch(/^appId: dev\.parley\.desktop$/m);
    expect(builder).toMatch(/^productName: Parley$/m);
  });

  it('цели dmg и zip, каждая для arm64 и x64', () => {
    expect(builder).toMatch(
      /^mac:\n {2}target:\n {4}- target: dmg\n {6}arch: \[arm64, x64\]\n {4}- target: zip\n {6}arch: \[arm64, x64\]\n/m,
    );
  });

  it('подпись ad-hoc без hardened runtime: identity null скачанный arm64 .app сделал бы «повреждённым»', () => {
    expect(builder).toMatch(/^ {2}identity: '-'$/m);
    expect(builder).toMatch(/^ {2}hardenedRuntime: false$/m);
    expect(builder).not.toMatch(/identity: null/);
  });

  it('имя артефакта без версии, один шаблон на dmg и zip', () => {
    expect(builder).toMatch(/^ {2}artifactName: parley-macos-\$\{arch\}\.\$\{ext\}$/m);
  });

  it('публикация — черновик релиза в Kalmbik61/Parley', () => {
    expect(builder).toMatch(
      /^publish:\n {2}provider: github\n {2}owner: Kalmbik61\n {2}repo: Parley\n {2}releaseType: draft\n/m,
    );
  });
});
