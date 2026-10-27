import { describe, expect, it } from 'vitest';
import { HOST_IDLE } from './store.js';
import { hotkeyLabel, miniLabel, statusLabel } from './labels.js';

describe('подписи помощника', () => {
  it('состояние хода → подпись', () => {
    expect(statusLabel({ ...HOST_IDLE, phase: 'thinking' }, 'idle')).toBe('Thinking…');
    expect(statusLabel({ ...HOST_IDLE, phase: 'tool', detail: { tool: 'overview', target: null } }, 'idle')).toBe('Checking rooms…');
    expect(statusLabel({ ...HOST_IDLE, phase: 'tool', detail: { tool: 'detail', target: 'Auth' } }, 'idle')).toBe('Reading Auth…');
    expect(statusLabel({ ...HOST_IDLE, phase: 'awaiting-confirm' }, 'idle')).toBe('Waiting for your confirmation');
    expect(statusLabel({ ...HOST_IDLE, phase: 'offline', error: 'Claude is not connected — open Settings' }, 'idle')).toBe('Claude is not connected — open Settings');
    expect(statusLabel(HOST_IDLE, 'listening')).toBe('Listening…');
    expect(statusLabel(HOST_IDLE, 'idle', true)).toBe('Sending…');
    expect(statusLabel(HOST_IDLE, 'listening', true)).toBe('Listening…');
  });
  it('мини-вид: подпись только пока занят', () => {
    expect(miniLabel({ ...HOST_IDLE, phase: 'thinking' }, 'idle')).toBe('Thinking·');
    expect(miniLabel({ ...HOST_IDLE, phase: 'answering' }, 'idle')).toBe('Working·');
    expect(miniLabel({ ...HOST_IDLE, phase: 'awaiting-confirm' }, 'idle')).toBe('Confirm send');
    expect(miniLabel(HOST_IDLE, 'idle')).toBeNull();
    expect(miniLabel(HOST_IDLE, 'idle', true)).toBe('Sending·');
  });
  it('мини-вид: карточка не-письма — «Card», письмо и карточка без action — «Confirm send»', () => {
    const base = { id: 'p1', target: 'Auth', where: 'Parley · Backend', text: 't' };
    const room = { ...base, action: 'room', title: 'Auth', members: ['S01 Ann'], lead: 'S01 Ann', task: null } as const;
    const message = { ...base, action: 'message', kind: null, wake: false } as const;
    const legacy = { ...base, kind: null, wake: false } as const;
    expect(miniLabel({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: room }, 'idle')).toBe('Card');
    expect(miniLabel({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: message }, 'idle')).toBe('Confirm send');
    expect(miniLabel({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: legacy }, 'idle')).toBe('Confirm send');
  });
  it('речь: Speaking, после неё Done — и в мини-виде (таблицы LABEL и MINI макета)', () => {
    expect(statusLabel({ ...HOST_IDLE, phase: 'idle' }, 'speaking')).toBe('Speaking');
    expect(statusLabel({ ...HOST_IDLE, phase: 'idle' }, 'settling')).toBe('Done');
    expect(miniLabel(HOST_IDLE, 'speaking')).toBe('Speaking·');
    expect(miniLabel(HOST_IDLE, 'settling')).toBe('Done·');
    expect(miniLabel(HOST_IDLE, 'listening')).toBe('Listening·');
    expect(miniLabel(HOST_IDLE, 'transcribing')).toBe('Listening·');
  });
  it('сочетание — значками macOS', () => {
    expect(hotkeyLabel('Alt+Space')).toBe('⌥Space');
    expect(hotkeyLabel('CmdOrCtrl+Shift+J')).toBe('⌘⇧J');
    expect(hotkeyLabel('Control+Alt+K')).toBe('⌃⌥K');
  });
});
