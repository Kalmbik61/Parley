import { readFileSync } from 'node:fs';

/**
 * Версия хоста — поле `version` его `package.json`. Файл лежит на уровень выше `src/` и `dist/` и
 * едет вместе с хостом в `Resources/host` собранного окна, так что строка статуса (`Host 0.1.0`)
 * идёт за релизной версией пакета, а руками её нигде не правят. Нет файла или поля — `unknown`:
 * так окно называет версию хоста, приславшего ответ без неё.
 */
export function readHostVersion(
  packageJson: URL = new URL('../package.json', import.meta.url),
): string {
  try {
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
