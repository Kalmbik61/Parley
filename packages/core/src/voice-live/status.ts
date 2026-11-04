/**
 * Статус поручений («ну что там?», спека «Голос↔Ассистент» §6, основной путь, T6). На каждое изменение состояния
 * открытого Request мост отправляет в Live `thinking.append` с компактным статусом и временем. Live отвечает на вопрос
 * из этого контекста и называет время, job заново не запускается.
 *
 * - Один статус на Request и состояние: повторный опрос того же состояния ничего не шлёт (дросселирование).
 * - Правило подтверждений (`ack.ts`): статус — `progress`; прогресс своей делегации уходит сразу, чужой или без привязки
 *   (восстановление) ждёт, пока открытые делегации не получат подтверждение или не выйдет их срок (2,5 с).
 * - Формулировка пригодна для озвучки: append в простое Live может произнести сам (T0), поэтому без id, refs и разметки.
 * - Итог и терминальные состояния сюда не попадают: итог идёт очередью речи (`speech-queue.ts`) как `commentary.append`.
 * Текст Request — речь человека: он уходит только в Live и в журнал не пишется.
 */
import { normalizeHumanText } from '../assistant/text.js';
import type { AppendPurpose } from './ack.js';

export const STATUS_TEXT_CHARS = 80;

export type StatusJobState = 'queued' | 'running' | 'needs_confirmation' | 'completed' | 'failed' | 'cancelled';

export interface StatusInput {
  requestId: string;
  /** Текст поручения (речь человека); в статус уходит нормализованным и коротким. */
  text: string;
  state: StatusJobState;
  /** Request вытеснен уточнением: его статус не нужен. */
  stale: boolean;
  /** Когда хост принял Request, мс эпохи (часы хоста; `now` уведомителя — те же часы Mac). */
  createdAt: number;
  /** Делегация этой Live-сессии; `null` — восстановление. */
  delegationId: string | null;
}

export interface StatusNotifierDeps {
  /** Настенные часы (мс эпохи): возраст считается от `createdAt` хоста, время снимка — местное. */
  now(): number;
  /** `AckTracker.canAppend`. */
  canAppend(delegationId: string | null, purpose: AppendPurpose): boolean;
  /** `false` — Live не принял (канал закрыт): статус остаётся ждать. */
  send(input: { delegationId: string | null; content: string }): boolean;
}

export interface StatusNotifier {
  /** Идемпотентно: вид Request запоминается, статус готовится только при смене состояния. */
  observe(inputs: readonly StatusInput[]): void;
  /** Отправляет подготовленные статусы, которые правило подтверждений уже пропускает. */
  step(): void;
  /** Новая сессия Live: прежний контекст у модели потерян, статусы открытых Request нужны заново. */
  reset(): void;
}

const isOpen = (state: StatusJobState): boolean => state === 'queued' || state === 'running';

const two = (value: number): string => String(value).padStart(2, '0');

/** Местное время снимка, `14:05`. */
export function clockOf(at: number): string {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Возраст словами: «40 seconds», «3 minutes», «1 hour 5 minutes». */
export function ageWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const head = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest === 0 ? head : `${head} ${rest} minute${rest === 1 ? '' : 's'}`;
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);

/** Сам текст статуса: время снимка, что за поручение, состояние и сколько оно длится. Английский: модель говорит на языке человека. */
export function statusContent(input: StatusInput, at: number): string {
  const quoted = clip(normalizeHumanText(input.text, {}).replaceAll('"', "'"), STATUS_TEXT_CHARS);
  const subject = quoted === '' ? 'the request' : `the request "${quoted}"`;
  const age = ageWords(at - input.createdAt);
  const time = clockOf(at);
  return input.state === 'queued'
    ? `Status as of ${time}: ${subject} is waiting in line, asked ${age} ago. No result yet.`
    : `Status as of ${time}: still working on ${subject}, started ${age} ago. No result yet.`;
}

export function createStatusNotifier(deps: StatusNotifierDeps): StatusNotifier {
  /** Состояние, о котором модели уже сообщено. */
  const sent = new Map<string, StatusJobState>();
  const pending = new Map<string, StatusInput>();

  return {
    observe(inputs) {
      for (const input of inputs) {
        if (input.stale || !isOpen(input.state)) {
          pending.delete(input.requestId);
          continue;
        }
        if (sent.get(input.requestId) === input.state) {
          pending.delete(input.requestId);
          continue;
        }
        pending.set(input.requestId, input);
      }
    },
    step() {
      for (const input of [...pending.values()]) {
        if (!deps.canAppend(input.delegationId, 'progress')) continue;
        if (!deps.send({ delegationId: input.delegationId, content: statusContent(input, deps.now()) })) return;
        sent.set(input.requestId, input.state);
        pending.delete(input.requestId);
      }
    },
    reset() {
      sent.clear();
      pending.clear();
    },
  };
}
