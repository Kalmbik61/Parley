/**
 * Точка входа скрипта `notify` Codex: `node <этот файл> <json>`, JSON события — последним
 * аргументом. Логика — в `codex-notify.ts`; здесь только argv и код выхода. Отдельным файлом, как
 * `statusline-bin.ts`: путь до скрипта может идти через ссылку, и проверка «запущен ли модуль как
 * главный» молча промолчала бы.
 *
 * Код выхода всегда 0: Codex запускает программу и про исход не спрашивает, stdin, stdout и stderr
 * у неё закрыты, поэтому и писать в них нечего.
 */

import { runCodexNotify } from './codex-notify.js';

await runCodexNotify(process.argv.at(-1) ?? '');
process.exit(0);
