/**
 * Песочница домашней папки на весь тестовый процесс — тот же приём, что и в
 * `packages/tui/test/sandbox-home.ts` (жёсткое правило: тесты не читают и не
 * пишут в настоящие `~/.harnas` и `~/.claude`).
 *
 * Кусок 1.5 завёл первого потребителя `defaultRoot()`/`defaultCodexRoot()` в
 * хосте (`activity/log-index.ts`): без песочницы тест, не задавший свои корни,
 * читал бы настоящую историю Claude Code — сотни мегабайт и больше — и хост
 * заодно пытался бы привязать (`linkSession`) сессии к ней.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const running = process.env['HARNAS_TEST_HOME'];
// Файлов тестов много, а каталог нужен один на процесс: имя живёт в окружении.
const home = running ?? mkdtempSync(path.join(tmpdir(), 'harnas-host-test-home-'));

if (running === undefined) {
  process.env['HARNAS_TEST_HOME'] = home;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}

process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
