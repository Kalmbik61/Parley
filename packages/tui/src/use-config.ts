/**
 * Настройки харнесса: `config.json` в `HARNAS_HOME` плюс `HARNAS_*`
 * (дизайн TUI v2, 3.4). Загрузчик живёт в core, здесь — чтение при старте и
 * запись из оверлея настроек (`prefix ,`, макет 4.14).
 *
 * Битый файл запуску не мешает: работают дефолты, а причина уезжает в строку
 * статуса обычным событием `⚑` (раздел 10, чек-лист 33).
 */

import {
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type HarnasConfig,
} from '@harnas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { withHome } from './format.js';
import { applyGlyphsConfig } from './glyphs.js';
import type { StatusEventInit } from './use-status.js';

export interface ConfigState {
  config: HarnasConfig;
  /** Ключи из окружения: файл их не перекроет, и оверлей показывает их тускло. */
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
  /** Пишет в файл и применяет; ошибка записи уезжает событием, состояние не меняется. */
  update: (patch: Partial<HarnasConfig>) => void;
}

export function useConfig(push: (events: readonly StatusEventInit[]) => void): ConfigState {
  const [config, setConfig] = useState<HarnasConfig>(DEFAULT_CONFIG);
  const [fromEnv, setFromEnv] = useState<ReadonlyArray<keyof HarnasConfig>>([]);
  // Колбэк через ссылку: его новый экземпляр не должен перечитывать файл.
  const notify = useRef(push);
  notify.current = push;

  useEffect(() => {
    let cancelled = false;
    void loadConfig()
      .then(({ config: loaded, warning, fromEnv: env }) => {
        if (cancelled) return;
        // Набор глифов берётся из тех же настроек, а не из окружения напрямую:
        // источник один (раздел 7). Ставим его до кадра, который их применит.
        applyGlyphsConfig(loaded.ascii);
        setConfig(loaded);
        setFromEnv(env);
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

  /**
   * Правка из оверлея: сначала файл, потом состояние — иначе кадр обещал бы то,
   * чего на диске нет. Файл не перечитывается: патч ложится на прежнее значение.
   */
  const update = useCallback((patch: Partial<HarnasConfig>) => {
    void saveConfig(patch)
      .then(() => {
        if (patch.ascii !== undefined) applyGlyphsConfig(patch.ascii);
        setConfig((previous) => ({ ...previous, ...patch }));
      })
      .catch((error: unknown) => {
        notify.current([
          {
            text: `${withHome(configPath())} не записался`,
            hint: error instanceof Error ? error.message : String(error),
          },
        ]);
      });
  }, []);

  return { config, fromEnv, update };
}
