import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderRow } from '@parley/core';
import { AGENT_LIMITS, type Result, type SessionRef } from '@parley/protocol';

export const AGENT_PROVIDERS_PATH = '/agent/providers';

/**
 * Строки `providers.list` для агента (спека подписок 5.8, К7): без `keyHint`, `check` и `custom` — ключа, исхода его
 * проверки и описания своего провайдера агенту не отдаём. Поля, которых нет у хоста старой сборки, — безопасными значениями.
 */
export function providerRowsOf(result: Result<'providers.list'>): ProviderRow[] {
  return result.providers.map((row) => ({
    id: row.id,
    label: row.label,
    // Протокол пока держит `family` как `'claude' | null`; `'codex'` появится на этапе 3, когда его расширят.
    family: (row.family ?? null) as ProviderRow['family'],
    available: row.available,
    needs: row.needs ?? null,
    models: row.models ?? null,
    effort: row.effort ?? false,
    limits: row.limits ?? null,
  }));
}

/**
 * Точка `POST /agent/providers` на сервере хуков (спека подписок 5.8, К7): агент спрашивает строки провайдеров с входом
 * аккаунтов и лимитами — процесс MCP не видит ни кэша входа, ни других работ. Токен — тот же, что у `/agent/sessions`;
 * тело запроса не читается. Хуки принимают на путях `routes` только POST.
 */
export function createProvidersEndpoint(options: {
  authenticate(req: IncomingMessage): SessionRef | undefined;
  list(): Promise<ProviderRow[]>;
}) {
  return {
    handle(req: IncomingMessage, res: ServerResponse): void {
      const refuse = (status: number): void => { res.writeHead(status, { Connection: 'close' }); res.end(); req.resume(); };
      const reply = (body: unknown): void => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      };
      if (options.authenticate(req) === undefined) return refuse(401);
      if (Number(req.headers['content-length'] ?? 0) > AGENT_LIMITS.requestBytes) return refuse(413);
      req.resume();
      void (async () => {
        try {
          const providers = await options.list();
          // Токен могли снять, пока список собирался: ответ без права на него не уходит.
          if (options.authenticate(req) === undefined) { refuse(401); return; }
          reply({ ok: true, result: { providers } });
        } catch (error) {
          reply({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } });
        }
      })();
    },
  };
}
