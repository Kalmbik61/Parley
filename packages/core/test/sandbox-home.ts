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
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    parleyTestHomeRoot?: string;
  }
}

const running = process.env['PARLEY_TEST_HOME'];
// Корень прогона создаёт и убирает главный процесс (`sandbox-home-root.ts`): здесь `exit` не наступает, vitest гасит
// процесс файла сигналом. Без корня (конфиг без `globalSetup`) дом ложится прямо во временную папку, как прежде.
const root = inject('parleyTestHomeRoot');
// Файлов тестов много, а каталог нужен один на процесс: имя живёт в окружении.
const home = running ?? mkdtempSync(root === undefined ? path.join(tmpdir(), 'parley-test-home-') : root + path.sep);

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

// Запуск Claude в папке с записью в `trust.json` пишет в файл состояния профиля (`claude-trust.ts`): унаследованная
// `CLAUDE_CONFIG_DIR` направила бы эту запись в настоящий профиль человека. Свою папку тест ставит сам.
delete process.env['CLAUDE_CONFIG_DIR'];
