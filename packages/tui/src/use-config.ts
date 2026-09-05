/**
 * Настройки харнесса: `config.json` в `HARNAS_HOME` плюс `HARNAS_*`
 * (дизайн TUI v2, 3.4). Загрузчик живёт в core, здесь только чтение при старте.
 *
 * Битый файл запуску не мешает: работают дефолты, а причина уезжает в строку
 * статуса обычным событием `⚑` (раздел 10, чек-лист 33).
 */

import { configPath, DEFAULT_CONFIG, loadConfig, type HarnasConfig } from '@harnas/core';
import { useEffect, useRef, useState } from 'react';
import { withHome } from './format.js';
import { applyGlyphsConfig } from './glyphs.js';
import type { StatusEventInit } from './use-status.js';

export function useConfig(push: (events: readonly StatusEventInit[]) => void): HarnasConfig {
  const [config, setConfig] = useState<HarnasConfig>(DEFAULT_CONFIG);
  // Колбэк через ссылку: его новый экземпляр не должен перечитывать файл.
  const notify = useRef(push);
  notify.current = push;

  useEffect(() => {
    let cancelled = false;
    void loadConfig()
      .then(({ config: loaded, warning }) => {
        if (cancelled) return;
        // Набор глифов берётся из тех же настроек, а не из окружения напрямую:
        // источник один (раздел 7). Ставим его до кадра, который их применит.
        applyGlyphsConfig(loaded.ascii);
        setConfig(loaded);
        if (warning === null) return;
        notify.current([
          { text: `${withHome(configPath())} не читается — работаю с дефолтами`, hint: warning },
        ]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
