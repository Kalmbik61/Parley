/**
 * Core не импортирует протокол (тот сам зависит от core) и держит свою копию операций и пределов канала агента
 * (`core/src/mcp/browser-tools.ts`). Хост видит оба пакета — здесь сверка, что копии не разошлись.
 */
import { describe, expect, it } from 'vitest';
import { BROWSER_TOOL_LIMITS, BROWSER_TOOL_OPS } from '@parley/core';
import { AGENT_LIMITS, BROWSER_AGENT_OPS } from '@parley/protocol';

describe('копии core совпадают с протоколом', () => {
  it('инструменты browser_* — ровно операции канала, в том же порядке', () => {
    expect([...BROWSER_TOOL_OPS]).toEqual([...BROWSER_AGENT_OPS]);
  });

  it('пределы инструментов — те же числа, что AGENT_LIMITS', () => {
    for (const [key, value] of Object.entries(BROWSER_TOOL_LIMITS)) {
      expect(AGENT_LIMITS[key as keyof typeof AGENT_LIMITS], key).toBe(value);
    }
  });
});
