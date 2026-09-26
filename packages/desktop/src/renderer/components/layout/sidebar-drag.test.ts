import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@harnas/protocol';
import type { PanelSpec } from '../../lib/panel-id.js';
import { DRAG_MIME, dragPayload, readDragPayload } from './sidebar-drag.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };
const spec: PanelSpec = { kind: 'terminal', ref, workKey: '/tmp/proj w-01' };

/** Минимальный `DataTransfer` — jsdom его не умеет, а нам нужна только `getData`. */
function fakeDataTransfer(data: Record<string, string>): Pick<DragEvent, 'dataTransfer'> {
  return {
    dataTransfer: {
      getData: (type: string) => data[type] ?? '',
    } as DataTransfer,
  };
}

describe('dragPayload / readDragPayload', () => {
  it('туда-обратно возвращает тот же спек', () => {
    const event = fakeDataTransfer({ [DRAG_MIME]: dragPayload(spec) });
    expect(readDragPayload(event)).toEqual(spec);
  });

  it('отвергает чужой MIME', () => {
    const event = fakeDataTransfer({ 'text/plain': 'hello' });
    expect(readDragPayload(event)).toBeNull();
  });

  it('отвергает битый JSON', () => {
    const event = fakeDataTransfer({ [DRAG_MIME]: '{не json' });
    expect(readDragPayload(event)).toBeNull();
  });

  it('отвергает валидный JSON не той формы', () => {
    const event = fakeDataTransfer({ [DRAG_MIME]: JSON.stringify({ kind: 'terminal' }) });
    expect(readDragPayload(event)).toBeNull();

    const badKind = fakeDataTransfer({ [DRAG_MIME]: JSON.stringify({ kind: 'файл', workKey: 'x' }) });
    expect(readDragPayload(badKind)).toBeNull();
  });

  it('без dataTransfer — null', () => {
    expect(readDragPayload({ dataTransfer: null })).toBeNull();
  });
});
