/**
 * Цвет агента (спека доски комнаты 5.1): восемь тонов, номер — номер сессии `s-<N>` по модулю восемь. Цвет
 * не хранится нигде, а выводится из идентификатора — как цвет проекта (`project-color.ts`).
 */

export const AGENT_COLOUR_COUNT = 8;

/** Литеральные имена, не склейка: страж `tokens.test.ts` ищет ссылки на переменные в исходниках. */
const AGENT_COLOUR_VARS: readonly string[] = [
  'var(--agent-colour-0)',
  'var(--agent-colour-1)',
  'var(--agent-colour-2)',
  'var(--agent-colour-3)',
  'var(--agent-colour-4)',
  'var(--agent-colour-5)',
  'var(--agent-colour-6)',
  'var(--agent-colour-7)',
];

/** Номер цвета 0..7 по номеру сессии `s-<N>`; `null` — у любого другого идентификатора. */
export function agentColourIndex(sessionId: string | null | undefined): number | null {
  const match = sessionId == null ? null : /^s-(\d+)$/.exec(sessionId);
  if (match === null) return null;
  return Number(match[1]) % AGENT_COLOUR_COUNT;
}

/** `var(--agent-colour-3)` либо `null`, если цвета нет. */
export function agentColourVar(sessionId: string | null | undefined): string | null {
  const index = agentColourIndex(sessionId);
  return index === null ? null : (AGENT_COLOUR_VARS[index] as string);
}
