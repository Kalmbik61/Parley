/**
 * Кнопка микрофона (спека 3.2): одна для всех целей. Голос не настроен — тусклая, клик открывает Settings → Voice
 * (это делает `toggle` store). Запись своей цели — красная точка, полоска громкости и таймер; распознавание —
 * спиннер, и недоступны все кнопки окна (одна очередь). `mousedown` гасится: фокус и каретка остаются в поле.
 */
import { Loader2, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';
import { useDictationStore } from './dictation-store.js';
import { levelWidth } from './level.js';

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export interface MicButtonProps {
  targetId: string;
  /** `sm` — в тулбаре вкладки (высота 24). */
  size?: 'default' | 'sm';
}

export function MicButton({ targetId, size = 'default' }: MicButtonProps): JSX.Element {
  const configured = useUiStore((state) => state.ui.voice.enabled && state.ui.voice.model !== null);
  const phase = useDictationStore((state) => state.phase);
  const own = useDictationStore((state) => state.targetId === targetId);
  const level = useDictationStore((state) => (state.targetId === targetId ? state.level : 0));
  const startedAt = useDictationStore((state) => (state.targetId === targetId ? state.startedAt : null));
  const elapsed = useElapsed(phase === 'recording' && own ? startedAt : null);

  const state = !configured
    ? 'setup'
    : phase === 'recording' && own
      ? 'recording'
      : phase === 'transcribing' && own
        ? 'transcribing'
        : 'ready';
  const title =
    state === 'setup'
      ? S.voice.setUp
      : state === 'recording'
        ? S.voice.stop
        : state === 'transcribing'
          ? S.voice.transcribing
          : S.voice.dictate;

  return (
    <span data-testid="mic" data-target={targetId} data-state={state} className="inline-flex shrink-0 items-center gap-1.5">
      {state === 'recording' ? (
        <>
          <span aria-hidden="true" className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-destructive transition-[width]" style={{ width: `${Math.round(levelWidth(level) * 100)}%` }} />
          </span>
          <span data-testid="mic-elapsed" className="text-xs tabular-nums text-muted-foreground">
            {formatElapsed(elapsed)}
          </span>
        </>
      ) : null}
      {state === 'transcribing' ? <span className="text-xs text-muted-foreground">{S.voice.transcribing}</span> : null}
      <Button
        type="button"
        variant="outline"
        title={title}
        aria-label={title}
        disabled={phase === 'transcribing'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void useDictationStore.getState().toggle(targetId)}
        className={cn(size === 'sm' ? 'size-6 px-0' : 'size-[38px] rounded-full px-0', state === 'setup' && 'opacity-50')}
      >
        {state === 'recording' ? (
          <span aria-hidden="true" className="size-2.5 rounded-full bg-destructive" />
        ) : state === 'transcribing' ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Mic aria-hidden="true" className="size-4" />
        )}
      </Button>
    </span>
  );
}
