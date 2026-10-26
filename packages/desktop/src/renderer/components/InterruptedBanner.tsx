/**
 * Баннер упавших сессий (кусок 3.6 плана окна, спека 7.4): при монтировании и
 * каждом восстановлении связи с хостом спрашивает `sessions.interrupted`, и если список непуст — «Interrupted
 * mid-turn:» и ряд чипов, по одному на сессию, с кнопками «Resume all» (`sessions.resumeInterrupted`) и «×».
 * Чип — `S03 бэкенд · Название работы` из снимка работ (одинаковые номера в разных работах различимы);
 * сессии или работы нет в снимке — просто `S03`. Клик по чипу открывает сессию (`onOpenSession`). «×» прячет
 * показанные сейчас сессии до конца жизни окна (набор `refKey` в состоянии): пришедшие позже,
 * после переподключения, и не скрытые — показываются снова. «Resume all» поднимает только видимые.
 * Сам себя прячет, когда список пуст — рендерится безусловно сразу после
 * заголовка в `shell/AppShell.tsx` (кусок 2.3), перед `Landing`/центром с
 * работами, а не по внешнему условию. С куска 1.3 плана окна — кнопка на
 * общем `ui/button`, а не голый `<button>`; фон и текст — токены (`--card`,
 * как у строки статуса) вместо прежней палитры темы окна: она больше не
 * привязана к системной теме окна (спека 4.9), полосу вразнобой с новым
 * сайдбаром/статус-баром было бы видно в любой смене темы, а не только в
 * редком сочетании настроек.
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { sessionRowLabel, sessionTag, workTitleText } from '../lib/participant.js';
import { useWorksStore } from '../store/works.js';
import { Button } from '../ui/button.js';

export interface InterruptedBannerProps {
  bridge: ParleyBridge;
  /** Клик по чипу сессии: тот же переход, что у «Open» тоста отправки. */
  onOpenSession: (ref: SessionRef) => void;
}

export function InterruptedBanner({ bridge, onOpenSession }: InterruptedBannerProps): JSX.Element | null {
  const [refs, setRefs] = useState<SessionRef[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const entries = useWorksStore((state) => state.entries);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      bridge
        .call('sessions.interrupted', {})
        .then((result) => {
          if (alive) setRefs(result.refs);
        })
        .catch(() => {
          // Нет ответа — баннера просто не будет, не повод падать.
        });
    };
    load();
    // Каждое восстановление связи (раунд main-r2, п. 2): «Restart host» и падение хоста окно не
    // перемонтируют, а прерванные сессии появляются именно тогда. Первое «connected» после
    // монтирования тоже перезапрашивает: запрос при монтировании мог уйти до связи.
    let connected = false;
    const unsubscribe = bridge.onStatus((status) => {
      const now = status.state === 'connected';
      if (now && !connected) load();
      connected = now;
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  // Хост дублей слать не должен, но ключ React и «Resume all» от них страхуем.
  const seen = new Set<string>();
  const visible = refs.filter((ref) => {
    const key = refKey(ref);
    if (dismissed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (visible.length === 0) return null;

  const resumeAll = (): void => {
    bridge
      .call('sessions.resumeInterrupted', { refs: visible })
      .then(() => setRefs([]))
      .catch(() => {
        // Не удалось — баннер остаётся, попробовать можно ещё раз.
      });
  };

  const dismiss = (): void => setDismissed((prev) => new Set([...prev, ...visible.map(refKey)]));

  const chipText = (ref: SessionRef): string => {
    const entry = entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
    const session = entry?.map.sessions.find((item) => item.id === ref.sessionId);
    if (entry === undefined || session === undefined) return sessionTag(ref.sessionId);
    return `${sessionRowLabel(ref.sessionId, session.label)} · ${workTitleText(entry.map.work.title)}`;
  };

  return (
    <div className="flex items-start justify-between gap-3 border-b border-border bg-card px-3 py-2 text-sm text-foreground">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <span title={S.banners.interruptedHint}>{S.banners.interrupted}</span>
        {visible.map((ref) => {
          const text = chipText(ref);
          return (
            <Button
              key={refKey(ref)}
              type="button"
              size="xs"
              variant="outline"
              title={text}
              onClick={() => onOpenSession(ref)}
              className="max-w-[16rem] min-w-0"
            >
              <span className="truncate">{text}</span>
            </Button>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" onClick={resumeAll}>
          {S.banners.resumeAll}
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={S.banners.dismiss} title={S.banners.dismiss} onClick={dismiss}>
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
