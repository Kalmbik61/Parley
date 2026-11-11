/**
 * Метка режима сессии в шапке чата (план T12a-indicator): `Code Mode`, `Classic · <короткая причина>` или `Mode unknown`.
 * Только показ записи запуска Parley (`sessions.codeMode`), не доказательство того, что исполняется; клика у неё нет, ни одно
 * решение её не читает. `Code Mode` — только когда хост ответил `code-mode`; нет ответа, ошибка, незнакомое слово или незнакомая
 * причина — `Mode unknown`, сырой текст не показывается никогда. Обновление: при монтировании и при `activity.changed` этой
 * сессии, не чаще раза в секунду; таймера опроса нет.
 */

import { useEffect, useRef, useState } from 'react';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useActivityStore } from '../store/activity.js';

const C = S.codeMode;

/** Не чаще одного чтения в секунду на метку. */
export const CODE_MODE_REFRESH_MS = 1_000;

type Mode = 'code-mode' | 'classic' | 'unknown';
export interface CodeModeView {
  mode: Mode;
  reason: string | null;
}
const UNKNOWN: CodeModeView = { mode: 'unknown', reason: null };

function knownReason(reason: string | null): keyof typeof C.reasons | null {
  return reason !== null && Object.hasOwn(C.reasons, reason) ? (reason as keyof typeof C.reasons) : null;
}

/** Ответ хоста приводится к виду, который метка вправе показать: чужая форма — `unknown`. */
export function readCodeMode(answer: unknown): CodeModeView {
  const { mode, reason } = (answer ?? {}) as { mode?: unknown; reason?: unknown };
  if (mode !== 'code-mode' && mode !== 'classic' && mode !== 'unknown') return UNKNOWN;
  if (reason !== null && typeof reason !== 'string') return UNKNOWN;
  // Classic без известной причины не называет себя Classic: причину знает только своя сборка.
  if (mode === 'classic' && knownReason(reason) === null) return UNKNOWN;
  return { mode, reason: mode === 'code-mode' ? null : reason };
}

export function CodeModeChip({ sessionRef, bridge }: { sessionRef: SessionRef; bridge?: ParleyBridge }): JSX.Element {
  const key = refKey(sessionRef);
  const source = bridge ?? (typeof window === 'undefined' ? undefined : window.parley);
  const activity = useActivityStore((state) => state.byRef[key]);
  const [view, setView] = useState<CodeModeView>(UNKNOWN);
  const mounted = useRef<{ source: unknown; key: string } | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turn = useRef(0);
  const read = useRef<() => void>(() => undefined);
  read.current = () => {
    last.current = Date.now();
    const mine = ++turn.current;
    if (source === undefined) return;
    source
      .call('sessions.codeMode', { ref: sessionRef })
      .then((answer) => { if (turn.current === mine) setView(readCodeMode(answer)); })
      .catch(() => { if (turn.current === mine) setView(UNKNOWN); });
  };

  // Монтирование или другая сессия: читаем сразу. Событие активности той же сессии: читаем, но не чаще раза в секунду.
  useEffect(() => {
    if (mounted.current === null || mounted.current.source !== source || mounted.current.key !== key) {
      mounted.current = { source, key };
      setView(UNKNOWN);
      read.current();
      return;
    }
    const wait = last.current + CODE_MODE_REFRESH_MS - Date.now();
    if (wait <= 0) read.current();
    else if (timer.current === null) timer.current = setTimeout(() => { timer.current = null; read.current(); }, wait);
  }, [source, key, activity]);

  useEffect(() => () => {
    turn.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    mounted.current = null;
  }, [source, key]);

  const reasonKey = knownReason(view.reason);
  // Причина без показа (`provider-unproven`) известна, но молчит: чип — просто `Classic`, в тултипе нет её предложения.
  const reason = reasonKey === null ? null : C.reasons[reasonKey];
  const text = view.mode === 'classic' && reason !== null ? `${C.mode.classic} · ${reason.short}` : C.mode[view.mode];
  const tooltip = [C.meaning[view.mode], ...(reason === null || view.mode === 'code-mode' ? [] : [reason.full]), C.limit].join('\n');
  return (
    <span
      role="group"
      data-testid="chat-code-mode"
      data-mode={view.mode}
      aria-label={`${C.name}: ${text}. ${tooltip.replace(/\n/g, ' ')}`}
      title={tooltip}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-foreground/6 px-2 py-0.5 text-xs font-medium${view.mode === 'unknown' ? ' text-muted-foreground' : ''}`}
    >
      {text}
    </span>
  );
}
