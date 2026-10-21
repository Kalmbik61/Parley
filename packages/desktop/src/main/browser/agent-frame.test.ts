import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CDP_AGENT_SCRIPT, CDP_ALLOWED } from './inspector.js';

/** Исходники main без тестов: путь от `main/` и текст. */
function mainSources(): Array<{ file: string; source: string }> {
  const mainDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = (readdirSync(mainDir, { recursive: true }) as string[]).filter((file) => /\.(ts|js)$/.test(file) && !file.includes('.test.'));
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => ({ file: file.split(path.sep).join('/'), source: readFileSync(path.join(mainDir, file), 'utf8') }));
}

/** Файлы main, где встречается подстрока. */
function filesWith(needle: string | RegExp): string[] {
  return mainSources()
    .filter(({ source }) => (typeof needle === 'string' ? source.includes(needle) : needle.test(source)))
    .map(({ file }) => file)
    .sort();
}

const sourceOf = (file: string): string => mainSources().find((entry) => entry.file === file)?.source ?? '';

describe('рамочные: агент в браузере', () => {
  it('sendAgentScript( вызывается только в agent-evaluate.ts (определение в inspector.ts не в счёт)', () => {
    const calls = mainSources()
      .filter(({ file }) => file !== 'browser/inspector.ts')
      .filter(({ source }) => /sendAgentScript\s*[<(]/.test(source))
      .map(({ file }) => file);
    expect(calls).toEqual(['browser/agent-evaluate.ts']);
  });

  it("строка 'Runtime.evaluate' встречается только в inspector.ts и agent-evaluate.ts (комментарии не в счёт)", () => {
    const files = mainSources()
      .filter(({ source }) => source.split('\n').some((line) => line.includes("'Runtime.evaluate'") && !/^\s*(\/\/|\*|\/\*)/.test(line)))
      .map(({ file }) => file)
      .sort();
    expect(files).toEqual(['browser/agent-evaluate.ts', 'browser/inspector.ts']);
  });

  it('.cookies.get( / .set( / .remove( — только в agent-storage.ts', () => {
    expect(filesWith(/\.cookies\.(get|set|remove)\(/)).toEqual(['browser/agent-storage.ts']);
  });

  it('куки агента читаются и пишутся по адресу текущей страницы contents.getURL(), а не по аргументу', () => {
    const source = sourceOf('browser/agent-storage.ts');
    // Адрес берёт pageUrl, а он — только из contents.getURL().
    const pageUrl = source.match(/function pageUrl\([^)]*\)[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(pageUrl).toContain('contents.getURL()');
    // В cookiesOf параметра url нет, адрес объявлен из pageUrl(...).
    expect(source).toMatch(/async function cookiesOf\(\s*contents: WebContents, _?agentId: string, args: [^)]*\)/);
    expect(source).toMatch(/const page = pageUrl\(contents, args\.tab\);\s*const url = page\.href;/);
    // Все три вызова берут именно этот url.
    expect(source).toMatch(/cookies\.get\(\{ url \}\)/);
    expect(source).toMatch(/cookies\.set\(\{\s*url,/);
    expect(source).toMatch(/cookies\.remove\(url, name\)/);
    // Никаких url/domain из аргументов агента.
    expect(source).not.toMatch(/args\.(url|domain)\b/);
  });

  it("'Input.dispatch…' и 'Input.insertText' — только в agent-input.ts (и в списке разрешённых CDP inspector.ts; комментарии не в счёт): ни одной CDP-клавиши мимо одалживания фокуса (финальная рецензия m4)", () => {
    const files = mainSources()
      .filter(({ file }) => file !== 'browser/inspector.ts')
      .filter(({ source }) => source.split('\n').some((line) => /Input\.(dispatch\w*|insertText)/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)))
      .map(({ file }) => file);
    expect(files).toEqual(['browser/agent-input.ts']);
  });

  it('DOM.setFileInputFiles — только в agent-actions.ts (и в списке разрешённых CDP inspector.ts)', () => {
    const files = filesWith('DOM.setFileInputFiles').filter((file) => file !== 'browser/inspector.ts');
    expect(files).toEqual(['browser/agent-actions.ts']);
  });

  it('setSavePath( — только в agent-downloads.ts и в пути E2E main/index.ts (__parleySaveAnswer)', () => {
    expect(filesWith('setSavePath(')).toEqual(['browser/agent-downloads.ts', 'index.ts']);
    const index = sourceOf('index.ts');
    const at = index.indexOf('setSavePath(');
    expect(index.slice(Math.max(0, at - 400), at)).toContain('__parleySaveAnswer');
  });

  it('executeJavaScript( нет нигде в main; executeJavaScriptInIsolatedWorld( — только с PICK_WORLD_ID (design-mode.test.ts)', () => {
    for (const { file, source } of mainSources()) expect(source, file).not.toMatch(/\.executeJavaScript\(/);
    const calls = mainSources().flatMap(({ file, source }) =>
      [...source.matchAll(/executeJavaScriptInIsolatedWorld\(\s*([^,\s)]+)/g)].map((match) => ({ file, world: match[1] })),
    );
    for (const { file, world } of calls) expect(world, file).toBe('PICK_WORLD_ID');
  });

  it('Page.navigate нет в CDP_ALLOWED; Runtime.evaluate нет в CDP_ALLOWED, есть в CDP_AGENT_SCRIPT', () => {
    expect(CDP_ALLOWED.has('Page.navigate' as never)).toBe(false);
    expect(CDP_ALLOWED.has('Runtime.evaluate')).toBe(false);
    expect(CDP_AGENT_SCRIPT.has('Runtime.evaluate')).toBe(true);
  });

  it("в agent-ops.ts у case 'evaluate' — changes: true", () => {
    const source = sourceOf('browser/agent-ops.ts');
    const start = source.indexOf("case 'evaluate'");
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf('case ', start + 'case \'evaluate\''.length);
    expect(source.slice(start, next)).toMatch(/changes: true/);
  });

  it("'browser:focus' шлёт только guard.ts, и в том же обработчике есть проверка agentFocus", () => {
    const senders = mainSources()
      .filter(({ source }) => /send\(\s*'browser:focus'/.test(source))
      .map(({ file }) => file);
    expect(senders).toEqual(['browser/guard.ts']);
    const guard = sourceOf('browser/guard.ts');
    const handler = guard.match(/contents\.on\('focus', \(\) => \{[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(handler).toContain("send('browser:focus'");
    expect(handler.indexOf('agentFocus')).toBeGreaterThan(-1);
    expect(handler.indexOf('agentFocus')).toBeLessThan(handler.indexOf("send('browser:focus'"));
  });

  it('значение куки попадает в ответ только через ветку с проверкой httpOnly (HTTPONLY_HIDDEN)', () => {
    const source = sourceOf('browser/agent-storage.ts');
    const lines = source.split('\n').filter((line) => /\bvalue\b/.test(line) && /cookie\.value/.test(line) && !/size:/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('HTTPONLY_HIDDEN');
      expect(line).toContain('httpOnly');
    }
  });
});
