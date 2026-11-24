/**
 * Корень песочниц дома на весь прогон vitest: `globalSetup`, исполняется в главном процессе.
 *
 * Каждый файл тестов идёт в своём дочернем процессе (пул `forks`, умолчание vitest), и `sandbox-home.ts` создаёт
 * ему временный дом. Закончив файл, vitest гасит процесс сигналом SIGTERM, а при смерти от сигнала
 * `process.on('exit')` не срабатывает: уборка дома, привязанная к этому событию, не шла никогда, и во временной
 * папке оставалось по каталогу на каждый файл каждого прогона. Поэтому дома создаются внутри этого корня, а
 * убирает его главный процесс, когда прогон окончен.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    parleyTestHomeRoot?: string;
  }
}

export default function setup({ provide }: GlobalSetupContext): () => void {
  // Имя короткое намеренно: путь дома внутри корня (`parley-th-XXXXXX/XXXXXX`) не длиннее прежнего
  // (`parley-test-home-XXXXXX`), так что тесты, чувствительные к длине пути, перемены не заметят.
  const root = mkdtempSync(path.join(tmpdir(), 'parley-th-'));
  provide('parleyTestHomeRoot', root);
  return () => {
    // Уборка не должна ронять прогон: исключение отсюда срывает закрытие vitest (пул и серверы остаются висеть).
    // Дочерний процесс теста, переживший свой файл, может ещё писать в дом — тогда каталог остаётся.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Остаток во временной папке лучше упавшего прогона.
    }
  };
}
