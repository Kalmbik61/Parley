// Keep the original text so editing and routing use the same offsets and codes.
export function tokenizeMentions(text, sessions) {
  const known = new Map(
    sessions.map((session) => [session.code.toLowerCase(), session]),
  );
  const tokens = [];
  const pattern = /(^|[\s([{])@(S\d+)(?=$|[\s)\]},:;!?]|\.(?=\s|$))/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const session = known.get(match[2].toLowerCase());
    if (!session) continue;
    const start = match.index + match[1].length;
    if (start > cursor) tokens.push({ text: text.slice(cursor, start) });
    cursor = start + match[2].length + 1;
    tokens.push({ text: text.slice(start, cursor), session });
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

export function mentionedSessions(text, sessions) {
  const ids = new Set(
    tokenizeMentions(text, sessions).flatMap((token) =>
      token.session ? [token.session.id] : [],
    ),
  );
  return sessions.filter((session) => ids.has(session.id));
}
