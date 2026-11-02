/**
 * Последняя версия CLI провайдера и способ его установки (спека 2026-11-02, обновление CLI из Parley).
 * Сеть берётся как параметр `fetchImpl`, чтобы тесты обходились без неё. Любая ошибка — `null`, без исключений
 * и без логов с телом ответа.
 */
export type CliUpdateProvider = 'codex' | 'claude';
export type InstallMethod = 'standalone' | 'npm' | 'brew' | 'native' | 'unknown';

/** Откуда спрашивать последнюю версию. */
export type LatestVersionSource =
  | { kind: 'codex-github' }
  | { kind: 'codex-brew' }
  /** `channel` — ключ в `dist-tags` (`latest` по умолчанию). */
  | { kind: 'claude-npm'; channel?: string };

const SOURCE_URLS = {
  'codex-github': 'https://api.github.com/repos/openai/codex/releases/latest',
  'codex-brew': 'https://formulae.brew.sh/api/cask/codex.json',
  'claude-npm': 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags',
} as const;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Способ установки по настоящему пути исполняемого файла (после раскрытия ссылок). */
export function installMethod(provider: CliUpdateProvider, realBinary: string, home: string): InstallMethod {
  const path = realBinary.replaceAll('\\', '/');
  const root = home.replaceAll('\\', '/').replace(/\/+$/, '');
  if (provider === 'codex') {
    if (path.includes('/node_modules/@openai/codex/')) return 'npm';
    if (path.startsWith(`${root}/.codex/packages/standalone/`)) return 'standalone';
    if (path.includes('/Caskroom/') || path.startsWith('/opt/homebrew/')) return 'brew';
    return 'unknown';
  }
  if (path.includes('/node_modules/@anthropic-ai/claude-code/')) return 'npm';
  if (path.startsWith(`${root}/.local/share/claude/versions/`)) return 'native';
  return 'unknown';
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
    const response = await fetchImpl(SOURCE_URLS[source.kind], {
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
