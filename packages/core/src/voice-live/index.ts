/**
 * Мост делегаций и очередь речи Live (T4). Чистый TS без Node и DOM: общий для острова и телефона. Подпуть
 * `@parley/core/voice-live` не тянет корневой индекс core (проверяет `import-guard.test.ts`).
 */
export * from './transcript.js';
export * from './ack.js';
export * from './bridge.js';
export * from './speech-queue.js';
export * from './status.js';
export * from './idle-close.js';
export * from './telemetry.js';
export * from './live-events.js';
