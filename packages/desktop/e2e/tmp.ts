import { appendFile, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Свой временный каталог проекта на каждый тест. Прежде спеки писали в фиксированные
 * `/tmp/parley-e2e-<spec>`, и прогоны из разных рабочих деревьев чистили и заполняли один
 * и тот же проект одновременно — чужие работы попадали в сайдбар, и тесты падали.
 * `realpath`: на macOS `tmpdir()` лежит за символической ссылкой (`/var` → `/private/var`),
 * а путь проекта входит в ключи работ, которые тесты сверяют с окном.
 */
export async function makeTempProject(spec: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `parley-e2e-${spec}-`)));
}

/** Список домов прогона — его читает уборка в конце (`global-setup.ts`). */
export const RUN_HOMES_ENV = 'HARNAS_E2E_RUN_HOMES';

/**
 * Свой `HARNAS_HOME` на каждый тест. Дом записывается в список прогона: если afterEach
 * упавшего теста не дошёл до `stopHost` (воркер снят по таймауту), хост этого дома погасит
 * уборка в конце прогона — и только его, домов других прогонов на машине она не знает.
 */
export async function makeTempHome(spec: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), `hh-e2e-${spec}-`));
  const list = process.env[RUN_HOMES_ENV];
  if (list !== undefined) await appendFile(list, `${home}\n`);
  return home;
}
