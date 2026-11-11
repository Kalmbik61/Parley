/**
 * Официальные команды установки для показа и копирования; проверены по ссылкам 2026-10-03. С 2026-11-11 установку из окна
 * запускает хост (`providers.install`), см. `INSTALL_CONFIRM` ниже и спеку 2026-11-11, §4.2.
 */
export const PROVIDER_INSTALL = {
  claude: {
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    docs: 'https://code.claude.com/docs/en/setup',
    login: '/login',
    loginDocs: 'https://code.claude.com/docs/en/authentication',
  },
  codex: {
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    docs: 'https://learn.chatgpt.com/docs/codex/cli',
    login: 'codex login',
    loginDocs: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login',
  },
} as const;

export const GLM_KEY_URL = 'https://z.ai/manage-apikey/apikey-list';

/**
 * Установка из окна (спека 2026-11-11, §4.2): что показывает подтверждение. Хост запускает константный argv из
 * `core/src/cli-tools.ts` и ничего из окна не берёт; здесь только тексты для человека.
 */
export const INSTALL_CONFIRM = {
  claude: {
    command: PROVIDER_INSTALL.claude.command,
    source: 'https://claude.ai/install.sh',
    profile: false,
  },
  codex: {
    command: PROVIDER_INSTALL.codex.command,
    source: 'https://chatgpt.com/codex/install.sh',
    profile: false,
  },
  qwen: {
    command:
      'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash -s -- --method standalone',
    source: 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh',
    // D3: установщик Qwen по умолчанию правит профиль оболочки.
    profile: true,
  },
} as const;

export type InstallableId = keyof typeof INSTALL_CONFIRM;

export function installableId(id: string): InstallableId | null {
  return id === 'claude' || id === 'codex' || id === 'qwen' ? id : null;
}

/** Обновление руками там, где хост ничего не запускает (спека §4.1): способ установки → команда. */
export function manualUpdateCommand(id: string, method: string | null): string | null {
  if (id !== 'qwen') return null;
  if (method === 'brew') return 'brew upgrade qwen-code';
  if (method === 'unknown') return 'npm install -g @qwen-code/qwen-code@latest';
  return null;
}
