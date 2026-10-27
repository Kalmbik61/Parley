import type { ProgressState } from './progress.js';
import { S } from '../../shared/strings.js';

export function ProgressView({ state, onOpen, onClose }: { state: ProgressState; onOpen(): void; onClose(): void }): JSX.Element {
  const text = S.island.progress;
  return (
    <section aria-label={text.title} data-testid="island-progress" className="my-2 rounded-lg border border-white/15 p-2 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{text.title}</h3>
        <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={onClose}>{text.close}</button>
      </div>
      {state.kind === 'loading' ? <p role="status" className="py-2 text-muted-foreground">{text.loading}</p>
        : state.kind === 'unavailable' ? <p role="status" className="py-2 text-muted-foreground">{text.unavailable}</p>
          : <>
              {state.delayed ? <p role="status" className="py-1 text-muted-foreground">{text.delayed}</p> : null}
              {state.result.recent.length === 0 ? <p className="py-2 text-muted-foreground">{text.empty}</p> : (
                <ol className="my-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
                  {state.result.recent.slice(-20).map((line) => (
                    <li key={line.id} aria-current={state.result.current?.id === line.id ? 'step' : undefined} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">{text.category[line.category]}</span>
                      {state.result.current?.id === line.id ? <span>{text.current}</span> : null}
                      <span className="text-muted-foreground">{text.status[line.status]}</span>
                      <time className="text-muted-foreground" dateTime={line.at}>{new Date(line.endedAt ?? line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    </li>
                  ))}
                </ol>
              )}
              {state.result.truncated ? <p className="mb-2 text-muted-foreground">{text.truncated}</p> : null}
            </>}
      <button type="button" className="cursor-pointer hover:underline" onClick={onOpen}>{S.island.openInParley}</button>
    </section>
  );
}
