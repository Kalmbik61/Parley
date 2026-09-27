import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Свой временный каталог проекта на каждый тест. Прежде спеки писали в фиксированные
 * `/tmp/harnas-e2e-<spec>`, и прогоны из разных рабочих деревьев чистили и заполняли один
 * и тот же проект одновременно — чужие работы попадали в сайдбар, и тесты падали.
 * `realpath`: на macOS `tmpdir()` лежит за символической ссылкой (`/var` → `/private/var`),
 * а путь проекта входит в ключи работ, которые тесты сверяют с окном.
 */
export async function makeTempProject(spec: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `harnas-e2e-${spec}-`)));
}
