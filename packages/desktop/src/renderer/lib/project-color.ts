/**
 * Цвет проекта — круг в заголовке группы сайдбара. Хеш `projectPath` по ступеням 400 палитры Organic
 * (спека окна 2026-09-29, раздел 4, «Цвет проекта»): `accent-400`, `accent-2-400`, `neutral-400`.
 * Цвет выводится из пути, а не хранится: один проект — один цвет во всех окнах и после перезапуска,
 * без записи в ui.json. Значение — ссылка на переменную палитры, а не hex: в тёмной теме рампы
 * перевёрнуты, и ступень сама подстраивается под тему.
 */

export const PROJECT_COLORS: readonly string[] = [
  'var(--color-accent-400)',
  'var(--color-accent-2-400)',
  'var(--color-neutral-400)',
];

/**
 * FNV-1a 32 бит: пути проектов часто отличаются только хвостом (`/p/1`, `/p/2`), и
 * хеш должен разносить их по цветам равномерно, а не по последнему символу.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function projectColor(projectPath: string): string {
  return PROJECT_COLORS[fnv1a(projectPath) % PROJECT_COLORS.length] as string;
}
