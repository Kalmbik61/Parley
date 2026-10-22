/**
 * Значок провайдера агента (спека 4.6; решение 6 спеки окна 2026-09-29): у claude и codex — брендовые
 * SVG из `assets/providers/` (Codex в тёмной теме — `codex-light.svg`), у прочих провайдеров — буква
 * на подложке `--muted`, как прежде. Файлы значков — решение пользователя для личной неподписанной
 * сборки; чьи это знаки и откуда файлы, сказано в NOTICE.
 *
 * Значок — картинка `<img>`: окно не ходит в сеть, файлы лежат в сборке (CSP `img-src 'self'`).
 * Рядом со значком почти всегда стоит название — тогда `alt` пустой, а там, где значок стоит один
 * (свёрнутая комната), подпись передаёт вызывающий (`label`).
 *
 * `data-agent-icon` — на обоих видах (картинка и буква): за него держится приглушение `styles/dimmed.css`
 * (значки .6 у done-карточки, .5 у закрытой строки). Правило брало только `svg` и точку состояния, а значок
 * провайдера — `<img>`, и брендовый значок оставался при opacity 1 (правки ревью куска 2).
 */

import { isCustomProviderId } from '@parley/protocol';
import claudeUrl from '../assets/providers/claude.svg';
import codexLightUrl from '../assets/providers/codex-light.svg';
import codexUrl from '../assets/providers/codex.svg';
import parleyUrl from '../assets/providers/parley.svg';
import { useProvidersStore, type ProviderInfo } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { kindOf } from './providers/custom-provider-draft.js';

/**
 * Раунд исправлений 1 (находки ревью B №2 и №5): id провайдера — открытый
 * список произвольных строк (`WorkProvider`, `providers.json`), без проверки
 * алфавита — регистр не гарантирован, а ведущий символ может быть вне BMP
 * (эмодзи). Значок ищем без учёта регистра; первую букву берём по code
 * point (`Array.from`), а не `charAt(0)` — иначе суррогатная пара рвётся
 * пополам, и вместо буквы/эмодзи рендерится символ-заглушка.
 */
function providerLetter(provider: string): string {
  const firstCodePoint = Array.from(provider)[0];
  return firstCodePoint === undefined ? '?' : firstCodePoint.toUpperCase();
}

/**
 * Семейство CLI аккаунта подписки (спека подписок 5.9): значок аккаунта — значок его CLI, а не Parley. Берётся из строки
 * `providers.list` (`family` отдаёт хост); у записи с адресом, хоть она и запускается через `claude`, значка CLI нет.
 * Протокол пока знает только `family: 'claude'`; Codex — по виду аккаунта до этапа 3.
 */
function accountFamily(row: ProviderInfo | undefined): 'claude' | 'codex' | null {
  const kind = kindOf(row?.custom);
  if (kind === 'claude-account') return row?.family ?? 'claude';
  return kind === 'codex-account' ? 'codex' : null;
}

/** Адрес брендового значка; `null` — у провайдера его нет, рисуется буква. */
function brandIcon(provider: string, dark: boolean, family: 'claude' | 'codex' | null): string | null {
  // Аккаунт подписки — значок семейства (спека подписок 5.9), стоит до правила своих провайдеров.
  if (family === 'claude') return claudeUrl;
  if (family === 'codex') return dark ? codexLightUrl : codexUrl;
  // Свои провайдеры (спека 3.7): пока значок Parley, вендорские — следующая работа. По id, а не по стору:
  // удалённый провайдер в старой комнате остаётся со значком.
  if (isCustomProviderId(provider)) return parleyUrl;
  switch (provider.toLowerCase()) {
    case 'claude':
      return claudeUrl;
    case 'codex':
      return dark ? codexLightUrl : codexUrl;
    default:
      return null;
  }
}

export interface AgentIconProps {
  provider: string;
  size?: number;
  /** Подпись значка для скринридера — только когда рядом нет названия провайдера. */
  label?: string;
}

export function AgentIcon({ provider, size = 12, label }: AgentIconProps): JSX.Element {
  const dark = useUiStore((state) => state.dark);
  // Селектор отдаёт строку или `null`: значок перерисовывается только при смене семейства.
  const family = useProvidersStore((state) => accountFamily(state.providers.find((row) => row.id === provider)));
  const src = brandIcon(provider, dark, family);
  if (src !== null) {
    return (
      <img
        src={src}
        alt={label ?? ''}
        width={size}
        height={size}
        draggable={false}
        data-agent-icon=""
        className="block shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      data-agent-icon=""
      className="inline-flex shrink-0 items-center justify-center rounded-[4px] bg-muted font-medium leading-none text-muted-foreground"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
    >
      {providerLetter(provider)}
    </span>
  );
}
