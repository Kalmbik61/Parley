/**
 * Протокол держит свои копии пределов окна (он не импортирует код окна): размеры Custom…, пресеты меню размеров и
 * длину адреса. Здесь сверка, что копии не разошлись (этапы C и D браузерной спеки 2026-10-07).
 */
import { describe, expect, it } from 'vitest';
import { AGENT_INPUT, AGENT_VIEWPORT, AGENT_VIEWPORT_PRESETS } from '@parley/protocol';
import { DEVTOOLS_LIMITS, VIEWPORT_PRESETS } from './browser-devtools.js';

describe('пределы канала агента совпадают с окном', () => {
  it('размер снимка и resize — те же пределы, что Custom… меню размеров', () => {
    expect(AGENT_VIEWPORT).toEqual({ min: DEVTOOLS_LIMITS.customMin, maxWidth: DEVTOOLS_LIMITS.customMaxWidth, maxHeight: DEVTOOLS_LIMITS.customMaxHeight });
  });

  it('пресеты resize — пресеты окна в том же порядке', () => {
    expect([...AGENT_VIEWPORT_PRESETS]).toEqual(Object.keys(VIEWPORT_PRESETS));
  });

  it('адрес агента не длиннее адреса журнала', () => {
    expect(AGENT_INPUT.url).toBe(DEVTOOLS_LIMITS.url);
  });
});
