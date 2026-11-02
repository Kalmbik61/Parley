/**
 * Согласия человека (спека 2026-10-21, 4.4): карточка «доверять ли папке агентам» — запуск Codex удерживается,
 * пока человек не решит в окне, на острове или в Telegram, — и запись доверия `trust.json`, которую решение
 * `allow` пополняет. Хост рассылает изменения карточек событием `consents.changed`.
 */

import { z } from 'zod';
import type { SessionRef } from './types.js';

/** Согласие на папку (`trust.json`). Копия типа ядра: протокол берёт из core только типы, нужные снимкам. */
export interface TrustRecord {
  /** Ключ: realpath папки проекта. */
  folder: string;
  /** Когда выдано, ISO-8601. */
  grantedAt: string;
  by: 'window' | 'island' | 'telegram' | 'phone';
}

/** Общие поля карточки согласия. */
interface ConsentCardBase {
  /** `c-NN`, сквозной у хоста. */
  id: string;
  projectPath: string;
  at: string;
  state: 'pending' | 'allowed' | 'denied';
}

/** «Доверять ли папке агентам»: запуск Codex удерживается до решения. */
export interface FolderTrustCard extends ConsentCardBase {
  kind: 'folder-trust';
  /** realpath папки проекта. */
  folder: string;
  requestedBy: { source: 'agent' | 'resume' | 'launch'; sessionId?: string; workId?: string; label?: string };
}

/**
 * Агент просит продолжить сессию на другом провайдере (`request_agent_switch`): замену выполняет только `allow`
 * человека. `id` карточки служит `requestId` замены. Окно, остров и Telegram, не знающие вида, его пропускают.
 */
export interface AgentSwitchCard extends ConsentCardBase {
  kind: 'agent-switch';
  /** Сессия, которую продолжают. */
  ref: SessionRef;
  provider: string;
  /** Имя провайдера для людей (`providerLabel`). */
  providerLabel: string;
  model: string | null;
  reason: string;
  requestedBy: { sessionId: string; label: string };
}

/** Сервер MCP из `.mcp.json` проекта, о котором у человека ещё нет решения. */
export interface ProjectMcpServer {
  name: string;
  /**
   * sha256 канонического JSON ВСЕЙ записи сервера (ключи отсортированы рекурсивно). `env` и `headers` входят в хеш, но
   * нигде не показываются. Меняется — человека спрашивают снова, а решение привязано к паре `name` + `fingerprint`.
   */
  fingerprint: string;
  /** Что запустится: `command` и `args` через пробел, у сетевого сервера — URL; не длиннее 200 знаков. */
  command: string;
}

/**
 * Новые серверы MCP из `.mcp.json` перед запуском Claude (спека 2026-11-02, 7): запуск удерживается, пока человек не
 * выберет, какие серверы включить. По умолчанию всё выключено; `consents.decide` принимает `enabled` — пары имя и отпечаток
 * из `servers`: решение привязано к тому, что человек видел. Отказ или ответ без `enabled` — все выключены. Запуск после решения идёт в любом случае.
 */
export interface ProjectMcpCard extends ConsentCardBase {
  kind: 'project-mcp';
  /** Форма карточки (спека 2026-11-02, 7.2): новая форма — новый номер; клиент не рисует карточку без `version` или с неизвестной. */
  version: 1;
  /**
   * Номер списка серверов: 1 у новой карточки, +1 при каждом изменении `servers` (спека 7.2). Решение должно прийти с
   * `revision` карточки, которую человек видел; другая — `bad_request`, человек смотрит список заново.
   */
  revision: number;
  /** realpath корня основного репозитория: worktree одного проекта делят решение. */
  repo: string;
  servers: ProjectMcpServer[];
  requestedBy: { source: 'agent' | 'resume' | 'launch'; sessionId?: string; workId?: string; label?: string };
}

/** Карточка согласия. Хранит хост (`consents.json`), в `consents.list` отдаются только ждущие. */
export type ConsentCard = FolderTrustCard | AgentSwitchCard | ProjectMcpCard;

export const consentMethodSchemas = {
  'consents.list': z.object({}),
  /**
   * `enabled` — только для карточки `project-mcp`: пары `{name, fingerprint}` серверов, которые человек включил, ровно
   * как в карточке; пара, не совпавшая с нынешней карточкой, — `bad_request`. Нет поля — все выключены. `revision` — номер
   * списка, который видел человек (`ProjectMcpCard.revision`): у `project-mcp` обязателен, другой — `bad_request`.
   */
  'consents.decide': z.object({
    id: z.string().min(1),
    decision: z.enum(['allow', 'deny']),
    enabled: z.array(z.object({ name: z.string().min(1).max(200), fingerprint: z.string().min(1).max(200) })).max(200).optional(),
    revision: z.number().int().min(1).optional(),
  }),
  'trust.list': z.object({}),
  /** Доверена ли папка: хост сам берёт realpath, окно путь не сверяет (`/tmp` и `/private/tmp` — одна папка). */
  'trust.check': z.object({ folder: z.string().min(1) }),
  'trust.grant': z.object({ folder: z.string().min(1), by: z.enum(['window', 'island', 'telegram', 'phone']) }),
  'trust.revoke': z.object({ folder: z.string().min(1) }),
} as const;

export interface ConsentMethodResults {
  'consents.list': { items: ConsentCard[] };
  /** Второе решение по той же карточке — `applied: false` (как у `feed.decide`). */
  'consents.decide': { applied: boolean; state: ConsentCard['state'] };
  'trust.list': { folders: TrustRecord[] };
  'trust.check': { trusted: boolean };
  'trust.grant': { folder: TrustRecord };
  'trust.revoke': { removed: boolean };
}
