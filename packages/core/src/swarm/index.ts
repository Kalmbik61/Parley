/**
 * Рой душ лица помощника: спека облика, движок кадра и чистая математика голоса. Чистый TS без Node и DOM: общий для
 * острова и телефона, отрисовка у каждой платформы своя (`SwarmSink`). Подпуть `@parley/core/swarm` не тянет корневой
 * индекс core (проверяет `import-guard.test.ts`).
 */
export * from './spec.js';
export * from './engine.js';
export * from './voice-features.js';
