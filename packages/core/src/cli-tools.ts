/**
 * Таблица дескрипторов CLI провайдеров (спека 2026-11-11, §4.1): источник последней версии, правила способа
 * установки, план обновления, план установки, разрешённые хосты редиректа, ожидаемый бинарь и проба. Только данные
 * и чистые функции: ни сети, ни файловой системы (наличие пути приходит параметром `exists`).
 */
export type CliTool = 'claude' | 'codex' | 'qwen';
export type CliInstallMethod = 'standalone' | 'npm' | 'brew' | 'native' | 'unknown';
export type CliPlatform = 'posix' | 'win32';

/** Откуда спрашивать последнюю версию. */
export type CliLatestSource =
  | { kind: 'codex-github' }
  | { kind: 'codex-brew' }
  /** `channel` — ключ в `dist-tags` (`latest` по умолчанию). */
  | { kind: 'claude-npm'; channel?: string }
  | { kind: 'qwen-npm'; channel?: string };

export type CliUpdatePlan =
  /** `<бинарь> <args…>`. */
  | { kind: 'run'; args: readonly string[] }
  /** Обновление через npm той установки, которую запускает Parley (спека §4.3). */
  | { kind: 'npm-bound'; packageSpec: string; manualCommand: string }
  /** Хост ничего не запускает, человеку показывается команда. */
  | { kind: 'manual'; manualCommand: string };

export interface CliInstallPlan {
  /** Константный HTTPS-адрес установщика. */
  url: string;
  /** Интерпретатор скрипта. */
  interpreter: readonly string[];
  /** Константные аргументы после файла скрипта. */
  args: readonly string[];
  /** Хосты, на которые разрешён редирект (только HTTPS); хост самого адреса разрешён всегда. */
  redirectHosts: readonly string[];
}

export interface CliDescriptor {
  tool: CliTool;
  latest: CliLatestSource;
  /** Ожидаемый бинарь после установки, относительно домашней папки. */
  expectedBinary: string;
  /** Проба после установки или обновления. */
  smokeArgs: readonly string[];
  /** Установка из Parley на macOS и Linux; на Windows — только команда для копирования. */
  install: CliInstallPlan;
  installMethod(realBinary: string, home: string, exists: (path: string) => boolean): CliInstallMethod;
  updatePlan(method: CliInstallMethod): CliUpdatePlan;
}

export const LATEST_SOURCE_URLS = {
  'codex-github': 'https://api.github.com/repos/openai/codex/releases/latest',
  'codex-brew': 'https://formulae.brew.sh/api/cask/codex.json',
  'claude-npm': 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags',
  'qwen-npm': 'https://registry.npmjs.org/-/package/@qwen-code/qwen-code/dist-tags',
} as const;

function norm(value: string): string {
  return value.replaceAll('\\', '/');
}

function homeRoot(home: string): string {
  return norm(home).replace(/\/+$/, '');
}

const claude: CliDescriptor = {
  tool: 'claude',
  latest: { kind: 'claude-npm' },
  expectedBinary: '.local/bin/claude',
  smokeArgs: ['--version'],
  install: {
    url: 'https://claude.ai/install.sh',
    interpreter: ['/bin/bash', '--noprofile', '--norc'],
    args: [],
    // Наблюдалось 2026-11-11: 302 → downloads.claude.ai/claude-code-releases/bootstrap.sh (200).
    redirectHosts: ['downloads.claude.ai'],
  },
  installMethod(realBinary, home) {
    const path = norm(realBinary);
    if (path.includes('/node_modules/@anthropic-ai/claude-code/')) return 'npm';
    if (path.startsWith(`${homeRoot(home)}/.local/share/claude/versions/`)) return 'native';
    return 'unknown';
  },
  updatePlan(method) {
    if (method === 'unknown') return { kind: 'manual', manualCommand: 'claude update' };
    return { kind: 'run', args: ['update'] };
  },
};

const codex: CliDescriptor = {
  tool: 'codex',
  latest: { kind: 'codex-github' },
  expectedBinary: '.local/bin/codex',
  smokeArgs: ['-c', 'check_for_update_on_startup=false', '--version'],
  install: {
    url: 'https://chatgpt.com/codex/install.sh',
    interpreter: ['/bin/sh'],
    args: [],
    // Наблюдалось 2026-11-11: 302 → releases.openai.com/codex/install.sh (HEAD дальше отвечает 403).
    redirectHosts: ['releases.openai.com'],
  },
  installMethod(realBinary, home) {
    const path = norm(realBinary);
    if (path.includes('/node_modules/@openai/codex/')) return 'npm';
    if (path.startsWith(`${homeRoot(home)}/.codex/packages/standalone/`)) return 'standalone';
    if (path.includes('/Caskroom/') || path.startsWith('/opt/homebrew/')) return 'brew';
    return 'unknown';
  },
  updatePlan(method) {
    if (method === 'unknown') return { kind: 'manual', manualCommand: 'codex update' };
    return { kind: 'run', args: ['update'] };
  },
};

const QWEN_NPM_COMMAND = 'npm install -g @qwen-code/qwen-code@latest';

const qwen: CliDescriptor = {
  tool: 'qwen',
  latest: { kind: 'qwen-npm' },
  expectedBinary: '.local/bin/qwen',
  smokeArgs: ['--version'],
  install: {
    url: 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh',
    interpreter: ['/bin/bash', '--noprofile', '--norc'],
    // D2: автономная установка без отката на npm; D3: правка профиля оболочки разрешена (без `--no-modify-path`).
    args: ['--method', 'standalone'],
    // Наблюдалось 2026-11-11: 200 без редиректа.
    redirectHosts: [],
  },
  installMethod(realBinary, home, exists) {
    const path = norm(realBinary);
    const root = homeRoot(home);
    if (path.includes('/node_modules/@qwen-code/qwen-code/')) return 'npm';
    if (path.startsWith(`${root}/.local/lib/qwen-code/`)) return 'standalone';
    // Обёртка автономной установки: настоящий путь — сам скрипт; признак — рядом лежит папка библиотеки.
    if (path === `${root}/.local/bin/qwen` && exists(`${root}/.local/lib/qwen-code`)) return 'standalone';
    if (path.includes('/Cellar/qwen-code/') || path.startsWith('/opt/homebrew/') || path.startsWith('/home/linuxbrew/.linuxbrew/')) {
      return 'brew';
    }
    return 'unknown';
  },
  updatePlan(method) {
    if (method === 'standalone') return { kind: 'run', args: ['update'] };
    if (method === 'npm') return { kind: 'npm-bound', packageSpec: '@qwen-code/qwen-code@latest', manualCommand: QWEN_NPM_COMMAND };
    if (method === 'brew') return { kind: 'manual', manualCommand: 'brew upgrade qwen-code' };
    return { kind: 'manual', manualCommand: QWEN_NPM_COMMAND };
  },
};

export const CLI_TOOLS: Readonly<Record<CliTool, CliDescriptor>> = { claude, codex, qwen };
