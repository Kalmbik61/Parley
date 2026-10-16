/**
 * Правила «Allow and don't ask again» из `permission_suggestions` хука: `addRules` → `Tool(content)`. `null` — правил
 * нет, кнопку не показывать. Отдельным модулем: им пользуются карточка ленты и остров, а модуль карточки тянет за
 * собой окружение ленты (`chat-env`).
 */
export function alwaysRules(suggestions: readonly unknown[]): string[] | null {
  const rules: string[] = [];
  let found = false;
  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'object' || suggestion === null) continue;
    const entry = suggestion as { type?: unknown; rules?: unknown };
    if (entry.type !== 'addRules') continue;
    found = true;
    if (!Array.isArray(entry.rules)) continue;
    for (const rule of entry.rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { toolName, ruleContent } = rule as { toolName?: unknown; ruleContent?: unknown };
      if (typeof toolName !== 'string') continue;
      rules.push(typeof ruleContent === 'string' && ruleContent !== '' ? `${toolName}(${ruleContent})` : toolName);
    }
  }
  return found ? rules : null;
}
