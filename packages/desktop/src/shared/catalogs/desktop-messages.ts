import { createI18n } from '@parley/core/i18n';

export type LocalizedMessages<T> =
  T extends string ? string :
    T extends (...args: infer Args) => string ? (...args: Args) => string :
      { [Key in keyof T]: LocalizedMessages<T[Key]> };

const russian = createI18n('ru');
export const ruNumber = russian.formatNumber;

export function ruCount(count: number, forms: readonly [one: string, few: string, many: string]): string {
  const category = russian.pluralCategory(count);
  const noun = forms[category === 'one' ? 0 : category === 'many' ? 2 : 1];
  return `${ruNumber(count)} ${noun}`;
}
