import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools.js';
import { CREATE_SESSION_TOOL } from './session-tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from './swarm-tools.js';

/**
 * Описания инструментов уходят модели на каждом ходу каждого агента, поэтому их размер держит тест (план
 * 2026-10-27, решение 2). Потолки — от замера на 5f4dd71a: все строки `description` весили 10 226 байт,
 * JSON схем целиком — 25 742. Цель: описания не больше 5 600 байт (−45 %), JSON не больше 21 000 (−18 %).
 * Правила и исключения живут в `read_guide`, а не в описаниях.
 * Потолки подняты ровно на `get_capacity` (план 3, спека 4.3): описание 232 байта, схема целиком 386 с запятой —
 * прежний запас остался прежним.
 * Ещё подняты ровно на `plan_progress` и `plan_tasks` (задания комнаты): строки description — 357 байт, JSON обоих
 * инструментов с запятыми — 1421; запас прежний. Нужны они, чтобы агент не терял позицию на пункте плана и видел
 * свои задания, когда письмо уже прочитано.
 */
const DESCRIPTIONS_MAX_BYTES = 5600 + 232 + 357;
const SCHEMAS_MAX_BYTES = 21000 + 386 + 1421;

/** Сумма байт всех строк `description` на любой глубине схемы (описания свойств включены). */
function descriptionBytes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + descriptionBytes(item), 0);
  if (node === null || typeof node !== 'object') return 0;
  let sum = 0;
  for (const [key, value] of Object.entries(node)) {
    sum += key === 'description' && typeof value === 'string' ? Buffer.byteLength(value) : descriptionBytes(value);
  }
  return sum;
}

const ALL_TOOLS = [...TOOLS, CREATE_SESSION_TOOL];

describe('размер описаний инструментов MCP', () => {
  it(`все строки description в TOOLS и create_session — не больше ${DESCRIPTIONS_MAX_BYTES} байт`, () => {
    expect(descriptionBytes(ALL_TOOLS)).toBeLessThanOrEqual(DESCRIPTIONS_MAX_BYTES);
  });

  it(`JSON схем TOOLS и create_session целиком — не больше ${SCHEMAS_MAX_BYTES} байт`, () => {
    expect(Buffer.byteLength(JSON.stringify(ALL_TOOLS))).toBeLessThanOrEqual(SCHEMAS_MAX_BYTES);
  });
});

/**
 * Инструменты роя (спека роя v1, 4) уходят модели вместе с `create_session`, но их потолок отдельный: общие потолки выше
 * держат прежний набор и не раздвинуты.
 */
const SWARM_DESCRIPTIONS_MAX_BYTES = 700;
const SWARM_SCHEMAS_MAX_BYTES = 2200;
const SWARM_TOOLS = [CREATE_SWARM_TOOL, SWARM_ADD_TOOL];

describe('размер описаний инструментов роя', () => {
  it(`строки description create_swarm и swarm_add — не больше ${SWARM_DESCRIPTIONS_MAX_BYTES} байт`, () => {
    expect(descriptionBytes(SWARM_TOOLS)).toBeLessThanOrEqual(SWARM_DESCRIPTIONS_MAX_BYTES);
  });

  it(`JSON схем create_swarm и swarm_add целиком — не больше ${SWARM_SCHEMAS_MAX_BYTES} байт`, () => {
    expect(Buffer.byteLength(JSON.stringify(SWARM_TOOLS))).toBeLessThanOrEqual(SWARM_SCHEMAS_MAX_BYTES);
  });
});
