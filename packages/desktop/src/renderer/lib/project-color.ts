/**
 * Цвет проекта — `REPO_COLORS` Orca (спека 4.1): чип заголовка группы в сайдбаре.
 * Цвет выводится из пути, а не хранится: один проект — один цвет во всех окнах и после
 * перезапуска, без записи в ui.json.
 */

export const PROJECT_COLORS: readonly string[] = [
  '#737373',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#8b5cf6',
  '#ec4899',
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
