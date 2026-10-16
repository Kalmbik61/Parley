/**
 * Сегмент Diagnostics правой группы строки статуса (спека диагностики хоста 2026-10-16, A1, A8): иконка и подпись
 * (на узком окне — только иконка), поповер над строкой с двумя кнопками. «Save diagnostics» собирает архив сразу,
 * «Record 20-second profile» — после записи профиля хоста; пока идёт сборка, обе кнопки заблокированы, а в самом
 * сегменте виден обратный отсчёт или «Saving…». Хост без `host.diagnostics` профиль писать не умеет: кнопка
 * заблокирована, подсказка зовёт перезапустить хост; архив из файлов и `ps` собирается и так.
 */

import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { getHostClient } from '../host-client.js';
import { useHostSupports } from '../lib/capabilities.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { PROFILE_SECONDS, runSaveDiagnostics } from './diagnostics-flow.js';
import { SEGMENT_BUTTON } from './segment.js';

type Phase = 'idle' | 'saving' | 'profiling';

/** Кнопка действия поповера: на заливке карточки, недоступная — приглушена. */
const ACTION_BUTTON = 'rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/8 disabled:opacity-50 disabled:hover:bg-transparent';

export function DiagnosticsSegment(): JSX.Element {
  const supported = useHostSupports('host.diagnostics');
  const [phase, setPhase] = useState<Phase>('idle');
  const [left, setLeft] = useState(PROFILE_SECONDS);

  // Отсчёт идёт, пока профиль пишется; таймер снимается и по окончании записи, и при размонтировании сегмента.
  useEffect(() => {
    if (phase !== 'profiling') return;
    const timer = setInterval(() => setLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const run = (profile: boolean): void => {
    if (phase !== 'idle') return;
    setLeft(PROFILE_SECONDS);
    setPhase(profile ? 'profiling' : 'saving');
    void runSaveDiagnostics(getHostClient(), { profile }).finally(() => setPhase('idle'));
  };

  // Запись кончилась, а main ещё собирает архив: «Profiling 0 s…» не показываем.
  const label =
    phase === 'idle' ? S.diagnostics.segment :
    phase === 'profiling' && left > 0 ? S.diagnostics.profiling(left) :
    S.diagnostics.saving;
  const busy = phase !== 'idle';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-diagnostics-segment title={label} aria-label={label} aria-busy={busy}
          className={`${SEGMENT_BUTTON} flex items-center gap-[7px]`}>
          <Activity aria-hidden size={14} />
          <span className="hidden min-[960px]:inline">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={S.diagnostics.segment} side="top" align="end" className="flex w-[min(320px,calc(100vw-24px))] flex-col gap-1 p-2">
        <button type="button" disabled={busy} onClick={() => run(false)} className={ACTION_BUTTON}>
          {S.diagnostics.save}
        </button>
        <button type="button" disabled={busy || !supported} onClick={() => run(true)} className={ACTION_BUTTON}>
          {S.diagnostics.profile}
        </button>
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-neutral-700">{S.diagnostics.hint}</p>
        {supported ? null : <p className="px-2.5 pb-1 text-[11px] leading-snug text-accent-700">{S.diagnostics.hostOutdated}</p>}
      </PopoverContent>
    </Popover>
  );
}
