/**
 * Контраст пары цветов по WCAG: относительная яркость sRGB через
 * линеаризацию каналов (коэффициенты 0.2126/0.7152/0.0722) и отношение
 * контраста `(светлее + 0.05) / (темнее + 0.05)` (дизайн темы TUI, 7.2).
 */

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

/** Линеаризация одного канала sRGB (0–255) в диапазон 0–1. */
function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость `#rrggbb` по формуле WCAG. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Отношение контраста двух `#rrggbb`: от 1 (нет контраста) до 21 (чёрный/белый). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
