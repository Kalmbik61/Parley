/**
 * Конфиг сессии GPT-Live для `voice.session.prepare` (спека голоса↔ассистента §3, итоги T0 §f).
 * Инструкции после старта не меняются, дополнения идут через `session.instructions.append`.
 * `delegation.acknowledgement_delay_ms` не задаётся: максимум 800, с ним подтверждение приходит позже, а следующая
 * фраза человека в T0 игнорировалась (3 из 3).
 */
import { LIVE_MODEL } from './live-client.js';

/**
 * Шаблон `Generate … when / Do not generate … when` из руководства live-prompting со списком областей Parley.
 * Подтверждение формирует сама модель; строка про «одно короткое» — только управление длиной.
 * Без идентификаторов в речи; о действиях — «подготовил карточку, подтвердите на экране».
 */
export const VOICE_PROMPT = [
  "You are Parley's voice assistant, a calm, friendly voice companion. Speak briefly, at most two sentences.",
  'Backchannel policy: Use minimal backchannels.',
  'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
  'Delegation policy:',
  'Backend tools:',
  "- Parley assistant: knows the state of Parley rooms, sessions, background jobs, works and builds, and can prepare actions for the user to confirm on screen.",
  'Generate <|SpawnThinking|> when:',
  '- The user asks about the state of rooms, sessions, jobs, works, builds or anything else in Parley.',
  '- The user asks to create or change something in Parley.',
  '- A correction changes work already requested.',
  'Do not generate <|SpawnThinking|> when:',
  '- The user greets you or makes small talk.',
  '- You can answer from the conversation or a still-current result.',
  '- You need a brief clarification.',
  'Generate <|SpawnThinking|> before giving an answer that depends on backend work.',
  'Do not guess the result while waiting. After you hand off work, give exactly one very short spoken acknowledgment, then keep chatting normally.',
  'When a result arrives, recap it briefly, tie it to the question it answers, and say how old the snapshot is.',
  'Never speak identifiers, ids, hashes or long numbers; use names instead.',
  'When the result says an action was prepared, say that you prepared a card and the user should confirm it on the screen. Never say an action was done before the user confirms.',
  'Speak in the language the user speaks.',
].join('\n');

/** Эмоции лица острова, которые GPT-Live выбирает через Decisions (V2; совпадает с `SwarmEmotion` без `error`). */
export const LIVE_EMOTIONS = ['calm', 'joy', 'sad', 'surprise', 'anger'] as const;

/**
 * Decisions-триггер эмоции (записка V0 `docs/research/2026-11-05-gpt-live-decisions-spike.md` §2): на каждый фрагмент
 * исходящего транскрипта модель Decisions выбирает одно из пяти значений. Задаётся при создании сессии, ровно как в V0.
 * Делегация остаётся `client`; `model` в триггере не указывается.
 */
export const EMOTION_TRIGGER = {
  type: 'decisions',
  event_type: 'session.output_transcript.delta',
  decisions: {
    questions: [
      {
        type: 'choice',
        name: 'expression',
        instructions: 'Pick the emotion of what the assistant is saying right now.',
        choices: LIVE_EMOTIONS.map((value) => ({ value })),
      },
    ],
  },
} as const;

/**
 * Тело `session` для `POST /v1/live/sessions`. Остров и телефон получают одно и то же: инструкции, клиентскую делегацию
 * и триггер эмоции (Decisions тарифицируется отдельно).
 */
export function liveSessionConfig(): Record<string, unknown> {
  return { model: LIVE_MODEL, instructions: VOICE_PROMPT, delegation: { type: 'client' }, triggers: [EMOTION_TRIGGER] };
}
