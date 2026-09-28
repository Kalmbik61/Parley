/**
 * Значок провайдера агента (кусок 1.2, спека 4.6): пока без логотипов вендоров
 * — буква на подложке `--muted`. Логотипы официальных наборов брендов решаются
 * в куске 3.3 (спека 18, вопрос 1 — лицензии на показ ещё не сверены).
 */

const LETTER_OVERRIDES: Readonly<Record<string, string>> = {
  claude: 'C',
  codex: 'X',
};

/**
 * Раунд исправлений 1 (находки ревью B №2 и №5): id провайдера — открытый
 * список произвольных строк (`WorkProvider`, `providers.json`), без проверки
 * алфавита — регистр не гарантирован, а ведущий символ может быть вне BMP
 * (эмодзи). Оверрайд ищем без учёта регистра; первую букву берём по code
 * point (`Array.from`), а не `charAt(0)` — иначе суррогатная пара рвётся
 * пополам, и вместо буквы/эмодзи рендерится символ-заглушка.
 */
function providerLetter(provider: string): string {
  const override = LETTER_OVERRIDES[provider.toLowerCase()];
  if (override !== undefined) return override;
  const firstCodePoint = Array.from(provider)[0];
  return firstCodePoint === undefined ? '?' : firstCodePoint.toUpperCase();
}

export interface AgentIconProps {
  provider: string;
  size?: number;
}

export function AgentIcon({ provider, size = 12 }: AgentIconProps): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[4px] bg-muted font-medium leading-none text-muted-foreground"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
    >
      {providerLetter(provider)}
    </span>
  );
}
