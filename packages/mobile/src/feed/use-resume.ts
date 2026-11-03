// React side of `resume.ts`: one controller per session screen, fed with the screen's facts.
import { useEffect, useReducer, useRef } from 'react';
import { sessionKey, type RemoteClient, type SessionRef } from '@parley/remote-client';
import { createResume, type Resume, type ResumeFacts, type ResumeView } from './resume';

export interface ResumeHandle {
  view: ResumeView;
  /** The Resume / Retry button (`null`) or "Resume and send" (the message). */
  start(text: string | null): void;
  seed(view: ResumeView): void;
}

export function useResume(client: RemoteClient | null, ref: SessionRef | null, facts: ResumeFacts | null, io: { send(text: string): void; textBack(text: string): void }): ResumeHandle {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const latest = useRef({ client, ref, io });
  latest.current = { client, ref, io };
  const holder = useRef<{ key: string; resume: Resume } | null>(null);
  const key = ref === null ? '' : sessionKey(ref);
  if (holder.current === null || holder.current.key !== key) {
    holder.current = {
      key,
      resume: createResume({
        resume: async () => {
          const { client: c, ref: r } = latest.current;
          if (c === null || r === null) return { outcome: 'lost' };
          return c.resumeSession(r);
        },
        send: (text) => latest.current.io.send(text),
        textBack: (text) => latest.current.io.textBack(text),
        onChange: bump,
      }),
    };
  }
  const resume = holder.current.resume;
  useEffect(() => () => resume.dispose(), [resume]);
  useEffect(() => {
    if (facts !== null) resume.observe(facts);
  }, [resume, facts?.lifecycle, facts?.held, facts?.idle, facts?.lastEventAt]);
  return { view: resume.view(), start: resume.start, seed: resume.seed };
}
