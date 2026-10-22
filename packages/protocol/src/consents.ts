/**
 * Согласия человека (спека 2026-10-21, 4.4): карточка «доверять ли папке агентам» — запуск Codex удерживается,
 * пока человек не решит в окне, на острове или в Telegram, — и запись доверия `trust.json`, которую решение
 * `allow` пополняет. Хост рассылает изменения карточек событием `consents.changed`.
 */

import { z } from 'zod';

/** Согласие на папку (`trust.json`). Копия типа ядра: протокол берёт из core только типы, нужные снимкам. */
export interface TrustRecord {
  /** Ключ: realpath папки проекта. */
  folder: string;
  /** Когда выдано, ISO-8601. */
  grantedAt: string;
  by: 'window' | 'island' | 'telegram';
}

/** Карточка согласия. Хранит хост (`consents.json`), в `consents.list` отдаются только ждущие. */
export interface ConsentCard {
  /** `c-NN`, сквозной у хоста. */
  id: string;
  kind: 'folder-trust';
  /** realpath папки проекта. */
  folder: string;
  projectPath: string;
  requestedBy: { source: 'agent' | 'resume' | 'launch'; sessionId?: string; workId?: string; label?: string };
  at: string;
  state: 'pending' | 'allowed' | 'denied';
}

export const consentMethodSchemas = {
  'consents.list': z.object({}),
  'consents.decide': z.object({ id: z.string().min(1), decision: z.enum(['allow', 'deny']) }),
  'trust.list': z.object({}),
  /** Доверена ли папка: хост сам берёт realpath, окно путь не сверяет (`/tmp` и `/private/tmp` — одна папка). */
  'trust.check': z.object({ folder: z.string().min(1) }),
  'trust.grant': z.object({ folder: z.string().min(1), by: z.enum(['window', 'island', 'telegram']) }),
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
