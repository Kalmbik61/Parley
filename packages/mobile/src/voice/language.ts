/** Выбор языка попытки (спека 2.3): кандидаты по языку клавиатуры и языку устройства, первый с распознаванием на устройстве. */
import { reasonNoLanguage, reasonOnDevice, type LanguageChoice } from './dictation';
import { isLanguageTag, localeCandidates } from './locale';

export interface LanguageSource {
  supportsOnDevice(lang: string): boolean;
  supportedLocales(): Promise<string[]>;
  /** Вариант (а): язык клавиатуры поля в фокусе. При варианте (б) метод и шаг «клавиатура» ниже удаляются. */
  inputLanguage(): Promise<string | null>;
}

export function createLanguageChooser(source: LanguageSource, deviceTag: () => string) {
  /** Последний язык клавиатуры, полученный на тапе за этот запуск (ревью r2, n2). */
  let lastKeyboard: string | null = null;

  /** Шаг «клавиатура» (вариант (а)): первый кандидат, если есть. */
  async function keyboardTag(focused: boolean): Promise<string | null> {
    if (focused) {
      const tag = await source.inputLanguage().catch(() => null);
      if (isLanguageTag(tag)) lastKeyboard = tag;
    }
    return lastKeyboard;
  }

  return async function chooseLanguage({ useKeyboard, focused }: { useKeyboard: boolean; focused: boolean }): Promise<LanguageChoice> {
    const device = deviceTag();
    const tags: string[] = [];
    const keyboard = useKeyboard ? await keyboardTag(focused) : null;
    if (keyboard !== null) tags.push(keyboard);
    tags.push(device);
    const supported = await source.supportedLocales();
    let firstCandidate: string | null = null;
    for (const tag of tags) {
      for (const candidate of localeCandidates(tag, supported)) {
        firstCandidate ??= candidate;
        if (source.supportsOnDevice(candidate)) return { ok: true, lang: candidate };
      }
    }
    return firstCandidate !== null
      ? { ok: false, lang: firstCandidate, reason: reasonOnDevice(firstCandidate) }
      : { ok: false, lang: device, reason: reasonNoLanguage(device) };
  };
}
