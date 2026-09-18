/**
 * Проба версии `claude` при старте харнесса (разговор агентов, 4.4, решение
 * D19).
 *
 * Флаг канала старая сборка не принимает: запуск падал бы с «unknown option»,
 * а причина была бы видна только в панели гостя. Поэтому версия спрашивается
 * один раз, и ниже минимума push выключается сам, сказав об этом строкой
 * статуса.
 */

import { CHANNEL_MIN_VERSION, probeChannelSupport } from '@harnas/core';
import { useEffect, useRef, useState } from 'react';
import type { StatusEventInit } from './use-status.js';

export function useChannelProbe(
  enabled: boolean,
  push: (events: readonly StatusEventInit[]) => void,
): boolean {
  // Пока проба не вернулась, ведём себя как сегодня: push включён. Иначе
  // первая же сессия ушла бы без флага из-за нашей собственной осторожности.
  const [supported, setSupported] = useState(true);
  // Колбэк через ссылку: его новый экземпляр не должен запускать пробу заново.
  const notify = useRef(push);
  notify.current = push;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void probeChannelSupport()
      .then((probe) => {
        if (cancelled || probe.supported) return;
        setSupported(false);
        notify.current([
          { text: `push выключен: claude ${probe.version} младше ${CHANNEL_MIN_VERSION}` },
        ]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return supported;
}
