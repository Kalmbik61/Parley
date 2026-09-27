/**
 * Значок провайдера агента (кусок 1.2, спека 4.6): пока без логотипов вендоров
 * — буква на подложке `--muted`. Логотипы официальных наборов брендов решаются
 * в куске 3.3 (спека 18, вопрос 1 — лицензии на показ ещё не сверены).
 */

const LETTER_OVERRIDES: Readonly<Record<string, string>> = {
  claude: 'C',
  codex: 'X',
};

function providerLetter(provider: string): string {
  return LETTER_OVERRIDES[provider] ?? provider.charAt(0).toUpperCase();
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
