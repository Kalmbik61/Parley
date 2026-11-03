В глобальном конфиге `~/.claude.json` (верхний уровень `mcpServers`) осталось три MCP-сервера:

| Сервер | Как запускается | Статус |
|---|---|---|
| `MCP_DOCKER` | `docker mcp gateway run` | подключён |
| `21st-dev-magic` | `npx -y @21st-dev/magic@latest` | не подключился: нет API-ключа |
| `pencil` | локальный бинарник `~/.pencil/mcp/...` | подключён |

Других глобальных серверов в `~/.claude/settings.json` нет. В `settings.local.json` есть только список разрешённых: `chrome-devtools`, `context7`, `Ref`, `figma`. Сами их определения лежат в `.mcp.json` проекта или в плагинах.

Плагины тоже поставляют MCP-серверы (`.mcp.json` в `~/.claude/plugins/`): `oh-my-claudecode`, а также из официального маркетплейса `context7`, `playwright`, `github`, `gitlab`, `linear`, `serena`, `firebase`.
