/** Только показ/копирование официальных команд; проверены по ссылкам 2026-10-03. */
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
