/**
 * Пресеты вендоров для своих провайдеров (спека своих провайдеров, 4.3, 5.6).
 *
 * Сверено с официальными страницами 2026-10-19 (WebFetch); страница вендора побеждает исследование:
 * - Kimi: https://platform.kimi.ai/docs/guide/claude-code-kimi и https://www.kimi.com/code/docs/en/third-party-tools/claude-code
 *   (Kimi Code: страница теперь даёт `api.kimi.ai/coding/`, исследование — `api.kimi.com/coding/`; взят адрес страницы;
 *   страница Kimi Code называет `ANTHROPIC_API_KEY`, но К17 велит все пресеты держать на Bearer — режим не сверен);
 * - MiniMax: https://platform.minimax.io/docs/token-plan/claude-code (Китай: `api.minimaxi.com/anthropic` — не сверено);
 * - Qwen: https://www.alibabacloud.com/help/en/model-studio/claude-code (страница сама себе противоречит по хостам
 *   Coding Plan и Token Plan — взяты адреса из примеров настройки; рабочее пространство pay-go — `{WorkspaceId}`);
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code;
 * - OpenRouter: https://openrouter.ai/docs/guides/guides/claude-code-integration (слаги — примеры страницы).
 *
 * Модели, которые отвечают 400 без thinking (Kimi k2.7-code, спека 9.5), в слоты не ставятся: слот Haiku у Kimi — k3,
 * хотя страница вендора в примере ставит туда k2.7-code. У MiniMax Flash thinking включён всегда, так что он безопасен.
 * Все пресеты — Bearer (К17).
 */

import type { CustomProviderAuth, CustomProviderModels } from '@parley/protocol';

export interface CustomPresetEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  auth: CustomProviderAuth;
  models: CustomProviderModels;
  contextWindow: number | null;
}

export interface CustomPreset {
  id: string;
  label: string;
  /** Строка про оплату на плитке выбора вендора. */
  billing: string;
  /** Страница, где берётся ключ. */
  keyUrl: string;
  endpoints: readonly CustomPresetEndpoint[];
}

const same = (model: string): CustomProviderModels => ({ opus: model, sonnet: model, haiku: model, subagent: model });

export const CUSTOM_PRESETS: readonly CustomPreset[] = [
  {
    id: 'kimi',
    label: 'Kimi',
    billing: 'Pay per token or Kimi Code subscription',
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    endpoints: [
      {
        id: 'moonshot',
        label: 'Moonshot API (tokens)',
        baseUrl: 'https://api.moonshot.ai/anthropic',
        auth: 'bearer',
        models: same('kimi-k3[1m]'),
        contextWindow: 1_000_000,
      },
      {
        id: 'kimi-code',
        label: 'Kimi Code (subscription)',
        baseUrl: 'https://api.kimi.ai/coding/',
        auth: 'bearer',
        models: same('k3[1m]'),
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    billing: 'Subscription plans or tokens',
    keyUrl: 'https://platform.minimax.io',
    endpoints: [
      {
        id: 'global',
        label: 'MiniMax (global)',
        baseUrl: 'https://api.minimax.io/anthropic',
        auth: 'bearer',
        models: same('MiniMax-M3.1-Flash[1m]'),
        contextWindow: 524_288,
      },
    ],
  },
  {
    id: 'qwen',
    label: 'Qwen',
    billing: 'Coding Plan, Token Plan or pay as you go',
    keyUrl: 'https://www.alibabacloud.com/help/en/model-studio/claude-code',
    endpoints: [
      {
        id: 'coding-plan',
        label: 'Coding Plan',
        baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
        auth: 'bearer',
        models: same('qwen3.7-plus'),
        contextWindow: null,
      },
      {
        id: 'token-plan',
        label: 'Token Plan',
        baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
        auth: 'bearer',
        models: { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash', subagent: 'auto' },
        contextWindow: null,
      },
      {
        id: 'pay-as-you-go',
        label: 'Pay as you go (Singapore)',
        // Хост зависит от рабочего пространства и региона: человек подставляет свой (draftError не даст сохранить `{`).
        baseUrl: 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
        auth: 'bearer',
        models: { opus: 'qwen3.7-max', sonnet: 'qwen3.7-max', haiku: 'qwen3.6-flash', subagent: 'qwen3.7-max' },
        contextWindow: null,
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    billing: 'Pay per token',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    endpoints: [
      {
        id: 'api',
        label: 'DeepSeek API',
        baseUrl: 'https://api.deepseek.com/anthropic',
        auth: 'bearer',
        models: { opus: 'deepseek-flash[1m]', sonnet: 'deepseek-flash[1m]', haiku: 'deepseek-flash', subagent: 'deepseek-flash' },
        contextWindow: 786_432,
      },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    billing: 'OpenRouter credits',
    keyUrl: 'https://openrouter.ai/keys',
    endpoints: [
      {
        id: 'api',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api',
        auth: 'bearer',
        models: {
          opus: '~anthropic/claude-opus-latest[1m]',
          sonnet: '~anthropic/claude-sonnet-latest[1m]',
          haiku: '~anthropic/claude-haiku-latest',
          subagent: '~anthropic/claude-opus-latest[1m]',
        },
        contextWindow: null,
      },
    ],
  },
];
