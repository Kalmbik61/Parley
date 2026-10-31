// Small Markdown parser for model replies and plans (D1 §9.3). No HTML and no remote images: raw HTML is shown as text
// with its tags removed, and an image never becomes anything that loads (`image` carries only the host to show).
export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold'; children: Inline[] }
  | { t: 'italic'; children: Inline[] }
  | { t: 'code'; text: string }
  | { t: 'link'; url: string; children: Inline[] }
  /** A placeholder line "Image not loaded · example.com". */
  | { t: 'image'; host: string | null };

export type Block =
  | { t: 'paragraph'; inline: Inline[] }
  | { t: 'heading'; level: number; inline: Inline[] }
  | { t: 'code'; lang: string | null; text: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'rule' };

/**
 * Strict shape of a link we will open: `http(s)://host[:port][/path…]` with no userinfo, no backslash and no whitespace.
 * `https://evil.com\@good.com/` is read differently by the dialog and by Safari (WHATWG treats `\` as `/`), so such
 * links are refused outright and shown as text.
 */
const SAFE_URL = /^https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i;

export function hostOf(url: string): string | null {
  const m = SAFE_URL.exec(url.trim());
  if (m !== null) return m[1]!.toLowerCase();
  // Placeholder text for an image: the host of any URL-looking string, same rules.
  const loose = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#\\\s]*@)?([^/?#@\\\s:]+)/i.exec(url.trim());
  return loose?.[1]?.toLowerCase() ?? null;
}

/** Only strict `http(s)` links open (after a confirmation); anything else renders as plain text. */
export function isOpenableUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

const stripTags = (s: string): string => s.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '');

const pushText = (out: Inline[], text: string): void => {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last?.t === 'text') last.text += text;
  else out.push({ t: 'text', text });
};

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  // `<img src="…">` and any other tag: an img leaves the placeholder, the rest is dropped.
  let s = src.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)[^>]*>/gi, (_m, url: string) => `\uE000IMG:${url}\uE000`);
  s = stripTags(s);
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\uE000IMG:([^\uE000]*)\uE000/.exec(rest))) {
      out.push({ t: 'image', host: hostOf(m[1]!) });
      i += m[0].length;
    } else if ((m = /^!\[[^\]]*\]\(([^)\s]*)[^)]*\)/.exec(rest))) {
      out.push({ t: 'image', host: hostOf(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/.exec(rest))) {
      const children = parseInline(m[1]!);
      if (isOpenableUrl(m[2]!)) out.push({ t: 'link', url: m[2]!.trim(), children });
      else out.push(...children);
      i += m[0].length;
    } else if ((m = /^`([^`\n]+)`/.exec(rest))) {
      out.push({ t: 'code', text: m[1]! });
      i += m[0].length;
    } else if ((m = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest))) {
      out.push({ t: 'bold', children: parseInline(m[2]!) });
      i += m[0].length;
    } else if ((m = /^([*_])(?=\S)([^*_\n]+?)(?<=\S)\1/.exec(rest))) {
      out.push({ t: 'italic', children: parseInline(m[2]!) });
      i += m[0].length;
    } else if ((m = /^https?:\/\/[^\s<>)]+/i.exec(rest))) {
      if (isOpenableUrl(m[0])) out.push({ t: 'link', url: m[0], children: [{ t: 'text', text: m[0] }] });
      else pushText(out, m[0]);
      i += m[0].length;
    } else {
      pushText(out, s[i]!);
      i += 1;
    }
  }
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string): boolean => /^(```|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^```\s*([\w+-]*)/.exec(line))) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ t: 'code', lang: m[1] === '' ? null : m[1]!, text: body.join('\n') });
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blocks.push({ t: 'heading', level: m[1]!.length, inline: parseInline(m[2]!.replace(/\s#+\s*$/, '')) });
      i++;
    } else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ t: 'rule' });
      i++;
    } else if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', blocks: parseMarkdown(body.join('\n')) });
    } else if ((m = /^([-*+]|\d+[.)])\s+/.exec(line))) {
      const ordered = /\d/.test(m[1]!);
      const items: Inline[][] = [];
      while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        let text = lines[i++]!.replace(/^([-*+]|\d+[.)])\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !startsBlock(lines[i]!.trim())) text += ' ' + lines[i++]!.trim();
        items.push(parseInline(text));
      }
      blocks.push({ t: 'list', ordered, items });
    } else {
      const body = [line];
      i++;
      while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ t: 'paragraph', inline: parseInline(body.join(' ')) });
    }
  }
  return blocks;
}
