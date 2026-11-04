/** A dictation that outlives its field lands at the end of that field's draft (spec 3.3). Pure: the stores are injected. */
import { joinTranscript } from './insert';

export interface DraftStore {
  get(key: string): string;
  set(key: string, text: string): void;
}

export function appendToDraft(
  stores: { session: DraftStore; room: DraftStore },
  target: { kind: 'session' | 'room'; key: string },
  text: string,
): void {
  const store = stores[target.kind];
  const before = store.get(target.key);
  store.set(target.key, before + joinTranscript(before, text));
}
