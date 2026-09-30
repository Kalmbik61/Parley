/**
 * Песочница домашней папки на весь тестовый процесс (жёсткое правило: тесты не
 * пишут в настоящие `~/.parley`, `~/.harnas` и `~/.claude`).
 *
 * Свой `PARLEY_HOME` тест ставит сам и снимает его в `afterEach`, но запись из
 * ещё не досчитанного промиса или из живого дочернего процесса случается уже
 * после этого — и уходила бы в настоящий дом. Здесь подменяется сам `HOME`,
 * поэтому запасной путь (`~/.parley`, `~/.harnas`) тоже временный.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const running = process.env['PARLEY_TEST_HOME'];
// Файлов тестов много, а каталог нужен один на процесс: имя живёт в окружении.
const home = running ?? mkdtempSync(path.join(tmpdir(), 'parley-test-home-'));

if (running === undefined) {
  process.env['PARLEY_TEST_HOME'] = home;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}

process.env['HOME'] = home;
process.env['USERPROFILE'] = home;

// Дом, унаследованный от родителя, главнее `HOME`: хост Parley экспортирует агентам оба имени (`PARLEY_HOME` и
// прежнее `HARNAS_HOME`), а тесты гонят и из сессии такого агента. Свой `PARLEY_HOME` тест ставит и снимает сам,
// и после его `afterEach` запасным становился бы унаследованный дом, то есть настоящий `~/.parley` или `~/.harnas`.
delete process.env['PARLEY_HOME'];
delete process.env['HARNAS_HOME'];
