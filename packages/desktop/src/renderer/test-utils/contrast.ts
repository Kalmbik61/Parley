/**
 * Контраст WCAG для тестов раунда исправлений 1 куска 1.4 (ревью B, находки
 * «destructive-кнопка» и «подсказка палитры»): формула из спецификации
 * WCAG 2.x (относительная светлота + коэффициент контраста), без внешних
 * зависимостей — считаем ровно то же, что аудит-скрипт ревьюера, но как
 * часть репозитория, а не одноразовый скрипт в scratchpad.
 */

export type Rgb = readonly [r: number, g: number, b: number];

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Относительная светлота (WCAG): 0 — чёрный, 1 — белый. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** Коэффициент контраста двух цветов (WCAG): (L_светлый + .05) / (L_тёмный + .05). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Цвет `fg` с прозрачностью `alpha` (0…1) поверх сплошного `bg` — обычное
 * alpha-смешение в исходном (не линеаризованном) sRGB, тем же способом, что
 * браузер рисует `color: …/NN%` или `bg-…/NN` Tailwind поверх подложки.
 */
export function compositeOver(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ];
}
