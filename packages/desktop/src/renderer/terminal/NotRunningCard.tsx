/**
 * Карточка неживой сессии над терминалом (спека окна 2026-09-29, 1.8; правки ревью куска 2, находка 2): до
 * 520px, padding 24, gap 12 — кикер (`not started` accent-700, `asleep` и `closed` neutral-700), название
 * Caprasimo 20px `S04 тесты · Платежи`, текст 14px, мета и главная кнопка.
 *
 * Состав по состоянию:
 *  — не запущена (`pending`): текст — задача, мета — провайдер и путь брифа моноширинным
 *    (`Claude Code · .parley/works/w-01/briefs/s-04.md`); кнопки нет — метода запуска ожидающей сессии в
 *    протоколе нет, такие сессии поднимает `autoLaunch` хоста;
 *  — спит и закрыта: текст — резюме агента (`summary`, последняя реплика), а если его нет — задача; мета —
 *    `Claude Code · last event 3h ago` по последнему событию сессии. Resume — только там, где хост его
 *    принимает (`canResume`: у закрытой `sessions.resume` падает).
 *
 * Всё — из снимка работ: название работы, задача, резюме, метки времени; имя провайдера — `providerName` по
 * метке из `providers.list` (нет списка — по id). Длинные значения (название работы 120 знаков, метка 40,
 * задача тысячи знаков) не вытесняют кнопку и не растягивают карточку: название переносится по словам и
 * обрезается тремя строками, текст — четырьмя (полный — в `title`).
 *
 * Терминал под карточкой прежний: xterm держит последний вывод, и «Restart host» показывает его над картой.
 */

// Подпуть `names`, а не корень core: рендерер тянет из core только чистые имена без кода Node.
import { STATE_DIR } from '@parley/core/names';
import { refKey, type SessionRef } from '@parley/protocol';
import { S, providerName } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useNow } from '../lib/use-now.js';
import { sessionRowLabel, workTitleText } from '../lib/participant.js';
import { relativeTimeAgo } from '../lib/relative-time.js';
import { useActivityStore } from '../store/activity.js';
import { useProvidersStore } from '../store/providers.js';
import { useWorksStore } from '../store/works.js';
import { Button } from '../ui/button.js';
import { Card, CardKicker, CardTitle } from '../ui/card.js';
import { canResume } from './send.js';

/** «last event 3h ago» устаревает по часам, а не по секундам: раз в полминуты, как метки сайдбара. */
const NOW_PERIOD_MS = 30_000;

export interface NotRunningCardProps {
  sessionRef: SessionRef;
  /** «Resume»: отказ хоста — тостом, а не молча (`resumeSession` в `TerminalSurface.tsx`). */
  onResume(): void;
}

export function NotRunningCard({ sessionRef, onResume }: NotRunningCardProps): JSX.Element | null {
  const entry = useWorksStore((state) =>
    state.entries.find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId),
  );
  const session = entry?.map.sessions.find((item) => item.id === sessionRef.sessionId);
  const live = useActivityStore((state) => state.byRef[refKey(sessionRef)]);
  const providerLabel = useProvidersStore((state) => state.providers.find((item) => item.id === session?.provider)?.label ?? '');
  const now = useNow(NOW_PERIOD_MS);
  if (entry === undefined || session === undefined) return null;

  const pending = session.lifecycle === 'pending';
  const kicker = pending ? S.states.pending : session.lifecycle === 'closed' ? S.states.closed : S.states.asleep;
  const title = `${sessionRowLabel(session.id, session.label)} · ${workTitleText(entry.map.work.title)}`;
  // Последняя реплика агента — его резюме; нет резюме (сессия не отчиталась) — то, что ей поручили.
  const body = pending || session.summary === null || session.summary === '' ? session.task : session.summary;
  const provider = providerName(session.provider, providerLabel);
  const lastEventAt = live?.activity.lastEventAt ?? session.resultAt ?? session.startedAt;
  const lastEvent = lastEventAt === null ? '' : relativeTimeAgo(lastEventAt, now);
  const detail = pending
    ? `${STATE_DIR}/works/${sessionRef.workId}/briefs/${sessionRef.sessionId}.md`
    : lastEvent === ''
      ? ''
      : S.terminal.lastEvent(lastEvent);
  const meta = detail === '' ? provider : `${provider} · ${detail}`;

  return (
    <Card data-testid="terminal-not-running" className="mx-6 mt-6 max-w-[520px] shrink-0 gap-3 p-6 text-foreground">
      <CardKicker data-kicker className={pending ? undefined : 'text-neutral-700'}>
        {kicker}
      </CardKicker>
      <CardTitle className="line-clamp-3 break-words text-xl">{title}</CardTitle>
      {body === '' ? null : (
        <p title={body} className="m-0 line-clamp-4 whitespace-pre-line break-words text-sm">
          {body}
        </p>
      )}
      <div className={cn('break-words text-[11px] leading-4 text-neutral-700', pending && 'font-mono')}>{meta}</div>
      {canResume(session) ? (
        <div className="mt-1.5 flex gap-2">
          <Button type="button" className="shrink-0" onClick={onResume}>
            {S.sidebar.sessionMenu.resume}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
