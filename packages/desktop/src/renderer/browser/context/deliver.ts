/**
 * Доставка файла-контекста в цель «To» (спека браузера 4.5). Ничего не уходит агенту само:
 * - сессия с видом Chat (`feedAvailableNow(provider)`) — путь `.md` во вложения её поля (`useChatUiStore.attachments`);
 *   при Send `composePrompt` допишет снимок;
 * - сессия без Chat — одна строка в ввод CLI без Enter (`sendWithToast(…, submit: false)`); отказы (`blocked` и прочие) —
 *   тостами `sendWithToast`, как у любой отправки окна (таблица 8.6 спеки окна);
 * - комната — путь во вложения поля комнаты (`composerAttachments`), при отправке — список «Attachments:».
 * Тост «N elements added to S02»: «Open» открывает цель (сессию — в виде Chat), «Undo» убирает добавленные пути.
 * Добавления подряд в одну цель, пока тост на экране, копятся в нём счётчиком.
 */

import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { SavedContext } from '../../../shared/browser-types.js';
import type { ContextKind } from '../../../shared/context-markdown.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import type { BrowserTarget } from '../../../shared/layout-types.js';
import { errorText, S } from '../../../shared/strings.js';
import { workKey as workKeyOf } from '../../../shared/work-keys.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../../attention/focus-target.js';
import { addAttachments } from '../../chat/attachments.js';
import { rememberContextImage } from '../../chat/context-attachments.js';
import { useChatUiStore } from '../../chat/ui-store.js';
import { tabId } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { updateTab } from '../../layout/tree.js';
import { feedAvailableNow } from '../../lib/feed-view.js';
import { roomKey } from '../../lib/room-view.js';
import { useUiStore } from '../../store/ui.js';
import { shellQuote } from '../../terminal/drop.js';
import { sendWithToast, type SendWithToastDeps } from '../../terminal/send.js';
import { targetKey, targetName } from './targets.js';

/** Файл-контекст до записи: Markdown окна, снимок в `drops/` (или нет) и число пунктов для тоста. */
export interface ContextDraft {
  kind: ContextKind;
  label: string;
  markdown: string;
  imagePath: string | null;
  count: number;
  /** Что вернуть по «Undo», кроме путей: аннотации возвращают пачку в лоток. */
  onUndo?: () => void;
}

/** Записанный файл-контекст. */
export interface ContextItem {
  kind: ContextKind;
  label: string;
  mdPath: string;
  pngPath: string | null;
  count: number;
  onUndo?: () => void;
}

/** Куда ведёт «Open» тоста. */
export type OpenTarget =
  | { kind: 'session'; ref: SessionRef; chat: boolean }
  | { kind: 'room'; projectPath: string; workId: string; roomId: string };

export interface DeliverDeps {
  entry: WorkEntry;
  target: BrowserTarget;
  sendDeps: SendWithToastDeps;
  /** Есть ли вид Chat у провайдера сейчас; по умолчанию — `feedAvailableNow`. */
  chatAvailable?: (provider: string) => boolean;
  /** «Open» тоста; по умолчанию — `openContextTarget`. */
  open?: (target: OpenTarget) => void;
  now?: () => number;
}

export type Delivered = 'chat' | 'terminal' | 'room' | 'failed';

/** Столько тост держится и столько копит добавления подряд в одну цель. */
export const CONTEXT_TOAST_MS = 6000;

interface Batch {
  key: string;
  toastId: string;
  at: number;
  count: number;
  kinds: Set<ContextKind>;
  /** `null` — в пачке есть строка, вставленная в ввод CLI: её не убрать, «Undo» нет. */
  undo: Array<() => void> | null;
}

let batch: Batch | null = null;
let toastSeq = 0;

/** «Open» по умолчанию: работа, вкладка цели и фокус; сессия с Chat — сразу в виде Chat. */
export function openContextTarget(target: OpenTarget): void {
  const deps = buildFocusTargetDeps();
  if (target.kind === 'room') {
    applyFocusTarget({ kind: 'room', projectPath: target.projectPath, workId: target.workId, roomId: target.roomId }, deps);
    return;
  }
  if (!applyFocusTarget({ kind: 'session', ref: target.ref }, deps) || !target.chat) return;
  const key = workKeyOf(target.ref.projectPath, target.ref.workId);
  useLayoutStore.getState().apply(key, (layout) => updateTab(layout, tabId.terminal(target.ref.sessionId), { view: 'chat' }));
}

/** Путь в ввод CLI: с пробелами и кавычками — в shell-кавычках, как бросок файла в терминал. */
function quoted(path: string): string {
  return /[\s'"\\]/.test(path) ? shellQuote(path) : path;
}

function removeFromChat(sessionKey: string, path: string): void {
  const state = useChatUiStore.getState();
  state.setAttachments(sessionKey, (state.attachments[sessionKey] ?? []).filter((item) => item !== path));
}

function removeFromRoom(draftKey: string, path: string): void {
  const state = useUiStore.getState();
  state.setComposerAttachments(draftKey, (state.composerAttachments[draftKey] ?? []).filter((item) => item !== path));
}

function announce(item: ContextItem, deps: DeliverDeps, undo: (() => void) | null, open: OpenTarget): void {
  const now = (deps.now ?? Date.now)();
  const key = `${workKeyOf(deps.entry.projectPath, deps.entry.map.work.id)}\n${targetKey(deps.target)}`;
  if (batch === null || batch.key !== key || now - batch.at > CONTEXT_TOAST_MS) {
    toastSeq += 1;
    batch = { key, toastId: `browser-context-${toastSeq}`, at: now, count: 0, kinds: new Set(), undo: [] };
  }
  const current = batch;
  current.at = now;
  current.count += item.count;
  current.kinds.add(item.kind);
  if (undo === null) {
    current.undo = null;
  } else {
    current.undo?.push(() => {
      undo();
      item.onUndo?.();
    });
  }
  const kinds = [...current.kinds];
  const what = kinds.length === 1 && kinds[0] !== undefined ? kinds[0] : 'mixed';
  const openTarget = deps.open ?? openContextTarget;
  const steps = current.undo;
  toast(S.browser.target.added(current.count, what, targetName(deps.entry, deps.target)), {
    id: current.toastId,
    duration: CONTEXT_TOAST_MS,
    action: { label: S.browser.target.open, onClick: () => openTarget(open) },
    ...(steps === null
      ? {}
      : {
          cancel: {
            label: S.browser.target.undo,
            onClick: () => {
              for (const step of steps) step();
              if (batch === current) batch = null;
            },
          },
        }),
  });
}

export async function deliverContext(item: ContextItem, deps: DeliverDeps): Promise<Delivered> {
  const { entry, target } = deps;
  const projectPath = entry.projectPath;
  const workId = entry.map.work.id;
  if (target.kind === 'room') {
    const draftKey = roomKey(workKeyOf(projectPath, workId), target.roomId);
    const ui = useUiStore.getState();
    ui.setComposerAttachments(draftKey, addAttachments(ui.composerAttachments[draftKey] ?? [], [item.mdPath]));
    announce(item, deps, () => removeFromRoom(draftKey, item.mdPath), { kind: 'room', projectPath, workId, roomId: target.roomId });
    return 'room';
  }
  const session = entry.map.sessions.find((candidate) => candidate.id === target.sessionId);
  if (session === undefined) return 'failed';
  const ref: SessionRef = { projectPath, workId, sessionId: session.id };
  if ((deps.chatAvailable ?? feedAvailableNow)(session.provider)) {
    const sessionKey = refKey(ref);
    const chat = useChatUiStore.getState();
    chat.setAttachments(sessionKey, addAttachments(chat.attachments[sessionKey] ?? [], [item.mdPath]));
    announce(item, deps, () => removeFromChat(sessionKey, item.mdPath), { kind: 'session', ref, chat: true });
    return 'chat';
  }
  const line = S.contextFile.terminalLine(item.kind, item.label, quoted(item.mdPath), item.pngPath === null ? null : quoted(item.pngPath));
  const outcome = await sendWithToast(deps.sendDeps, ref, line, false);
  if ('error' in outcome || !outcome.inserted) return 'failed';
  // Вставка с оговоркой (draft, input, restarted…) уже дала свой тост; без оговорки тоста у sendWithToast нет — наш.
  if (outcome.reason === null) announce(item, deps, null, { kind: 'session', ref, chat: false });
  return 'terminal';
}

/** «Add to chat» целиком: запись файла в main, снимок — в реестр окна, путь — в цель. */
export async function addContext(draft: ContextDraft, deps: DeliverDeps & { bridge: ParleyBridge }): Promise<Delivered> {
  let saved: SavedContext;
  try {
    saved = await deps.bridge.browser.saveContext({ kind: draft.kind, label: draft.label, markdown: draft.markdown, imagePath: draft.imagePath });
  } catch (error) {
    const { code, message } = decodeIpcError(error);
    console.warn('[parley] saveContext', message);
    toast.error(errorText(code, S.errors.actions.addToChat));
    return 'failed';
  }
  if (saved.pngPath !== null) rememberContextImage(saved.mdPath, saved.pngPath);
  const item: ContextItem = {
    kind: draft.kind,
    label: draft.label,
    mdPath: saved.mdPath,
    pngPath: saved.pngPath,
    count: draft.count,
    ...(draft.onUndo === undefined ? {} : { onUndo: draft.onUndo }),
  };
  return deliverContext(item, deps);
}

/** Только для тестов. */
export function resetDeliveryForTests(): void {
  batch = null;
  toastSeq = 0;
}
