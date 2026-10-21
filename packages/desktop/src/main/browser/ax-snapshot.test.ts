/** Дерево доступности для агента (спека браузера 2026-10-07, 5.1, 6): строки, ссылки, маска, предел. */
import { describe, expect, it } from 'vitest';
import { axHasText, axSnapshot, axState, type AxNode } from './ax-snapshot.js';

const NODES: AxNode[] = [
  { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Agent form' }, childIds: ['2', '3', '4', '6', '7', '9'], backendDOMNodeId: 1 },
  {
    nodeId: '2',
    parentId: '1',
    ignored: false,
    role: { value: 'textbox' },
    name: { value: 'Name' },
    value: { value: 'old' },
    properties: [
      { name: 'focusable', value: { value: true } },
      { name: 'focused', value: { value: true } },
    ],
    backendDOMNodeId: 11,
  },
  { nodeId: '3', parentId: '1', ignored: false, role: { value: 'button' }, name: { value: 'Save' }, properties: [{ name: 'focusable', value: { value: true } }], backendDOMNodeId: 12 },
  { nodeId: '4', parentId: '1', ignored: false, role: { value: 'generic' }, childIds: ['5'], backendDOMNodeId: 13 },
  { nodeId: '5', parentId: '4', ignored: false, role: { value: 'StaticText' }, name: { value: 'Hello\n  ```world' }, childIds: ['8'], backendDOMNodeId: 14 },
  { nodeId: '8', parentId: '5', ignored: false, role: { value: 'InlineTextBox' }, name: { value: 'Hello' } },
  { nodeId: '6', parentId: '1', ignored: false, role: { value: 'textbox' }, name: { value: 'API key' }, value: { value: 'sk-live-123' }, backendDOMNodeId: 15 },
  { nodeId: '7', parentId: '1', ignored: true, role: { value: 'none' }, childIds: ['10'] },
  { nodeId: '10', parentId: '7', ignored: false, role: { value: 'checkbox' }, name: { value: 'Remember me' }, properties: [{ name: 'checked', value: { value: 'mixed' } }], backendDOMNodeId: 16 },
  { nodeId: '9', parentId: '1', ignored: false, role: { value: 'paragraph' }, childIds: [], backendDOMNodeId: 17 },
];

describe('axSnapshot (спека 5.1 browser_snapshot)', () => {
  it('строки с отступом по глубине; ссылки — у узлов DOM; generic и игнорируемые прозрачны; кусочки текста строк — нет', () => {
    const snapshot = axSnapshot(NODES, { interactiveOnly: false, limitBytes: 51_200 });
    expect(snapshot.text).toBe(
      [
        'document "Agent form"',
        '  [ref=e1] textbox "Name" value="old" (focused)',
        '  [ref=e2] button "Save"',
        '  text "Hello ```world"',
        '  [ref=e3] textbox "API key" value=<redacted>',
        '  [ref=e4] checkbox "Remember me" (checked: mixed)',
        '  [ref=e5] paragraph',
      ].join('\n'),
    );
    expect([...snapshot.refs]).toEqual([
      ['e1', 11],
      ['e2', 12],
      ['e3', 15],
      ['e4', 16],
      ['e5', 17],
    ]);
    expect(snapshot.truncated).toBe(false);
  });

  it('interactiveOnly — только элементы, с которыми агенту есть что делать, без отступа и без текста', () => {
    expect(axSnapshot(NODES, { interactiveOnly: true, limitBytes: 51_200 }).text).toBe(
      [
        '[ref=e1] textbox "Name" value="old" (focused)',
        '[ref=e2] button "Save"',
        '[ref=e3] textbox "API key" value=<redacted>',
        '[ref=e4] checkbox "Remember me" (checked: mixed)',
      ].join('\n'),
    );
  });

  it('предел байт — обход останавливается, truncated; ссылки — только у показанных строк', () => {
    const limit = Buffer.byteLength('document "Agent form"\n  [ref=e1] textbox "Name" value="old" (focused)\n');
    const snapshot = axSnapshot(NODES, { interactiveOnly: false, limitBytes: limit });
    expect(snapshot.text.split('\n')).toHaveLength(2);
    expect(snapshot.truncated).toBe(true);
    expect([...snapshot.refs.keys()]).toEqual(['e1']);
  });

  it('длинные имя и значение режутся с многоточием; кавычки экранируются; петля в дереве не зацикливает', () => {
    const long: AxNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['2', '1'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'link' }, name: { value: `say "hi" ${'x'.repeat(300)}` }, value: { value: 'v'.repeat(150) }, backendDOMNodeId: 5 },
    ];
    const line = axSnapshot(long, { interactiveOnly: false, limitBytes: 51_200 }).text.split('\n')[1] ?? '';
    expect(line.startsWith('  [ref=e1] link "say \\"hi\\" ')).toBe(true);
    expect(line).toContain('…"');
    expect(line).toContain(`value="${'v'.repeat(100)}…"`);
  });
});

describe('axSnapshot — расширения этапа D', () => {
  it('секрет в значении маскируется и без секретного имени; фрейм — строкой без содержимого (Фокус ревью 6)', () => {
    const nodes: AxNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'textbox' }, name: { value: 'Note' }, value: { value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' }, backendDOMNodeId: 5 },
      { nodeId: '3', parentId: '1', ignored: false, role: { value: 'Iframe' }, name: { value: 'Payment' }, childIds: ['4'], backendDOMNodeId: 6 },
      { nodeId: '4', parentId: '3', ignored: false, role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 7 },
    ];
    const text = axSnapshot(nodes, { interactiveOnly: false, limitBytes: 51_200 }).text;
    expect(text).not.toContain('eyJ');
    expect(text).toContain('[ref=e2] iframe "Payment"');
    expect(text).not.toContain('Pay"');
  });

  it('значение поля с секретным именем не утекает через дочерний текст; раздел с таким именем, но без значения, обходится (E2E 22b, Фокус ревью 6)', () => {
    const nodes: AxNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Settings' }, childIds: ['2', '5'] },
      { nodeId: '2', parentId: '1', ignored: false, role: { value: 'textbox' }, name: { value: 'API key' }, value: { value: 'SECRET8' }, childIds: ['3'], backendDOMNodeId: 5 },
      { nodeId: '3', parentId: '2', ignored: false, role: { value: 'generic' }, childIds: ['4'] },
      { nodeId: '4', parentId: '3', ignored: false, role: { value: 'StaticText' }, name: { value: 'SECRET8' } },
      { nodeId: '5', parentId: '1', ignored: false, role: { value: 'group' }, name: { value: 'API key settings' }, childIds: ['6'] },
      { nodeId: '6', parentId: '5', ignored: false, role: { value: 'button' }, name: { value: 'Rotate' }, backendDOMNodeId: 9 },
    ];
    const text = axSnapshot(nodes, { interactiveOnly: false, limitBytes: 51_200 }).text;
    expect(text).toContain('textbox "API key" value=<redacted>');
    expect(text).not.toContain('SECRET8');
    expect(text).toContain('button "Rotate"');
    // wait_for (axHasText) — то же правило: найти значение подбором нельзя (финальная рецензия m3); раздел обходится.
    expect(axHasText(nodes, 'SECRET')).toBe(false);
    expect(axHasText(nodes, 'Rotate')).toBe(true);
  });

  it('axHasText — видимый текст без учёта регистра и пробелов; игнорируемые узлы не считаются', () => {
    expect(axHasText(NODES, 'remember   ME')).toBe(true); // checkbox под игнорируемым узлом виден
    expect(axHasText(NODES, 'hello')).toBe(true);
    expect(axHasText(NODES, 'missing')).toBe(false);
    expect(axHasText([{ nodeId: '1', ignored: true, role: { value: 'StaticText' }, name: { value: 'Hidden' } }], 'hidden')).toBe(false);
  });

  it('axState: checked узла по backendNodeId; нет узла — null', () => {
    expect(axState(NODES, 16, 'checked')).toBe('mixed');
    expect(axState(NODES, 12, 'checked')).toBe(false);
    // CDP отдаёт tristate строкой: 'false' — не «отмечен» (рецензия m4).
    const tri = (value: unknown): AxNode[] => [{ nodeId: '1', ignored: false, role: { value: 'checkbox' }, properties: [{ name: 'checked', value: { value } }], backendDOMNodeId: 5 }];
    expect(axState(tri('false'), 5, 'checked')).toBe(false);
    expect(axState(tri('true'), 5, 'checked')).toBe(true);
    expect(axState(tri(true), 5, 'checked')).toBe(true);
    expect(axState(NODES, 999, 'checked')).toBeNull();
  });
});
