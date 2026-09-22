/**
 * Уровень цвета темы в тестах — отдельная величина от `chalk.level` (дизайн
 * темы TUI, 7.1): он неизвестен заранее (локальный терминал, CI), и если бы
 * совпал с уровнем темы 0 или 3, `lastFrame()` увидел бы непредсказуемый
 * набор пропсов и кадры тестов разъехались бы. `pinTheme` фиксирует уровень
 * явно, по образцу `pinUnicodeGlyphs` (`test/glyphs-env.ts`).
 *
 * Общий уровень для всего набора — 1 (роли отдают имена ANSI, заливки нет,
 * кадр совпадает с сегодняшним знак в знак): этот модуль ставит его в общем
 * `setupFiles`. Тесту нужна заливка — ставит `pinTheme(3)` поверх (с
 * `FORCE_COLOR=3`); тесту нужен монохром — `pinTheme(0)`.
 *
 * Импорт `theme/index.ts` (а с ним и `chalk`) — динамический и только внутри
 * хуков, а не статический наверху: `chalk` решает про цвет при первой
 * загрузке модуля (`terminal-view.test.tsx`, `sidebar-selection.test.tsx`
 * ставят `FORCE_COLOR` до импорта Ink и chalk по той же причине). Этот файл
 * стоит в общем `setupFiles` и грузится раньше самого файла теста — статический
 * импорт chalk здесь занял бы модульный кэш до того, как тест успеет
 * выставить `FORCE_COLOR`, и его собственный `FORCE_COLOR` больше не подействовал
 * бы на уже загруженный chalk.
 */

import { afterEach, beforeEach } from 'vitest';

async function apply(name: string, level?: number): Promise<void> {
  const { applyThemeConfig } = await import('../src/theme/index.js');
  applyThemeConfig(name, level);
}

export function pinTheme(level: number): void {
  beforeEach(() => apply('mocha', level));
  afterEach(() => apply('mocha'));
}

pinTheme(1);
