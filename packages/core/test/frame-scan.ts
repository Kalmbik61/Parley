/**
 * Правила рамочного теста (спека 14.4, юридическая рамка 15.1) — что не должно
 * попасть в исходники окна и хоста ни в каком виде: учётные данные агентов,
 * запись в их каталоги настроек, обращения к API провайдеров напрямую и
 * YOLO-флаги. Список плоский, а не по категориям: находка называет ровно то
 * правило, которое сработало.
 */

export interface FrameHit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

export const FRAME_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  {
    rule: 'учётные данные агентов',
    pattern: /\.credentials\.json|Claude Code-credentials|find-generic-password|codex\/auth\.json/,
  },
  {
    rule: 'запись в каталоги агентов',
    pattern: /\.claude\/settings\.json|\.claude\.json|\.codex\/config\.toml/,
  },
  {
    rule: 'API провайдеров',
    pattern: /api\.anthropic\.com|chatgpt\.com\/backend-api/,
  },
  {
    rule: 'YOLO-флаги',
    pattern:
      /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|bypassPermissions/,
  },
];

/** Строка-комментарий (`//`, начало `/*`, продолжение блока `` * ``) — рамка её не проверяет (спека 14.4). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

/** Проверяет исходник построчно; строки-комментарии пропускаются. */
export function scanSource(file: string, source: string): FrameHit[] {
  const hits: FrameHit[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || isCommentLine(line)) continue;
    for (const { rule, pattern } of FRAME_RULES) {
      if (pattern.test(line)) hits.push({ file, line: index + 1, rule, text: line.trim() });
    }
  }
  return hits;
}
