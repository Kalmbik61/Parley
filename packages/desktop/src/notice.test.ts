/**
 * Страж лицензий сборки (ревью M7, аудит приёмки MVP): NOTICE и лицензии шрифтов Figtree и
 * Caprasimo едут в `.app` (`extraResources` electron-builder), а NOTICE называет каждый файл,
 * адаптированный из shadcn/ui, и таблицу палитр терминала из Orca, и оба шрифта — с правообладателями
 * из их OFL-файлов и происхождением (Google Fonts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const notice = readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
const builder = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');

/** Файлы рендерера с пометкой shadcn/ui в тексте — адаптации его компонентов и утилит. */
function shadcnFiles(): string[] {
  const out: string[] = [];
  const stack = [path.join(desktopRoot, 'src', 'renderer')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') && readFileSync(full, 'utf8').includes('shadcn/ui')) {
        out.push(path.relative(repoRoot, full));
      }
    }
  }
  return out.sort();
}

const fontsDir = path.join(desktopRoot, 'src', 'renderer', 'assets', 'fonts');
const firstLine = (file: string): string => readFileSync(path.join(fontsDir, file), 'utf8').split('\n')[0] ?? '';

describe('NOTICE и лицензии в сборке (ревью M7)', () => {
  it('electron-builder кладёт NOTICE и OFL шрифтов Figtree и Caprasimo в Contents/Resources', () => {
    expect(builder).toMatch(/- from: \.\.\/\.\.\/NOTICE\n\s+to: NOTICE\n/);
    expect(builder).toMatch(/- from: src\/renderer\/assets\/fonts\/Figtree-OFL\.txt\n\s+to: licenses\/Figtree-OFL\.txt\n/);
    expect(builder).toMatch(/- from: src\/renderer\/assets\/fonts\/Caprasimo-OFL\.txt\n\s+to: licenses\/Caprasimo-OFL\.txt\n/);
  });

  it('Geist ушёл: ни из electron-builder, ни из NOTICE', () => {
    expect(builder).not.toMatch(/geist/i);
    expect(notice).not.toMatch(/geist/i);
  });

  it('NOTICE: Figtree и Caprasimo — файлы, правообладатели из OFL-файлов, происхождение Google Fonts, лицензия рядом', () => {
    for (const [name, file, license] of [
      ['Figtree', 'Figtree-Variable.ttf', 'Figtree-OFL.txt'],
      ['Caprasimo', 'Caprasimo.ttf', 'Caprasimo-OFL.txt'],
    ] as const) {
      expect(notice, name).toContain(`\n${name}\n`);
      expect(notice, `${name}: файл`).toContain(`packages/desktop/src/renderer/assets/fonts/${file}`);
      // Строка «Copyright …» — та самая, что первой стоит в OFL-файле: правится лицензия — правится и NOTICE.
      expect(firstLine(license), `${name}: первая строка OFL`).toMatch(/^Copyright \d{4} The \w+ Project Authors/);
      expect(notice, `${name}: правообладатель`).toContain(firstLine(license));
      expect(notice, `${name}: лицензия в .app`).toContain(`Contents/Resources/licenses/${license}`);
      expect(notice, `${name}: текст лицензии`).toContain(`packages/desktop/src/renderer/assets/fonts/${license}`);
    }
    expect(notice).toContain('SIL Open Font License, Version 1.1');
    expect(notice).toMatch(/Google Fonts/);
  });

  it('NOTICE называет shadcn/ui с его лицензией MIT и каждый адаптированный файл', () => {
    expect(notice).toMatch(/\nshadcn\/ui\n/);
    expect(notice).toContain('Copyright (c) 2023 shadcn');
    const files = shadcnFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(notice, file).toContain(file);
  });

  // Решение 6 спеки окна: брендовые значки — решение пользователя для личной неподписанной сборки, а не
  // лицензия. NOTICE называет файлы, откуда они и чьи это знаки, и не говорит о лицензии, которой нет.
  it('NOTICE: значки провайдеров — файлы, происхождение, знаки Anthropic и OpenAI, без слов о лицензии', () => {
    const rule = `\n${'-'.repeat(78)}`;
    const start = notice.indexOf('\nЗначки провайдеров\n');
    expect(start, 'раздел «Значки провайдеров»').toBeGreaterThan(-1);
    // Под названием стоит своя линия, за телом — линия следующего раздела.
    const underline = notice.indexOf(rule, start);
    const next = notice.indexOf(rule, underline + 1);
    const section = notice.slice(underline, next === -1 ? undefined : next);
    for (const file of ['claude.svg', 'codex.svg', 'codex-light.svg']) {
      expect(section, file).toContain(`packages/desktop/src/renderer/assets/providers/${file}`);
      expect(readFileSync(path.join(desktopRoot, 'src', 'renderer', 'assets', 'providers', file), 'utf8'), `${file} лежит в assets`).toContain('<svg');
    }
    expect(section).toContain('docs/design/2026-09-29-rooms-organic/prototype/assets');
    expect(section).toMatch(/Anthropic[^\n]*Claude/);
    expect(section).toMatch(/OpenAI[^\n]*Codex/);
    expect(section).not.toMatch(/licen[sc]|лиценз/i);
  });

  // Правки ревью куска 2: раздел говорил, что окно рисует значки «на вкладках», хотя `AgentIcon` со вкладок
  // убран — их нет на снимках handoff. Места, названные в NOTICE, должны совпадать с теми, где он есть.
  it('NOTICE: значки провайдеров — только там, где окно их рисует (строка статуса, сайдбар), не на вкладках', () => {
    const rule = `\n${'-'.repeat(78)}`;
    const underline = notice.indexOf(rule, notice.indexOf('\nЗначки провайдеров\n'));
    const next = notice.indexOf(rule, underline + 1);
    const section = notice.slice(underline, next === -1 ? undefined : next);
    const usedIn = (file: string): boolean => readFileSync(path.join(desktopRoot, 'src', 'renderer', file), 'utf8').includes('<AgentIcon');
    expect(section).toMatch(/строке статуса/);
    expect(usedIn('shell/StatusBar.tsx')).toBe(true);
    expect(section).toMatch(/сайдбаре/);
    expect(usedIn('sidebar/SessionRow.tsx')).toBe(true);
    expect(section).not.toMatch(/вкладк/);
    expect(usedIn('layout/Tab.tsx')).toBe(false);
  });

  // Бинарь Node.js в dmg и zip раздаётся вместе с текстом его лицензии (MIT Node.js и лицензии V8, OpenSSL, ICU):
  // `fetch-node.mjs` достаёт `LICENSE` из архива, `extraResources` несёт каталог целиком, NOTICE называет место.
  it('NOTICE: Node.js — бинарь и его лицензия едут вместе, в Contents/Resources/node', () => {
    const rule = `\n${'-'.repeat(78)}`;
    const underline = notice.indexOf(rule, notice.indexOf('\nNode.js\n'));
    const next = notice.indexOf(rule, underline + 1);
    const section = notice.slice(underline, next === -1 ? undefined : next);

    expect(section).toContain('Contents/Resources/node/bin/node');
    expect(section).toContain('Contents/Resources/node/LICENSE');
    expect(section).toMatch(/V8, OpenSSL, ICU/);
    // Лицензию кладёт тот же скрипт, что и бинарь, и называет её тем же именем, что в архиве Node.
    const fetchNode = readFileSync(path.join(desktopRoot, 'scripts', 'fetch-node.mjs'), 'utf8');
    expect(fetchNode).toContain('${top}/LICENSE');
    expect(builder).toMatch(/- from: build\/node\/darwin-\$\{arch\}\n\s+to: node\n/);
  });

  it('NOTICE называет whisper.cpp и Silero VAD с их MIT', () => {
    expect(notice).toContain('whisper.cpp');
    expect(notice).toContain('Copyright (c) 2023-2026 The ggml authors');
    expect(notice).toContain('Silero VAD');
    expect(notice).toContain('Copyright (c) 2020-present Silero Team');
  });

  it('NOTICE называет таблицу палитр терминала из Orca', () => {
    expect(notice).toContain('packages/desktop/src/renderer/terminal/xterm-themes.ts');
  });
});
