import { describe, expect, it } from 'vitest';
import { againMessage, copyText, messageActions } from './message-actions';

const ids = (kind: 'agent' | 'prompt', over: { hasPtySend?: boolean; closed?: boolean } = {}): string[] => messageActions({ kind, hasPtySend: true, closed: false, ...over }).map((a) => a.id);

describe('messageActions', () => {
  it('an agent reply: Copy, Reply, Select Text — never Send again', () => {
    expect(ids('agent')).toEqual(['copy', 'reply', 'select']);
  });
  it('an own prompt: Copy, Reply, Send again, Select Text', () => {
    expect(ids('prompt')).toEqual(['copy', 'reply', 'again', 'select']);
    expect(messageActions({ kind: 'prompt', hasPtySend: true, closed: false }).map((a) => a.title)).toEqual(['Copy', 'Reply', 'Send again', 'Select Text']);
  });
  it('no pty.send in the hello (the switch is off): no Send again', () => {
    expect(ids('prompt', { hasPtySend: false })).toEqual(['copy', 'reply', 'select']);
  });
  it('a closed session: no Send again', () => {
    expect(ids('prompt', { closed: true })).toEqual(['copy', 'reply', 'select']);
  });
});

describe('copyText', () => {
  it('a reply is copied as its Markdown source, a prompt is trimmed', () => {
    expect(copyText('agent', '## Title\n\n- a\n')).toBe('## Title\n\n- a\n');
    expect(copyText('prompt', '  run the linter\n')).toBe('run the linter');
  });
});

describe('againMessage', () => {
  it('the same text, a new clientMsgId every time', () => {
    const a = againMessage('run the linter', 1_000);
    const b = againMessage('run the linter', 1_000);
    expect(a.text).toBe('run the linter');
    expect(b.text).toBe(a.text);
    expect(b.clientMsgId).not.toBe(a.clientMsgId);
  });
});
