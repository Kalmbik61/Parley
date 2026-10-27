import type { AssistantGender, AssistantLanguage } from '@parley/core/assistant';

/**
 * Шаблонные фразы речи помощника (план 3, Task 6; #9 §6.8, T14). Это речь помощника на языке человека, как и его
 * ответы, а не интерфейс, поэтому они здесь, а не в `shared/strings.ts`. По макету (`decide`) озвучивается только
 * «Sent»: отмена и ошибки молчат. Языки без рода берут одну форму, прочие языки помощника — английскую.
 */
export type SpokenKind = 'sent';

type Phrase = string | Record<AssistantGender, string>;

const PHRASES: Partial<Record<AssistantLanguage, Record<SpokenKind, Phrase>>> & { en: Record<SpokenKind, Phrase> } = {
  en: { sent: 'Sent.' },
  ru: {
    sent: {
      female: 'Отправила.', // cyrillic-ok: речь помощника по-русски (#9 §6.8)
      male: 'Отправил.', // cyrillic-ok: речь помощника по-русски (#9 §6.8)
      neutral: 'Отправлено.', // cyrillic-ok: речь помощника по-русски (#9 §6.8)
    },
  },
};

export function spokenPhrase(kind: SpokenKind, language: AssistantLanguage, gender: AssistantGender): string {
  const phrase = (PHRASES[language] ?? PHRASES.en)[kind];
  return typeof phrase === 'string' ? phrase : phrase[gender];
}
