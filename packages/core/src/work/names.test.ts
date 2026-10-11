import { describe, expect, it } from 'vitest';
import { defaultSessionName, NAMES, NEW_LABEL } from './names.js';

describe('NAMES', () => {
  it('60 имён латиницей: короткие, без повторов, с первой буквы заглавной', () => {
    expect(NAMES).toHaveLength(60);
    expect(new Set(NAMES).size).toBe(NAMES.length);
    for (const name of NAMES) {
      expect(name, name).toMatch(/^[A-Z][a-z]+$/);
      expect(name.length, name).toBeLessThanOrEqual(8);
    }
  });

  it('есть имена из разговора с человеком', () => {
    for (const name of ['Ralph', 'Anatoly', 'Ruslan', 'Roman']) expect(NAMES, name).toContain(name);
  });

  it('соседние имена начинаются с разных букв: рядом стоящие сессии не сливаются', () => {
    for (let at = 1; at < NAMES.length; at += 1) {
      expect(NAMES[at]![0], `${NAMES[at - 1]} / ${NAMES[at]}`).not.toBe(NAMES[at - 1]![0]);
    }
  });
});

describe('defaultSessionName', () => {
  it('имя берётся по номеру из s-NN: s-01 — Ralph, s-18 — Nina', () => {
    expect(defaultSessionName('s-01')).toBe(NAMES[0]);
    expect(defaultSessionName('s-01')).toBe('Ralph');
    expect(defaultSessionName('s-18')).toBe('Nina');
    expect(defaultSessionName('s-60')).toBe(NAMES[59]);
  });

  it('в пределах круга все имена разные', () => {
    const names = Array.from({ length: NAMES.length }, (_, at) => defaultSessionName(`s-${String(at + 1).padStart(2, '0')}`));
    expect(new Set(names).size).toBe(NAMES.length);
    expect(names).toEqual([...NAMES]);
  });

  it('после полного круга к имени добавляется номер круга', () => {
    expect(defaultSessionName('s-61')).toBe(`${NAMES[0]} 2`);
    expect(defaultSessionName('s-120')).toBe(`${NAMES[59]} 2`);
    expect(defaultSessionName('s-121')).toBe(`${NAMES[0]} 3`);
    // Имя не повторяется и между кругами.
    expect(defaultSessionName('s-61')).not.toBe(defaultSessionName('s-01'));
  });

  it('ширина номера в id не важна: s-5, s-05 и s-005 — одна сессия', () => {
    expect(defaultSessionName('s-5')).toBe(defaultSessionName('s-05'));
    expect(defaultSessionName('s-005')).toBe(defaultSessionName('s-05'));
  });

  it('id не из этой нумерации или нулевой номер — метка новой сессии, как было до имён', () => {
    for (const id of ['', 's-', 's-00', 'r-01', 'w-0001', 's-01x', 's-1.5', 's--1', 'S-01', 's-99999999999999999999']) {
      expect(defaultSessionName(id), id).toBe(NEW_LABEL);
    }
  });
});
