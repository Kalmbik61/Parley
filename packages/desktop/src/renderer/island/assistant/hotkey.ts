/**
 * Хоткей помощника выбирает голосовой режим по «Speak answers» (V3): включено — Live-диалог, выключено — запись и
 * Whisper, как раньше. Решение принимается в renderer: main лишь передаёт нажатие (`island:assistant-open`).
 */
import type { LiveCallPhase, LiveStartResult } from '../live/controller.js';

export type HotkeyAction =
  /** Палитра и клик: только открыть вид, печать. */
  | 'open'
  /** Открыть вид и начать запись с Whisper (`openMode({ listen: true })`). */
  | 'whisper'
  | 'live-start'
  | 'live-stop'
  /** Live подключается или закрывается: нажатие ничего не делает. */
  | 'ignore';

export interface HotkeyRouteInput {
  /** `AssistantOpenRequest.listen`: хоткей — `true`. */
  listen: boolean;
  /** `config.assistant.speech.enabled`. */
  speak: boolean;
  phase: LiveCallPhase;
  /** `AssistantStore.input`: идёт ли запись или расшифровка Whisper (человек нажал микрофон). */
  input: 'idle' | 'listening' | 'transcribing' | 'speaking' | 'settling';
  /** Контроллер Live привязан (хост подключён). */
  liveBound: boolean;
}

export function routeHotkey(input: HotkeyRouteInput): HotkeyAction {
  if (!input.listen) return 'open';
  if (input.phase === 'live') return 'live-stop';
  if (input.phase !== 'idle') return 'ignore';
  // Запись Whisper уже идёт: нажатие её останавливает (`openMode`), а не запускает Live поверх.
  if (input.input === 'listening' || input.input === 'transcribing') return 'whisper';
  return input.speak && input.liveBound ? 'live-start' : 'whisper';
}

export interface HotkeyDeps {
  assistant(): { open: boolean; input: HotkeyRouteInput['input']; openMode(request: { listen: boolean }): void };
  live(): { phase: LiveCallPhase; controller: unknown; start(): Promise<LiveStartResult | null>; toggle(): Promise<void> };
}

/**
 * Выполняет решение. Отказ запуска Live (нет ключа, лимит, сбой) — запись Whisper вместо диалога; причину уже показал
 * `live.notice`. `busy` не отказ: диалог уже идёт, и запись ему бы помешала. Если вид успели закрыть, пока шёл запуск,
 * открывать его заново из запасного пути незачем.
 */
export async function runHotkey(request: { listen: boolean }, speak: boolean, deps: HotkeyDeps): Promise<void> {
  const live = deps.live();
  const action = routeHotkey({ listen: request.listen, speak, phase: live.phase, input: deps.assistant().input, liveBound: live.controller !== null });
  if (action === 'ignore') return;
  if (action === 'live-stop') {
    await live.toggle();
    return;
  }
  if (action === 'live-start') {
    deps.assistant().openMode({ listen: false });
    const result = await live.start();
    if (result !== null && !result.ok && result.code !== 'busy' && deps.assistant().open) deps.assistant().openMode({ listen: true });
    return;
  }
  deps.assistant().openMode(request);
}
