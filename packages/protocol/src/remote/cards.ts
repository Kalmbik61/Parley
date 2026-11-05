// Карточки помощника на телефоне (план телефонного голоса, T4a): параметры `cards.list`, проекция карточки для телефона
// и событие `cards.changed`. Имена не под `assistant.*`: тот префикс остаётся запрещённым, телефон видит только проекцию.
import { z } from 'zod';

/** `cards.list`: без параметров; `strict` — лишний ключ даёт `bad_request`. */
export const cardsMethodSchemas = {
  'cards.list': z.strictObject({}),
} as const;

export const cardsParamRules: Readonly<Record<string, (params: unknown) => boolean>> = Object.fromEntries(
  Object.entries(cardsMethodSchemas).map(([method, schema]) => [method, (params: unknown): boolean => schema.safeParse(params).success]),
);

export const PHONE_CARD_TITLE_MAX = 120;
export const PHONE_CARD_TEXT_MAX = 280;

const cardState = z.enum(['needs_confirmation', 'decided', 'expired', 'superseded']);

/**
 * Карточка так, как её видит телефон: без `payload`, путей, `argv`, токенов и `decidedVia`. Схема не `strict`
 * намеренно: проекция берёт поля по именам, лишнее отбрасывается ею.
 */
export const phoneCardSchema = z.object({
  cardId: z.string(),
  revision: z.number().int().nonnegative(),
  kind: z.string(),
  state: cardState,
  title: z.string().max(PHONE_CARD_TITLE_MAX),
  text: z.string().max(PHONE_CARD_TEXT_MAX),
  dangerous: z.boolean(),
  expiresAt: z.number(),
  jobId: z.string().optional(),
});
export type PhoneCard = z.infer<typeof phoneCardSchema>;

/** Обрезка по кодовым точкам с «…» в пределах `max` знаков. */
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Проекция карточки для телефона по явному списку полей. Вход — то, что собрал хост: `cardId`, `revision`, `kind`,
 * `state`, `view` (вид карточки для окна), `expiresAt` и, если карточка принадлежит job, `jobId`. Не карточка — `null`.
 */
export function projectPhoneCard(raw: unknown): PhoneCard | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const view = typeof c.view === 'object' && c.view !== null ? (c.view as Record<string, unknown>) : {};
  const steps = Array.isArray(view.steps) ? view.steps : [];
  const dangerous = steps.some((step) => typeof step === 'object' && step !== null && (step as { danger?: unknown }).danger === true);
  const title = [str(view.target), str(view.where)].filter((part) => part.length > 0).join(' · ');
  const parsed = phoneCardSchema.safeParse({
    cardId: c.cardId,
    revision: c.revision,
    kind: c.kind,
    state: c.state,
    title: clip(title, PHONE_CARD_TITLE_MAX),
    text: clip(str(view.text), PHONE_CARD_TEXT_MAX),
    dangerous,
    expiresAt: c.expiresAt,
    ...(typeof c.jobId === 'string' && c.jobId.length > 0 ? { jobId: c.jobId } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** Ответ `cards.list` через ту же проекцию: хост шлёт уже проекцию, мост страхуется. */
export function projectCardsResult(raw: unknown): { cards: PhoneCard[] } {
  const list = typeof raw === 'object' && raw !== null ? (raw as { cards?: unknown }).cards : null;
  const cards: PhoneCard[] = [];
  if (Array.isArray(list)) for (const item of list) {
    const card = phoneCardSchema.safeParse(item);
    if (card.success) cards.push(card.data);
  }
  return { cards };
}

export interface CardsMethodResults {
  'cards.list': { cards: PhoneCard[] };
}

/** Событие: каждая смена состояния карточки, включая терминальные (телефон убирает карточку). */
export interface CardsEvents {
  'cards.changed': { card: PhoneCard };
}
