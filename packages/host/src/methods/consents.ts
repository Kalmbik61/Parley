/**
 * Методы согласий человека (спека 2026-10-21, 4.4): `consents.list` и `consents.decide` — карточка «доверять ли
 * папке агентам», `trust.list`, `trust.check`, `trust.grant`, `trust.revoke` — запись доверия `trust.json` (композер новой работы
 * просит согласие до запуска, Settings → Projects показывает список и отзывает). Тонкая обвязка над сервисом и
 * `core/work/trust.ts`; снимка работ методы не читают и в `WORKS_GATED_METHODS` не входят.
 */

import { grantTrust, isTrusted, listTrust, revokeTrust } from '@parley/core';
import type { AnyHandler, Handler } from '../context.js';
import type { ConsentsService } from '../consents/consents-service.js';

export function createConsentHandlers(deps: { consents: ConsentsService; home: string }): Record<string, AnyHandler> {
  const handlers: {
    'consents.list': Handler<'consents.list'>;
    'consents.decide': Handler<'consents.decide'>;
    'trust.list': Handler<'trust.list'>;
    'trust.check': Handler<'trust.check'>;
    'trust.grant': Handler<'trust.grant'>;
    'trust.revoke': Handler<'trust.revoke'>;
  } = {
    'consents.list': async () => ({ items: deps.consents.list() }),
    // Окно и остров — один сокет хоста, оба пишут доверие от `window`; Telegram зовёт сервис напрямую с `telegram`.
    'consents.decide': async (params) => deps.consents.decide(params.id, params.decision, 'window'),
    'trust.list': async () => ({ folders: await listTrust(deps.home) }),
    // Realpath папки берёт сам `isTrusted`: путь через символическую ссылку — та же папка, что в `trust.json`.
    'trust.check': async (params) => ({ trusted: await isTrusted(params.folder, deps.home) }),
    'trust.grant': async (params) => ({ folder: await grantTrust(params.folder, params.by, deps.home) }),
    'trust.revoke': async (params) => ({ removed: await revokeTrust(params.folder, deps.home) }),
  };
  return handlers as unknown as Record<string, AnyHandler>;
}
