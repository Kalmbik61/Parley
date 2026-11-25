import type { AppLocale } from './locale.js';

type Catalog = Readonly<Record<string, string>>;
type TemplateParameters<Text extends string> = Text extends `${string}{${infer Key}}${infer Rest}`
  ? Key | TemplateParameters<Rest>
  : never;
type CatalogPair<En extends Catalog> = { en: En; ru: Readonly<Record<keyof En, string>> };
type MatchingParameters<En extends Catalog, Ru extends CatalogPair<En>['ru']> = {
  [Key in keyof Ru]: Key extends keyof En
    ? [TemplateParameters<En[Key]>] extends [TemplateParameters<Ru[Key] & string>]
      ? [TemplateParameters<Ru[Key] & string>] extends [TemplateParameters<En[Key]>]
        ? unknown
        : never
      : never
    : never;
};

/** Keeps message keys and named placeholders in sync across the two locales. */
export function defineCatalog<const En extends Catalog, const Ru extends CatalogPair<En>['ru']>(
  en: En,
  ru: Ru & MatchingParameters<En, Ru>,
): CatalogPair<En> {
  return { en, ru };
}

type MessageArgs<Text extends string> = [TemplateParameters<Text>] extends [never]
  ? []
  : [Readonly<Record<TemplateParameters<Text>, string | number>>];

export type Translator<En extends Catalog> = <Key extends keyof En>(key: Key, ...args: MessageArgs<En[Key]>) => string;

export function createTranslator<En extends Catalog>(locale: AppLocale, catalog: CatalogPair<En>): Translator<En> {
  const messages = catalog[locale];
  return <Key extends keyof En>(key: Key, ...args: MessageArgs<En[Key]>): string => {
    const values: Readonly<Record<string, string | number>> | undefined = args[0];
    return messages[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => values?.[name]?.toString() ?? placeholder);
  };
}
