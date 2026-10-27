/**
 * `data` сообщения окна, с которым preload острова передаёт порт голоса в главный мир (`event.ports[0]`):
 * `contextBridge` порт не пропускает. Отдельный модуль без импортов: preload острова живёт в песочнице и не может
 * `require` пакеты npm, а `shared/island.ts` берёт значения из `@parley/protocol`.
 */
export const ISLAND_TTS_PORT = 'parley:island-tts-port';
