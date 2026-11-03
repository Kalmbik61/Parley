// React side of `resume.ts`: one controller per session screen, made in an effect (Fast Refresh and StrictMode dispose
// the old one for good) and fed with the screen's facts.
import { useEffect, useReducer, useRef, useState } from 'react';
import { sessionKey, type RemoteClient, type SessionRef } from '@parley/remote-client';
import { createResume, type AutoSend, type Resume, type ResumeFacts, type ResumeView } from './resume';

export interface ResumeHandle {
  view: ResumeView;
  /** The Resume / Retry button (`null`) or "Resume and send" (the message). `true` — the call took the text. */
  start(text: string | null): boolean;
  seed(view: ResumeView): void;
}

const EMPTY: ResumeView = { line: { kind: 'none' }, hidden: false, pending: null };

export function useResume(
  client: RemoteClient | null,
  ref: SessionRef | null,
  facts: ResumeFacts | null,
  io: { send(text: string): Promise<AutoSend>; textBack(text: string): void; notify(text: string): void },
): ResumeHandle {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const latest = useRef({ client, ref, io });
  latest.current = { client, ref, io };
  const [resume, setResume] = useState<Resume | null>(null);
  const key = ref === null ? '' : sessionKey(ref);
  useEffect(() => {
    const r = createResume({
      resume: async () => {
        const { client: c, ref: sref } = latest.current;
        if (c === null || sref === null) return { outcome: 'lost' };
        return c.resumeSession(sref);
      },
      send: (text) => latest.current.io.send(text),
      textBack: (text) => latest.current.io.textBack(text),
      notify: (text) => latest.current.io.notify(text),
      onChange: bump,
    });
    setResume(r);
    return () => r.dispose();
  }, [key]);
  useEffect(() => {
    if (resume !== null && facts !== null) resume.observe(facts);
  }, [resume, facts?.lifecycle, facts?.held, facts?.idle, facts?.lastEventAt]);
  return { view: resume?.view() ?? EMPTY, start: (text) => resume?.start(text) ?? false, seed: (view) => resume?.seed(view) };
}
