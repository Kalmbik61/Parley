/**
 * Значок провайдера агента (спека 4.6; решение 6 спеки окна 2026-09-29): у claude, codex и вендоров пресетов (Kimi,
 * DeepSeek, MiniMax, Qwen, OpenRouter) — брендовые SVG из `assets/providers/` (в тёмной теме — `*-light.svg`, где он
 * есть), у прочих провайдеров — буква
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
import deepseekUrl from '../assets/providers/deepseek.svg';
import kimiLightUrl from '../assets/providers/kimi-light.svg';
import kimiUrl from '../assets/providers/kimi.svg';
import minimaxUrl from '../assets/providers/minimax.svg';
import openrouterLightUrl from '../assets/providers/openrouter-light.svg';
import openrouterUrl from '../assets/providers/openrouter.svg';
import parleyUrl from '../assets/providers/parley.svg';
import qwenUrl from '../assets/providers/qwen.svg';
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

/** Знаки вендоров пресетов по id пресета: `[светлая тема, тёмная тема]`. Цветным знакам вторая тема не нужна. */
const VENDOR_ICONS = {
  kimi: [kimiUrl, kimiLightUrl],
  deepseek: [deepseekUrl, deepseekUrl],
  minimax: [minimaxUrl, minimaxUrl],
  qwen: [qwenUrl, qwenUrl],
  openrouter: [openrouterUrl, openrouterLightUrl],
} as const;

type Vendor = keyof typeof VENDOR_ICONS;

const isVendor = (value: unknown): value is Vendor => typeof value === 'string' && Object.hasOwn(VENDOR_ICONS, value);

/**
 * Семейство CLI аккаунта подписки (спека подписок 5.9): значок аккаунта — значок его CLI, а не Parley. Берётся из строки
 * `providers.list` (`family` отдаёт хост); у записи с адресом, хоть она и запускается через `claude`, значка CLI нет.
 * Вендор узнаётся по пресету endpoint-записи, а не по пользовательскому имени или id.
 * Протокол пока знает только `family: 'claude'`; Codex — по виду аккаунта до этапа 3.
 */
function providerBrand(row: ProviderInfo | undefined): 'claude' | 'codex' | Vendor | null {
  const kind = kindOf(row?.custom);
  if (kind === 'claude-account') return row?.family ?? 'claude';
  if (kind === 'codex-account') return 'codex';
  if (kind === 'endpoint' && row?.custom && 'preset' in row.custom && isVendor(row.custom.preset)) return row.custom.preset;
  return null;
}

/** Адрес брендового значка; `null` — у провайдера его нет, рисуется буква. */
function brandIcon(provider: string, dark: boolean, brand: 'claude' | 'codex' | Vendor | null): string | null {
  // Аккаунт подписки — значок семейства (спека подписок 5.9), стоит до правила своих провайдеров.
  if (brand === 'claude') return claudeUrl;
  if (brand === 'codex') return dark ? codexLightUrl : codexUrl;
  if (brand !== null) return VENDOR_ICONS[brand][dark ? 1 : 0];
  // Свои провайдеры без известного бренда — значок Parley. По id, а не по стору:
  // удалённый провайдер в старой комнате остаётся со значком.
  if (isCustomProviderId(provider)) return parleyUrl;
  const id = provider.toLowerCase();
  switch (id) {
    case 'claude':
      return claudeUrl;
    case 'codex':
      return dark ? codexLightUrl : codexUrl;
    default:
      // Плитки пресетов в диалоге своего провайдера передают id пресета.
      return isVendor(id) ? VENDOR_ICONS[id][dark ? 1 : 0] : null;
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
  // Селектор отдаёт строку или `null`: значок перерисовывается только при смене бренда.
  const brand = useProvidersStore((state) => providerBrand(state.providers.find((row) => row.id === provider)));
  const src = brandIcon(provider, dark, brand);
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
