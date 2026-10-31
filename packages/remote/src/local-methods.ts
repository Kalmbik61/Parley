import { bridgeMethodSchemas } from '@parley/protocol/remote';
import type { PhoneSessions } from './session-contract.js';

export interface ClientInfo {
  app: string;
  version: string;
  platform: string;
}

export interface LocalMethodContext {
  deviceId: string;
  push: Pick<PhoneSessions, 'setPush'>;
  /** Куда сохранить `client.info` (только в памяти моста, для журнала и диагностики). */
  setClientInfo(info: ClientInfo): void;
}

export class LocalMethodError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

export const LOCAL_METHODS: ReadonlySet<string> = new Set(Object.keys(bridgeMethodSchemas));

/** Методы самого моста: к хосту не идут. Бросает `LocalMethodError('bad_request')` на неверных параметрах. */
export async function callLocalMethod(method: string, params: unknown, ctx: LocalMethodContext): Promise<unknown> {
  switch (method) {
    case 'ping': {
      if (!bridgeMethodSchemas.ping.safeParse(params ?? {}).success) throw new LocalMethodError('bad_request');
      return {};
    }
    case 'client.info': {
      const parsed = bridgeMethodSchemas['client.info'].safeParse(params);
      if (!parsed.success) throw new LocalMethodError('bad_request');
      ctx.setClientInfo(parsed.data);
      return {};
    }
    case 'push.register': {
      const parsed = bridgeMethodSchemas['push.register'].safeParse(params);
      if (!parsed.success) throw new LocalMethodError('bad_request');
      const { apnsToken, env } = parsed.data;
      await ctx.push.setPush(ctx.deviceId, apnsToken === null ? null : { apnsToken, env });
      return {};
    }
    default:
      throw new LocalMethodError('unknown_method');
  }
}
