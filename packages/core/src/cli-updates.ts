/**
 * Последняя версия CLI провайдера и способ его установки (спека 2026-11-02, обновление CLI из Parley).
 * Сеть берётся как параметр `fetchImpl`, чтобы тесты обходились без неё. Любая ошибка — `null`, без исключений
 * и без логов с телом ответа.
 */
import { CLI_TOOLS, LATEST_SOURCE_URLS, type CliInstallMethod, type CliLatestSource, type CliTool } from './cli-tools.js';

export type CliUpdateProvider = CliTool;
export type InstallMethod = CliInstallMethod;

/** Откуда спрашивать последнюю версию (таблица `cli-tools.ts`). */
export type LatestVersionSource = CliLatestSource;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Способ установки по настоящему пути исполняемого файла (после раскрытия ссылок); правила — в таблице. */
export function installMethod(
  provider: CliUpdateProvider,
  realBinary: string,
  home: string,
  exists: (path: string) => boolean = () => false,
): InstallMethod {
  return CLI_TOOLS[provider].installMethod(realBinary, home, exists);
}

/** Чистая версия `x.y.z` или `null` для пре-релизов и чужой формы. */
function cleanVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const version = raw.trim().replace(/^(rust-)?v/, '');
  return SEMVER.test(version) ? version : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Последняя версия из источника или `null`: сеть, таймаут, не-200, битый JSON, пре-релиз, чужая форма. */
export async function fetchLatestVersion(
  source: LatestVersionSource,
  fetchImpl: typeof fetch,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const response = await fetchImpl(LATEST_SOURCE_URLS[source.kind], {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return null;
    const body = asRecord(await response.json());
    if (body === null) return null;
    if (source.kind === 'codex-github') {
      if (body.prerelease === true) return null;
      return cleanVersion(body.tag_name);
    }
    if (source.kind === 'codex-brew') return cleanVersion(body.version);
    return cleanVersion(body[source.channel ?? 'latest']);
  } catch {
    return null;
  }
}

/** `latest` новее `installed`: оба строго `x.y.z`, пре-релизы и чужая форма — `false`. */
export function isNewer(installed: string, latest: string): boolean {
  const have = SEMVER.exec(installed.trim());
  const next = SEMVER.exec(latest.trim());
  if (have === null || next === null) return false;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(next[index]) - Number(have[index]);
    if (delta !== 0) return delta > 0;
  }
  return false;
}
