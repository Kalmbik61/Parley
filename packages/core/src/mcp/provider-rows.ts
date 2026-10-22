import type { ProviderLimits } from '../limits.js';
import type { ModelOption } from '../provider-models.js';
import type { AgentChannel } from '../work/mcp-config.js';

/**
 * Строка провайдера для агента (спека подписок 5.8, К7): то, что хост знает о нём лучше процесса MCP, — вход аккаунта и
 * лимиты. Без ключа, исхода проверки и описания своего провайдера: агенту они ни к чему.
 */
export interface ProviderRow {
  id: string;
  label: string;
  family: 'claude' | 'codex' | null;
  available: boolean;
  needs: 'cli' | 'key' | 'sign-in' | null;
  models: ModelOption[] | null;
  effort: boolean;
  limits: ProviderLimits | null;
}

/** Срок ответа хоста: `get_map` зовут первым делом, и молчащий хост не должен его подвешивать. */
const FETCH_TIMEOUT_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Строка из ответа хоста; обязательны `id`, `label` и `available`, остальное — безопасными значениями, лишнее отбрасывается. */
function rowOf(value: unknown): ProviderRow | null {
  if (!isRecord(value)) return null;
  const { id, label, available, family, needs, models, effort, limits } = value;
  if (typeof id !== 'string' || id === '' || typeof label !== 'string' || typeof available !== 'boolean') return null;
  return {
    id,
    label,
    family: family === 'claude' || family === 'codex' ? family : null,
    available,
    needs: needs === 'cli' || needs === 'key' || needs === 'sign-in' ? needs : null,
    models: Array.isArray(models) ? (models as ModelOption[]) : null,
    effort: effort === true,
    limits: isRecord(limits) && typeof limits['at'] === 'string' ? (limits as unknown as ProviderLimits) : null,
  };
}

/**
 * Спрашивает у хоста строки провайдеров по каналу агента (`POST /agent/providers`, токен сессии — как у `create_session`).
 * Любая неудача — порт закрыт, отказ, срок, нечитаемый ответ, кривая строка — это `null`: `get_map` тогда отдаёт локальные
 * строки с пометкой, что вход и лимиты неизвестны.
 */
export async function fetchProviderRows(agent: AgentChannel, signal: AbortSignal): Promise<ProviderRow[] | null> {
  try {
    const response = await fetch(new URL('/agent/providers', agent.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      redirect: 'error',
    });
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || body['ok'] !== true || !isRecord(body['result']) || !Array.isArray(body['result']['providers'])) return null;
    const rows: ProviderRow[] = [];
    for (const item of body['result']['providers'] as unknown[]) {
      const row = rowOf(item);
      if (row === null) return null;
      rows.push(row);
    }
    return rows;
  } catch {
    return null;
  }
}
