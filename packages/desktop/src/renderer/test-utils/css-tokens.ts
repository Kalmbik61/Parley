/**
 * Разбор `styles/tokens.css` для тестов контраста (кусок 1 плана «Organic»). Переменные shadcn
 * выражены через палитру — `var()` и `color-mix()`, — так что читать из файла hex напрямую нельзя.
 * Тест разворачивает значения так же, как браузер на `<html class="dark">`: и `:root`, и `.dark`
 * лежат на одном элементе, поэтому `var(--x)` в объявлении `:root` подставляется с учётом
 * переопределений `.dark`. Отдельной копии hex-значений в тестах нет — палитра одна, в CSS.
 *
 * Файл читает сам тест: этот модуль входит в сборку рендерера (tsconfig.web без типов node), поэтому
 * с `node:fs` он не дружит.
 *
 * Понимает только то, что есть в токенах: `#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb()`/`rgba()`,
 * `transparent`, `var()` (с запасным значением) и `color-mix(in srgb, …)`. Всё прочее — ошибка:
 * молчаливый «чёрный» дал бы ложно зелёный тест.
 */

import { compositeOver, type Rgb } from './contrast.js';

export type Theme = 'light' | 'dark';

/** Цвет токена: каналы 0…255 без учёта прозрачности и сама прозрачность 0…1. */
export interface Color {
  rgb: [number, number, number];
  alpha: number;
}

export interface Tokens {
  /** Объявления светлой темы: `@theme static` (рампы) и `:root`. */
  light: ReadonlyMap<string, string>;
  /** Только то, что `.dark` переопределяет; остальное тёмная берёт у светлой. */
  darkOverrides: ReadonlyMap<string, string>;
}

/** Тело блока `<head> { … }` — до парной закрывающей скобки; `null`, если блока нет. */
function blockBody(css: string, head: string): string | null {
  const start = css.indexOf(`${head} {`);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`tokens.css: блок «${head}» не закрыт`);
}

/** Объявления `--имя: значение;` блока; значение может идти в несколько строк. */
function declarations(body: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (body === null) return result;
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result.set(match[1] as string, (match[2] as string).replace(/\s+/g, ' ').trim());
  }
  return result;
}

export function parseTokens(css: string): Tokens {
  // Комментарии режутся первыми: в них бывают скобки и «--имя: …» как пример.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const light = new Map([...declarations(blockBody(clean, '@theme static')), ...declarations(blockBody(clean, ':root'))]);
  return { light, darkOverrides: declarations(blockBody(clean, '.dark')) };
}

/** Имя утилиты Tailwind → выражение из блока `@theme inline` (`--color-card: var(--card)`). */
export function parseThemeInline(css: string): Map<string, string> {
  return declarations(blockBody(css.replace(/\/\*[\s\S]*?\*\//g, ''), '@theme inline'));
}

/** Значение переменной как написано в CSS (без подстановок); в тёмной — с переопределениями `.dark`. */
export function rawValue(tokens: Tokens, theme: Theme, name: string): string {
  const value = (theme === 'dark' ? tokens.darkOverrides.get(name) : undefined) ?? tokens.light.get(name);
  if (value === undefined) throw new Error(`tokens.css: ${name} не найден (${theme})`);
  return value;
}

/**
 * Значение после подстановки цепочки `--a: var(--b)` → `--b: …` — то, что вернёт `getPropertyValue`
 * на `<html>` (Monaco читает так `--editor-surface` и `--foreground`). Значение не из одного
 * `var()` остаётся как написано: подстановка внутрь выражения тесту не нужна.
 */
export function substituted(tokens: Tokens, theme: Theme, name: string, seen: readonly string[] = []): string {
  if (seen.includes(name)) throw new Error(`tokens.css: цикл переменных ${[...seen, name].join(' → ')}`);
  const value = rawValue(tokens, theme, name);
  const target = /^var\((--[\w-]+)\)$/.exec(value);
  return target === null ? value : substituted(tokens, theme, target[1] as string, [...seen, name]);
}

/** Делит по `separator` только на нулевой глубине скобок: `rgb(0 0 0 / .5)` не рвётся. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** Внутренность функции `name( … )`, если выражение — ровно она. */
function callArguments(expression: string, name: string): string | null {
  if (!expression.startsWith(`${name}(`) || !expression.endsWith(')')) return null;
  return expression.slice(name.length + 1, -1);
}

function parseAlpha(text: string | undefined): number {
  if (text === undefined || text === '') return 1;
  return text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
}

function parseHex(hex: string): Color {
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits;
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(full)) throw new Error(`tokens.css: не hex-цвет «${hex}»`);
  const channel = (from: number): number => Number.parseInt(full.slice(from, from + 2), 16);
  return { rgb: [channel(0), channel(2), channel(4)], alpha: full.length === 8 ? channel(6) / 255 : 1 };
}

/** `color-mix(in srgb, A p%, B q%)` в предумноженном sRGB, как в CSS Color 5. */
function mix(args: string, resolve: (expression: string) => Color): Color {
  const [space, first, second, ...rest] = splitTopLevel(args, ',').map((part) => part.trim());
  if (space !== 'in srgb' || first === undefined || second === undefined || rest.length > 0) {
    throw new Error(`tokens.css: поддержан только color-mix(in srgb, A, B), не «${args}»`);
  }
  const split = (part: string): { color: Color; percent: number | null } => {
    const match = /^(.+?)\s+(\d*\.?\d+)%$/.exec(part);
    return match === null
      ? { color: resolve(part), percent: null }
      : { color: resolve(match[1] as string), percent: Number.parseFloat(match[2] as string) / 100 };
  };
  const a = split(first);
  const b = split(second);
  let pa = a.percent ?? (b.percent === null ? 0.5 : 1 - b.percent);
  let pb = b.percent ?? (a.percent === null ? 0.5 : 1 - a.percent);
  const sum = pa + pb;
  const scale = sum < 1 ? sum : 1;
  pa /= sum;
  pb /= sum;
  const alpha = a.color.alpha * pa + b.color.alpha * pb;
  // Предумножение и обратно шумит в последнем знаке (29 → 28.999999999999996): округляем до 1e-9.
  const clean = (value: number): number => Math.round(value * 1e9) / 1e9;
  const channel = (index: 0 | 1 | 2): number =>
    alpha === 0 ? 0 : clean((a.color.rgb[index] * a.color.alpha * pa + b.color.rgb[index] * b.color.alpha * pb) / alpha);
  return { rgb: [channel(0), channel(1), channel(2)], alpha: clean(alpha * scale) };
}

/** Цвет переменной с подстановками; `seen` ловит циклы `--a: var(--b); --b: var(--a)`. */
export function resolveColor(tokens: Tokens, theme: Theme, name: string, seen: readonly string[] = []): Color {
  if (seen.includes(name)) throw new Error(`tokens.css: цикл переменных ${[...seen, name].join(' → ')}`);
  const chain = [...seen, name];
  const resolve = (expression: string): Color => {
    const text = expression.trim();
    const variable = callArguments(text, 'var');
    if (variable !== null) {
      const [target, ...fallback] = splitTopLevel(variable, ',');
      const targetName = (target ?? '').trim();
      const known = (theme === 'dark' ? tokens.darkOverrides.get(targetName) : undefined) ?? tokens.light.get(targetName);
      if (known !== undefined) return resolveColor(tokens, theme, targetName, chain);
      if (fallback.length > 0) return resolve(fallback.join(','));
      throw new Error(`tokens.css: ${targetName} не найден (${theme}), нужен для ${name}`);
    }
    if (text === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
    if (text.startsWith('#')) return parseHex(text);
    const rgb = callArguments(text, 'rgb') ?? callArguments(text, 'rgba');
    if (rgb !== null) {
      const [r, g, b, a] = rgb.split(/[\s,/]+/).filter((part) => part !== '');
      return { rgb: [Number(r), Number(g), Number(b)], alpha: parseAlpha(a) };
    }
    const colorMix = callArguments(text, 'color-mix');
    if (colorMix !== null) return mix(colorMix, resolve);
    throw new Error(`tokens.css: ${name} — выражение «${text}» не поддержано разбором`);
  };
  return resolve(rawValue(tokens, theme, name));
}

/**
 * Цвет токена поверх сплошной подложки — целыми каналами, как пиксель на экране: браузер смешивает
 * в числах с плавающей точкой и при отрисовке округляет до 8 бит, именно это видит человек.
 */
export function colorOver(tokens: Tokens, theme: Theme, name: string, backdrop: Rgb): Rgb {
  const { rgb, alpha } = resolveColor(tokens, theme, name);
  const mixed = alpha === 1 ? rgb : compositeOver(rgb, alpha, backdrop);
  return [Math.round(mixed[0]), Math.round(mixed[1]), Math.round(mixed[2])];
}
