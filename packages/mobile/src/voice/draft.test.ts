import { beforeEach, describe, expect, it } from 'vitest';
import { clearOutbox, draftOf, setDraft } from '../feed/outbox';
import { roomDraftOf, setRoomDraft } from '../room/room-drafts';
import { appendToDraft } from './draft';

const stores = { session: { get: draftOf, set: setDraft }, room: { get: roomDraftOf, set: setRoomDraft } };

describe('appendToDraft with the real draft stores', () => {
  beforeEach(() => {
    clearOutbox();
    setRoomDraft('room-key', '');
  });
  it('session: appended to the end with a joining space', () => {
    setDraft('s1', 'fix the');
    appendToDraft(stores, { kind: 'session', key: 's1' }, 'login bug');
    expect(draftOf('s1')).toBe('fix the login bug');
  });
  it('session: an empty draft gets the text as it is', () => {
    appendToDraft(stores, { kind: 'session', key: 's2' }, 'hello');
    expect(draftOf('s2')).toBe('hello');
  });
  it('room: lands under its key, and only there', () => {
    setRoomDraft('room-key', 'ok ');
    appendToDraft(stores, { kind: 'room', key: 'room-key' }, 'go');
    expect(roomDraftOf('room-key')).toBe('ok go');
    expect(draftOf('room-key')).toBe('');
  });
});
