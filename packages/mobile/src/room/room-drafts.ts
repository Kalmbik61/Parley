// The room drafts by key: the text of a room's field outlives its screen. No React, so code outside the screen (A47: a dictation
// that outlives its field lands here) and its tests can use it.
const drafts = new Map<string, string>();

export const roomDraftOf = (key: string): string => drafts.get(key) ?? '';
export const setRoomDraft = (key: string, text: string): void => void (text === '' ? drafts.delete(key) : drafts.set(key, text));
