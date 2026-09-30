import { realpathSync } from 'node:fs';
import { appendFile, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Страж: дом теста лежит под `os.tmpdir()`. Его зовут `global-setup.ts` (дом прогона) и `makeTempHome`
 * (дом каждого теста). E2E поднимают настоящий хост и настоящее окно, и дом, выбранный по диску
 * (`PARLEY_HOME`/`HARNAS_HOME` не заданы — `~/.parley`, а если его нет, `~/.harnas`, R4), оказался бы
 * настоящими данными человека. `realpath` с обеих сторон: на macOS `tmpdir()` лежит за символической
 * ссылкой (`/var` → `/private/var`).
 */
export function assertUnderTmpdir(home: string): void {
  const base = realpathSync(tmpdir());
  const relative = path.relative(base, realpathSync(home));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`E2E окна: дом ${home} лежит вне ${base} — тест мог бы тронуть настоящие данные человека`);
  }
}

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
export const RUN_HOMES_ENV = 'PARLEY_E2E_RUN_HOMES';

/**
 * Свой `PARLEY_HOME` на каждый тест. Дом записывается в список прогона: если afterEach
 * упавшего теста не дошёл до `stopHost` (воркер снят по таймауту), хост этого дома погасит
 * уборка в конце прогона — и только его, домов других прогонов на машине она не знает.
 */
export async function makeTempHome(spec: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), `hh-e2e-${spec}-`));
  assertUnderTmpdir(home);
  const list = process.env[RUN_HOMES_ENV];
  if (list !== undefined) await appendFile(list, `${home}\n`);
  return home;
}
