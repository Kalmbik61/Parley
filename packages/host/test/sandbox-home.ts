/**
 * Песочница домашней папки на весь тестовый процесс — тот же приём, что и в
 * `packages/tui/test/sandbox-home.ts` (жёсткое правило: тесты не читают и не
 * пишут в настоящие `~/.parley`, `~/.harnas` и `~/.claude`).
 *
 * Кусок 1.5 завёл первого потребителя `defaultRoot()`/`defaultCodexRoot()` в
 * хосте (`activity/log-index.ts`): без песочницы тест, не задавший свои корни,
 * читал бы настоящую историю Claude Code — сотни мегабайт и больше — и хост
 * заодно пытался бы привязать (`linkSession`) сессии к ней.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const running = process.env['PARLEY_TEST_HOME'];
// Файлов тестов много, а каталог нужен один на процесс: имя живёт в окружении.
const home = running ?? mkdtempSync(path.join(tmpdir(), 'parley-host-test-home-'));

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

// Хост, который тест поднимает отдельным процессом (`tsx main.ts` в `host.test.ts`), на старте
// спрашивает у провайдеров версию (`<команда> --version`). Настоящие claude и codex в тестах
// запускать нельзя даже с `--version`: пробу отключает переменная, её наследуют дочерние процессы.
// Тесты самой пробы зовут `probeCliVersion` на выдуманную команду или подсовывают `probeVersion`.
process.env['PARLEY_SKIP_VERSION_PROBE'] = '1';

// Умолчания хоста с 2026-11-01: сон простоя 60 мин и потолок машины `auto` (75 % памяти в ГиБ). Тестам нужен прежний
// детерминизм: потолок `auto` зависит от памяти машины (5 на CI с 7 ГиБ, 12 на ноутбуке с 16), а сон срабатывает
// от часов. Закрепляем выключенное состояние одним местом; тесты сна и потолка задают свои значения в конфиге сервиса
// или переменной окружения сами. Ни один тест хоста не пишет эти два ключа через `settings.set`, так что замок
// переменной ничему не мешает.
process.env['PARLEY_SLEEP_AFTER_MINUTES'] = '0';
process.env['PARLEY_MACHINE_CONCURRENT'] = 'off';
