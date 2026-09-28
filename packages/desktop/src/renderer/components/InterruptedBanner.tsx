/**
 * Баннер упавших сессий (кусок 3.6 плана окна, спека 7.4): при монтировании и
 * каждом восстановлении связи с хостом спрашивает `sessions.interrupted`, и если список непуст — «Прерваны
 * посреди хода: S03, S05» с кнопкой «Поднять всех» (`sessions.resumeInterrupted`).
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
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { sessionTag } from '../lib/participant.js';
import { Button } from '../ui/button.js';

export interface InterruptedBannerProps {
  bridge: HarnasBridge;
}

export function InterruptedBanner({ bridge }: InterruptedBannerProps): JSX.Element | null {
  const [refs, setRefs] = useState<SessionRef[]>([]);

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

  if (refs.length === 0) return null;

  const resumeAll = (): void => {
    bridge
      .call('sessions.resumeInterrupted', { refs })
      .then(() => setRefs([]))
      .catch(() => {
        // Не удалось — баннер остаётся, попробовать можно ещё раз.
      });
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-2 text-sm text-foreground">
      <span>{S.banners.interrupted(refs.map((ref) => sessionTag(ref.sessionId)).join(', '))}</span>
      <Button type="button" size="sm" onClick={resumeAll} className="shrink-0">
        {S.banners.resumeAll}
      </Button>
    </div>
  );
}
