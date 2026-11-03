// DEVELOPER BUILD ONLY: Markdown for the A40 screenshots (route `/md?case=…`, `PARLEY_MOBILE_DEV_ROUTE=md-table|md-table-scrolled|md-code|md-path|md-lists|md-images|md-all|md-feed`)
// and the agent reply in the demo chat. HUMAN_TABLE is the text from the human's iPhone, verbatim (a test compares it with the fixture file).
export const HUMAN_TABLE = `В глобальном конфиге \`~/.claude.json\` (верхний уровень \`mcpServers\`) осталось три MCP-сервера:

| Сервер | Как запускается | Статус |
|---|---|---|
| \`MCP_DOCKER\` | \`docker mcp gateway run\` | подключён |
| \`21st-dev-magic\` | \`npx -y @21st-dev/magic@latest\` | не подключился: нет API-ключа |
| \`pencil\` | локальный бинарник \`~/.pencil/mcp/...\` | подключён |

Других глобальных серверов в \`~/.claude/settings.json\` нет. В \`settings.local.json\` есть только список разрешённых: \`chrome-devtools\`, \`context7\`, \`Ref\`, \`figma\`. Сами их определения лежат в \`.mcp.json\` проекта или в плагинах.

Плагины тоже поставляют MCP-серверы (\`.mcp.json\` в \`~/.claude/plugins/\`): \`oh-my-claudecode\`, а также из официального маркетплейса \`context7\`, \`playwright\`, \`github\`, \`gitlab\`, \`linear\`, \`serena\`, \`firebase\`.`;

export const NESTED_LISTS = `## Plan

1. Prepare
   - [x] read the spec
   - [ ] write the parser
     - [x] tables
     - [ ] task items
   - plain item with **bold** and \`code\`
2. Build
   * nested star
     1. deep one
     2. deep two
3. Ship

> Quote with a list:
> - first
> - second with @s-02

Mention @s-02 and @human here.`;

export const CODE_BLOCK = `A code block with a language:

\`\`\`ts
export function parseMarkdown(text: string): MdNode {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return tree as unknown as MdNode; // a very long line to scroll sideways ................................
}
\`\`\`

And one without.

\`\`\`
pnpm lint && pnpm -r build
\`\`\``;

export const LONG_PATH = `The plugin lives in \`/Users/me/.claude/plugins/cache/oh-my-claudecode/oh-my-claudecode/4.13.4/skills/deep-interview/SKILL.md\` and the package is \`oh-my-claudecode\`, started with \`npx -y @21st-dev/magic@latest --flag-with-hyphens\` today.`;

export const IMAGES_AND_LINKS = `An image with alt text: ![Approve: drop the prod DB](https://tracker.example.com/p.png "title")

An image without alt: ![](https://tracker.example.com/pixel.gif)

An empty label: [](https://evil.example/x) and a reference [][r] and [a link](https://example.com/ok) and [bad](javascript:alert(1)).

[r]: https://example.org/ref`;

export const MD_CASES: Record<string, string> = {
  table: HUMAN_TABLE,
  code: CODE_BLOCK,
  path: LONG_PATH,
  lists: NESTED_LISTS,
  images: IMAGES_AND_LINKS,
  all: [HUMAN_TABLE, NESTED_LISTS, CODE_BLOCK, LONG_PATH].join('\n\n---\n\n'),
};
