/**
 * Core держит свою копию схем инструментов `browser_*` (`core/src/mcp/browser-tools.ts`): он не импортирует протокол.
 * Протокол видит оба пакета — здесь сверка, что схемы MCP, умолчания и подсказки не разошлись с zod протокола.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BROWSER_TOOL_HINTS, BROWSER_TOOL_OPS, BROWSER_TOOLS, PARLEY_BROWSER_SKILL_MD } from '@parley/core';
import { AGENT_DEFAULTS, BROWSER_AGENT_ERROR_CODES, browserAgentArgs } from './browser-agent.js';

const KEYS = ['type', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum'] as const;

interface JsonSchema {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: unknown;
}

/** Из схемы — то, что должно совпадать: свойства (только ограничения), обязательные поля, закрытость. */
function pick(schema: JsonSchema) {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    // zod дописывает целому без пределов границы безопасного целого; в схеме MCP их нет, и это не расхождение.
    const isSafeBound = (key: string) => (key === 'maximum' && property[key] === Number.MAX_SAFE_INTEGER) || (key === 'minimum' && property[key] === Number.MIN_SAFE_INTEGER);
    properties[name] = Object.fromEntries(KEYS.filter((key) => key in property && !isSafeBound(key)).map((key) => [key, property[key]]));
  }
  return { properties, required: [...(schema.required ?? [])].sort(), additionalProperties: schema.additionalProperties };
}

describe('схемы MCP core и zod протокола', () => {
  it('схемы MCP core совпадают с zod протокола', () => {
    for (const op of BROWSER_TOOL_OPS) {
      const tool = BROWSER_TOOLS.find((candidate) => candidate.name === `browser_${op}`);
      expect(tool, op).toBeDefined();
      const zod = z.toJSONSchema(browserAgentArgs[op]) as JsonSchema;
      expect(pick(tool!.inputSchema as JsonSchema), op).toEqual(pick(zod));
    }
  });

  it('умолчания схем MCP равны AGENT_DEFAULTS', () => {
    const defaults: Record<string, unknown> = {};
    for (const tool of BROWSER_TOOLS) {
      for (const [name, property] of Object.entries((tool.inputSchema as JsonSchema).properties ?? {})) {
        if ('default' in property) defaults[name] = property.default;
      }
    }
    expect(defaults).toEqual(AGENT_DEFAULTS);
  });

  it('ключи BROWSER_TOOL_HINTS — коды BROWSER_AGENT_ERROR_CODES', () => {
    for (const code of Object.keys(BROWSER_TOOL_HINTS)) {
      expect(BROWSER_AGENT_ERROR_CODES as readonly string[], code).toContain(code);
    }
  });

  it('скилл parley-browser объясняет каждый код ошибки канала', () => {
    for (const code of BROWSER_AGENT_ERROR_CODES) expect(PARLEY_BROWSER_SKILL_MD, code).toContain(`| \`${code}\` |`);
  });
});
