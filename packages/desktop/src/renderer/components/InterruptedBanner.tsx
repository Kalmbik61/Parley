/**
 * Баннер упавших сессий (кусок 3.6 плана окна, спека 7.4): при подключении
 * спрашивает `sessions.interrupted`, и если список непуст — «Прерваны
 * посреди хода: S03, S05» с кнопкой «Поднять всех» (`sessions.resumeInterrupted`).
 * Сам себя прячет, когда список пуст — рендерится безусловно под `Workspace`
 * в `App.tsx`, как и остальные подключённые к бриджу диалоги (`SettingsDialog`
 * и т. п.), а не по внешнему условию. С куска 1.3 плана окна — кнопка на
 * общем `ui/button`, а не голый `<button>`; фон и текст — токены (`--card`,
 * как у строки статуса) вместо прежней палитры темы окна: она больше не
 * привязана к системной теме окна (спека 4.9), полосу вразнобой с новым
 * сайдбаром/статус-баром было бы видно в любой смене темы, а не только в
 * редком сочетании настроек.
 */

import { useEffect, useState } from 'react';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { sessionTag } from '../lib/participant.js';
import { Button } from '../ui/button.js';

export interface InterruptedBannerProps {
  bridge: HarnasBridge;
}

export function InterruptedBanner({ bridge }: InterruptedBannerProps): JSX.Element | null {
  const [refs, setRefs] = useState<SessionRef[]>([]);

  useEffect(() => {
    bridge
      .call('sessions.interrupted', {})
      .then((result) => setRefs(result.refs))
      .catch(() => {
        // Нет ответа — баннера просто не будет, не повод падать.
      });
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
      <span>Прерваны посреди хода: {refs.map((ref) => sessionTag(ref.sessionId)).join(', ')}</span>
      <Button type="button" size="sm" onClick={resumeAll} className="shrink-0">
        Поднять всех
      </Button>
    </div>
  );
}
