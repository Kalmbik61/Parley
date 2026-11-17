/**
 * Путь пакета состояния комнаты приёмника хуков (спека 2026-11-16, 3.5): мост после сжатия (`packet-hook-bin`) шлёт сюда
 * событие `SessionStart` с `source: "compact"` и получает пакет сессии для `additionalContext`.
 *
 * Доступ проверяет сам приёмник (`guarded` в `hook-server`), общей с `/hooks` точкой: токен запуска → регистрация, заголовок
 * сессии сверяется с ней. Сессию здесь называет только регистрация (`request.ref`); тело и заголовки её не выбирают.
 * Событие в ленту не уходит: этот путь нужен, чтобы оно не применилось второй раз.
 *
 * Отказы — без текста пакета и без записи в журнал сессии. Пустой ответ `{}`: настройка выключена (проверяется на каждом
 * запросе), нет пакета, сбой сборки. Запись хоста `ParleyRoomPacket` — только для проверенного запроса с включённой
 * настройкой, и она доказывает отправку, не получение.
 *
 * Испытательное управление `PARLEY_ROOM_PACKET_FAULT` (`delay:5000` или `drop`; любое другое значение — ничего) — для
 * приёмки стыковки: действует только здесь, после проверки токена, тела и настройки, и не оставляет таймеров.
 */

import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOM_PACKET_EVENT, loadConfig, readMap, sessionRoomPacket, workPaths } from '@parley/core';
import type { McpContext, ToolLaunch, WorkSession } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import { EMPTY_HOOK_RESPONSE } from './decisions.js';
import type { GuardedRequest } from './hook-server.js';

/** Путь на приёмнике хуков (в `guarded`). */
export const PACKET_PATH = '/hooks/packet';

/** Имя испытательной переменной окружения хоста. */
export const PACKET_FAULT_ENV = 'PARLEY_ROOM_PACKET_FAULT';

const FAULT_DELAY_MS = 5000;

export type PacketFault = { kind: 'delay'; ms: number } | { kind: 'drop' };

/** Допустимы ровно два значения; пустое, отсутствующее и любое другое — без сбоя. */
export function parsePacketFault(value: string | undefined): PacketFault | null {
  if (value === 'drop') return { kind: 'drop' };
  if (value === `delay:${FAULT_DELAY_MS}`) return { kind: 'delay', ms: FAULT_DELAY_MS };
  return null;
}

/**
 * Снимок запуска для сборки пакета: возможности (навигатор, профиль, ревизия контекста) — последний снимок процесса MCP этой
 * сессии, пришедший по её токену; ревизия агента из регистрации хуков сильнее. Запрос моста ничего из этого не называет.
 * Снимка нет — возможности неизвестны, и ничего не подставляется: `null`, хук отвечает пусто (`unknown-catalog`).
 */
export function packetLaunch(known: ToolLaunch | undefined, registered: { agentRevision?: string }): ToolLaunch | null {
  if (known === undefined) return null;
  return { ...known, ...(registered.agentRevision === undefined ? {} : { agentRevision: registered.agentRevision }) };
}

/**
 * Контекст пакета из состояния хоста: снимок запуска у маршрута инструментов (`launchOf`) и регистрация хуков. Снимка нет —
 * `null`: каталог инструментов неизвестен, пакета нет. Одна функция для хоста и для тестов.
 */
export function packetContext(
  tools: { launchOf(ref: SessionRef): ToolLaunch | undefined },
  toolContextFor: (ref: SessionRef, launch: ToolLaunch) => Promise<McpContext>,
): (ref: SessionRef, registered: { agentRevision?: string }) => Promise<McpContext | null> {
  return async (ref, registered) => {
    const launch = packetLaunch(tools.launchOf(ref), registered);
    return launch === null ? null : toolContextFor(ref, launch);
  };
}

/**
 * Правило опыта (план опыта 2026-11-17, 1.1, Э-1): кто получает мост и пакет. Плечо «контроль» — никогда; плечо «пакет» — да;
 * сессия без плеча — только пока опыт не идёт (`roomPacketTrial` пуст). Одно правило для установки моста при запуске и для
 * каждого запроса к пути пакета; причина отказа — в журнале сессии.
 */
export type PacketGate = { ok: true } | { ok: false; reason: 'control' | 'not-in-trial' };

export function packetGate(session: Pick<WorkSession, 'trial'> | undefined, trialName: string): PacketGate {
  const arm = session?.trial?.arm;
  if (arm === 'control') return { ok: false, reason: 'control' };
  if (arm === 'packet') return { ok: true };
  return trialName === '' ? { ok: true } : { ok: false, reason: 'not-in-trial' };
}

export interface PacketEndpointDeps {
  log: Log;
  /** Настройка `roomPacket`; зовётся на каждом запросе. */
  enabled?(): Promise<boolean>;
  /** Контекст исполнителя инструментов сессии (тот же, что у `/agent/tools`); `null` — возможности запуска неизвестны (`packetContext`). */
  context(ref: SessionRef, registered: { agentRevision?: string }): Promise<McpContext | null>;
  /** Имя идущего опыта (`roomPacketTrial`); зовётся на каждом запросе. */
  trial?(): Promise<string>;
  /** Запись сессии в карте (плечо опыта); `undefined` — записи нет. */
  session?(ref: SessionRef): Promise<Pick<WorkSession, 'trial'> | undefined>;
  /** Запись хоста в `events/<сессия>.jsonl`; сбой не меняет ответ. */
  journal?(ref: SessionRef, record: Record<string, unknown>): void;
  /** Испытательная переменная; по умолчанию — окружение хоста. */
  fault?(): string | undefined;
}

const defaultEnabled = async (): Promise<boolean> => (await loadConfig()).config.roomPacket;

const defaultTrial = async (): Promise<string> => (await loadConfig()).config.roomPacketTrial;

const defaultSession = async (ref: SessionRef): Promise<Pick<WorkSession, 'trial'> | undefined> =>
  (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);

const defaultJournal = (ref: SessionRef, record: Record<string, unknown>): void => {
  const file = path.join(workPaths(ref.projectPath, ref.workId).events, `${ref.sessionId}.jsonl`);
  // Каталога `events/` нет — сессия без хуков: не создаём.
  appendFile(file, `${JSON.stringify(record)}\n`, 'utf8').catch(() => {});
};

export interface PacketEndpoint {
  handle(request: GuardedRequest): void;
}

export function createPacketEndpoint(deps: PacketEndpointDeps): PacketEndpoint {
  const enabled = deps.enabled ?? defaultEnabled;
  const trial = deps.trial ?? defaultTrial;
  const sessionOf = deps.session ?? defaultSession;
  const journal = deps.journal ?? defaultJournal;
  const faultValue = deps.fault ?? ((): string | undefined => process.env[PACKET_FAULT_ENV]);

  const write = (ref: SessionRef, revision: string | null, bytes: number, reason: string): void => {
    try {
      journal(ref, { hook_event_name: ROOM_PACKET_EVENT, revision, bytes, reason });
    } catch (error) {
      deps.log.warn('пакет комнаты: запись в журнал не удалась', { error: String(error) });
    }
  };

  async function answer(request: GuardedRequest): Promise<void> {
    const { ref } = request;
    let packet: Awaited<ReturnType<typeof sessionRoomPacket>>;
    try {
      const context = await deps.context(ref, request.agentRevision === undefined ? {} : { agentRevision: request.agentRevision });
      if (context === null) {
        // Возможности запуска неизвестны (процесс MCP ещё не спрашивал инструменты, либо запись потеряна): каталог инструментов
        // в пакете был бы угадан, поэтому ответ пустой.
        if (request.answered()) return;
        write(ref, null, 0, 'unknown-catalog');
        request.respond(EMPTY_HOOK_RESPONSE);
        return;
      }
      packet = await sessionRoomPacket(context);
    } catch (error) {
      deps.log.warn('пакет комнаты: сборка не удалась', { error: String(error) });
      if (request.answered()) return;
      write(ref, null, 0, 'build-failed');
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    if (request.answered()) return;
    if (packet === null || !packet.ok) {
      write(ref, null, 0, packet === null ? 'no-packet' : packet.reason);
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    write(ref, packet.revision, packet.bytes, 'sent');
    request.respond({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: packet.text } });
  }

  return {
    handle(request) {
      let body: unknown;
      try {
        body = JSON.parse(request.text);
      } catch {
        request.reject(400, 'json');
        return;
      }
      const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
      if (record === undefined) {
        request.reject(400, 'json');
        return;
      }
      if (record['hook_event_name'] !== 'SessionStart' || record['source'] !== 'compact') {
        request.reject(400, 'event');
        return;
      }
      // Срез — только провайдер `claude`: у GLM и прочих аккаунтов моста в файле настроек нет.
      if (request.provider !== 'claude') {
        request.reject(400, 'provider');
        return;
      }
      void (async (): Promise<void> => {
        let on = false;
        try {
          on = await enabled();
        } catch (error) {
          deps.log.warn('пакет комнаты: настройка не прочитана', { error: String(error) });
        }
        if (request.answered()) return;
        if (!on) {
          request.respond(EMPTY_HOOK_RESPONSE);
          return;
        }
        // Опыт: правило то же, что при установке моста; плечо читается из карты, а не из запроса.
        let held: Pick<WorkSession, 'trial'> | undefined;
        try {
          held = await sessionOf(request.ref);
        } catch (error) {
          // Карта не читается — сессия считается без плеча: пока опыт идёт, это отказ `not-in-trial`, а не пакет.
          deps.log.warn('пакет комнаты: плечо опыта не прочитано', { error: String(error) });
        }
        let name: string;
        try {
          name = await trial();
        } catch (error) {
          deps.log.warn('пакет комнаты: имя опыта не прочитано', { error: String(error) });
          if (!request.answered()) request.respond(EMPTY_HOOK_RESPONSE);
          return;
        }
        const gate = packetGate(held, name);
        if (request.answered()) return;
        if (!gate.ok) {
          write(request.ref, null, 0, gate.reason);
          request.respond(EMPTY_HOOK_RESPONSE);
          return;
        }
        const fault = parsePacketFault(faultValue());
        if (fault?.kind === 'drop') {
          request.destroy();
          return;
        }
        if (fault?.kind === 'delay') {
          const timer = setTimeout(() => {
            if (!request.answered()) void answer(request);
          }, fault.ms);
          timer.unref();
          // Соединение закрыто раньше срока: таймер не держит ни хост, ни остановку.
          request.onAbandon(() => clearTimeout(timer));
          return;
        }
        await answer(request);
      })();
    },
  };
}
