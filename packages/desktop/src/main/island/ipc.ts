/**
 * Каналы острова в main (спека 2026-10-12, 5.1). Каждый слушает только окно острова (`controller.isIsland`):
 * чужое окно с тем же именем канала ничего не двигает. Данные проверяются по форме: видимость — булево, точка — два
 * числа, область под мышь — `null` или четыре конечных числа (размеры не отрицательны, значения не больше
 * `MAX_HIT_RECT_VALUE`), цель — `isFocusTarget`, как у уведомлений, «просмотрено» — от 1 до `ISLAND_MARK_SEEN_LIMIT` ссылок на сессии
 * (`sessionRef` протокола).
 *
 * Нейроголос (план 3b, B15): остров просит порт (`island:tts-connect`), main создаёт `MessageChannelMain` и отдаёт
 * `port2` только окну острова. Куски, срыв по длине и состояние движка идут по этому одному порту по порядку — срыв
 * не обгонит кусок и не отстанет от него. Синтез, прогрев и значок динамика — `invoke`; чужое окно получает
 * `forbidden`, негодный запрос — `bad_request`.
 */

import type { IpcMain } from 'electron';
import { sessionRef, type SessionRef } from '@parley/protocol';
import type { FocusTarget } from '../../shared/bridge.js';
import {
  ISLAND_MARK_SEEN_LIMIT,
  ISLAND_TTS_TEXT_LIMIT,
  type IslandConfig,
  type IslandHitRect,
  type IslandPoint,
  type IslandSpeakRequest,
  type IslandTtsMessage,
  type SessionVisibilitySnapshot,
} from '../../shared/island.js';
import { isAssistantVoiceId } from '../../shared/tts-types.js';
import type { UiFile } from '../../shared/ui-types.js';
import { isVoiceLanguage } from '../../shared/voice-types.js';
import type { TtsService } from '../assistant/tts.js';
import { HostError } from '../host-connection.js';
import { isFocusTarget, withIpcError } from '../ipc.js';
import type { UiStore } from '../ui-store.js';
import type { IslandController, IslandWindowLike } from './window.js';

/** Сторона main порта голоса (`MessagePortMain`): только отправка. */
export interface TtsPort {
  postMessage(message: IslandTtsMessage): void;
  close(): void;
}

export interface IslandIpcOptions {
  ipcMain: Pick<IpcMain, 'on' | 'handle'>;
  controller: Pick<IslandController<IslandWindowLike>, 'isIsland' | 'setHitRect' | 'setVisible' | 'dragStart' | 'dragMove' | 'dragEnd'>;
  config(): Promise<IslandConfig>;
  visibility(): SessionVisibilitySnapshot;
  /** Место могло смениться (другой монитор — другой отступ под чёлку): отдать острову настройки заново. */
  pushConfig(): void;
  /** Режим помощника: панель берёт клавиатуру (`true`) или отдаёт её прежнему приложению (`false`). */
  keyboard(on: boolean): void;
  openTarget(target: FocusTarget): void;
  beep(): void;
  /** Clear на острове: сессии просмотрены — хосту уходит `activity.seen` по каждой (список уже проверен). */
  markSeen(refs: SessionRef[]): void;
  /** Отрисовка острова упала (`IslandErrorBoundary`): окно больше не показывает запросы. */
  onFailed(): void;
  /** Нейроголос (B10). */
  tts: Pick<TtsService, 'speak' | 'cancel' | 'cancelAll' | 'warmup' | 'state' | 'onState'>;
  /** Новый канал порта голоса: `new MessageChannelMain()`. */
  ttsChannel(): { port1: TtsPort; port2: unknown };
  /** Значок динамика пишет `assistant.speak` в ui.json. */
  uiStore: Pick<UiStore, 'save'>;
  /** Тот же путь, что после сохранения из Settings: конфиг острова и зеркало хосту. */
  onUiSaved(): void;
}

function isPoint(value: unknown): value is IslandPoint {
  if (typeof value !== 'object' || value === null) return false;
  const { screenX, screenY } = value as Record<string, unknown>;
  return typeof screenX === 'number' && Number.isFinite(screenX) && typeof screenY === 'number' && Number.isFinite(screenY);
}

/** Верхняя граница чисел области под мышь: кадр окна — 480×520, всё, что заметно больше, — мусор. */
const MAX_HIT_RECT_VALUE = 2000;

function isHitRect(value: unknown): value is IslandHitRect {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  const fits = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n <= MAX_HIT_RECT_VALUE;
  return fits(x) && fits(y) && fits(width) && width >= 0 && fits(height) && height >= 0;
}


/** Список ссылок для «просмотрено»: каждая прошла `sessionRef` (лишние поля срезаны) или `null`, если форма негодна. */
function parseSeenRefs(value: unknown): SessionRef[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > ISLAND_MARK_SEEN_LIMIT) return null;
  const refs: SessionRef[] = [];
  for (const item of value) {
    const parsed = sessionRef.safeParse(item);
    if (!parsed.success) return null;
    refs.push(parsed.data);
  }
  return refs;
}

/** Предел id предложения: id задаёт остров, в main он только ключ. */
const UTTERANCE_ID_MAX = 200;

function isUtteranceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= UTTERANCE_ID_MAX;
}

/** Запрос `island:tts-speak` или `null`: текст не пустой и до `ISLAND_TTS_TEXT_LIMIT`, голос каталога, язык Whisper. */
function parseSpeakRequest(value: unknown): IslandSpeakRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { utteranceId, text, voice, language } = value as Record<string, unknown>;
  if (!isUtteranceId(utteranceId) || !isAssistantVoiceId(voice)) return null;
  if (typeof text !== 'string' || text.trim() === '' || text.length > ISLAND_TTS_TEXT_LIMIT) return null;
  if (!isVoiceLanguage(language) || language === 'auto') return null;
  return { utteranceId, text, voice, language };
}

/** Окно, которому main передаёт порт (`WebContents.postMessage`). */
interface PortTarget {
  postMessage(channel: string, message: unknown, transfer: unknown[]): void;
}

export function registerIslandIpc(options: IslandIpcOptions): void {
  const { ipcMain, controller, tts } = options;
  const fromIsland = (event: unknown): boolean => controller.isIsland((event as { sender?: unknown }).sender);
  const islandOnly = (event: unknown, channel: string): void => {
    if (!fromIsland(event)) throw new HostError('forbidden', `${channel} is for the island window only`);
  };
  /** Порт голоса живой страницы острова; `null` — остров его ещё не просил. */
  let port: TtsPort | null = null;
  tts.onState((state) => port?.postMessage({ type: 'state', state }));

  ipcMain.handle('island:session-visibility', withIpcError((event) => {
    if (!fromIsland(event)) throw new Error('island:session-visibility is for the island window only');
    return options.visibility();
  }));

  ipcMain.handle(
    'island:config',
    withIpcError(async (event) => {
      if (!fromIsland(event)) throw new Error('island:config is for the island window only');
      return options.config();
    }),
  );
  ipcMain.on('island:hit-rect', (event, rect: unknown) => {
    if (fromIsland(event) && (rect === null || isHitRect(rect))) controller.setHitRect(rect);
  });
  ipcMain.on('island:visible', (event, visible: unknown) => {
    if (fromIsland(event) && typeof visible === 'boolean') controller.setVisible(visible);
  });
  ipcMain.on('island:keyboard', (event, on: unknown) => {
    if (fromIsland(event) && typeof on === 'boolean') options.keyboard(on);
  });
  ipcMain.on('island:drag-start', (event, point: unknown) => {
    if (fromIsland(event) && isPoint(point)) controller.dragStart(point);
  });
  ipcMain.on('island:drag-move', (event, point: unknown) => {
    if (fromIsland(event) && isPoint(point)) controller.dragMove(point);
  });
  ipcMain.on('island:drag-end', (event, point: unknown) => {
    if (!fromIsland(event) || !isPoint(point)) return;
    controller.dragEnd(point);
    options.pushConfig();
  });
  ipcMain.on('island:open', (event, target: unknown) => {
    if (fromIsland(event) && isFocusTarget(target)) options.openTarget(target);
  });
  ipcMain.on('island:beep', (event) => {
    if (fromIsland(event)) options.beep();
  });
  ipcMain.on('island:mark-seen', (event, refs: unknown) => {
    if (!fromIsland(event)) return;
    const parsed = parseSeenRefs(refs);
    if (parsed !== null) options.markSeen(parsed);
  });
  ipcMain.on('island:failed', (event) => {
    if (fromIsland(event)) options.onFailed();
  });

  ipcMain.on('island:tts-connect', (event) => {
    if (!fromIsland(event)) return;
    // Новый порт — новая страница острова: речь прежней ей уже не нужна.
    if (port !== null) {
      port.close();
      tts.cancelAll();
    }
    const channel = options.ttsChannel();
    port = channel.port1;
    (event as { sender: PortTarget }).sender.postMessage('island:tts-port', null, [channel.port2]);
    port.postMessage({ type: 'state', state: tts.state() });
  });
  ipcMain.handle(
    'island:tts-speak',
    withIpcError((event, value) => {
      islandOnly(event, 'island:tts-speak');
      const request = parseSpeakRequest(value);
      if (request === null) throw new HostError('bad_request', 'invalid island:tts-speak request');
      // Куски, срыв и повтор — в порт, который был при запросе, по порядку.
      const target = port;
      return tts.speak(request, (chunk) => target?.postMessage({ type: 'chunk', chunk }), {
        onDiscard: (utteranceId, fromSeq) => target?.postMessage({ type: 'discard', utteranceId, fromSeq }),
      });
    }),
  );
  ipcMain.on('island:tts-cancel', (event, utteranceId: unknown) => {
    if (!fromIsland(event)) return;
    if (utteranceId === null) tts.cancelAll();
    else if (isUtteranceId(utteranceId)) tts.cancel(utteranceId);
  });
  ipcMain.handle(
    'island:tts-warmup',
    withIpcError((event) => {
      islandOnly(event, 'island:tts-warmup');
      return tts.warmup();
    }),
  );
  ipcMain.handle(
    'island:assistant-speak',
    withIpcError(async (event, on: unknown) => {
      islandOnly(event, 'island:assistant-speak');
      if (typeof on !== 'boolean') throw new HostError('bad_request', 'island:assistant-speak expects a boolean');
      await options.uiStore.save({ assistant: { speak: on } } as Partial<Omit<UiFile, 'version'>>);
      options.onUiSaved();
    }),
  );
}
