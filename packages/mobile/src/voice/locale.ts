/** Выбор распознавателя по языку (спека 2.3): чистые функции, без платформы. */

/** `ru-RU`, `en`, `zh-Hans-CN`; не `emoji` и не `dictation` (так клавиатура называет свои режимы). */
export function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(value);
}

const PREFERRED: Record<string, string> = { en: 'en-US', es: 'es-ES', pt: 'pt-BR' };

export function localeCandidates(tag: string, supported: readonly string[]): string[] {
  if (!isLanguageTag(tag)) return [];
  const parts = tag.replace(/_/g, '-').split('-');
  const language = (parts[0] ?? '').toLowerCase();
  const script = parts.slice(1).find((p) => /^[A-Za-z]{4}$/.test(p));
  const region = parts.slice(1).find((p) => /^([A-Za-z]{2}|\d{3})$/.test(p))?.toUpperCase();
  const byKey = new Map(supported.map((s) => [s.replace(/_/g, '-').toLowerCase(), s.replace(/_/g, '-')]));
  const wanted: string[] = [tag.replace(/_/g, '-')];
  if (region !== undefined) wanted.push(`${language}-${region}`);
  wanted.push(`${language}-${language.toUpperCase()}`);
  if (language === 'zh') {
    const s = script?.toLowerCase();
    if (s === 'hans' || region === 'CN' || region === 'SG') wanted.push('zh-CN');
    else if (s === 'hant' || region === 'TW') wanted.push('zh-TW');
    if (region === 'HK') wanted.push('zh-HK');
  } else if (PREFERRED[language] !== undefined) {
    wanted.push(PREFERRED[language]);
  }
  const out: string[] = [];
  const add = (id: string | undefined): void => {
    if (id !== undefined && !out.includes(id)) out.push(id);
  };
  for (const w of wanted) add(byKey.get(w.toLowerCase()));
  if (language !== 'zh') {
    const same = [...byKey.values()].filter((s) => s.toLowerCase().startsWith(`${language}-`)).sort();
    for (const s of same) add(s);
  }
  return out;
}
