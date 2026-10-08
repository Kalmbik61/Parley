// packages/desktop/src/renderer/browser/use-viewport.ts
/**
 * Эмуляция размера вкладки в окне (спека 2026-10-07-browser-devtools-agent-design.md, 4.2).
 * - Размер из раскладки уходит в main (`setViewport`) вместе с местом под страницу; ответ `scale` ставит `<webview>`.
 * - Повтор — на смену размера, поля и гостя и после возврата захвата: отцепившийся отладчик эмуляцию теряет. Пока
 *   захвата нет, сцена показывает страницу во всё поле (`applied` сброшен), а не ужатую коробку без эмуляции внутри.
 * - Fit без прежней эмуляции main не трогает. Отказ — тост, страница во всё поле, но сброс по Fit всё равно уходит:
 *   часть команд могла сработать (`touched`). `failed` и `retry` — повторить тот же размер из меню после отказа.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { fitArea, type FieldSize } from './stage.js';

export interface AppliedViewport {
  spec: ViewportSpec;
  scale: number;
}

export interface ViewportState {
  applied: AppliedViewport | null;
  /** Последняя попытка отказала: тот же размер из меню надо слать заново (`retry`), а не пропускать. */
  failed: boolean;
  retry(): void;
}

export function useViewport(input: {
  bridge: ParleyBridge;
  webContentsId: number | null;
  viewport: ViewportSpec | null;
  field: FieldSize | null;
  /** Захват недоступен: команды CDP откажут — ждём его возврата. */
  captureLost: boolean;
}): ViewportState {
  const { bridge, webContentsId, viewport, field, captureLost } = input;
  const [applied, setApplied] = useState<AppliedViewport | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** В main могла остаться эмуляция, о которой окно не знает (отказ посреди команд): Fit должен её снять. */
  const touchedRef = useRef(false);
  const width = field?.width ?? null;
  const height = field?.height ?? null;

  useEffect(() => {
    if (captureLost) {
      // Отладчик отцепился — Chromium снял эмуляцию: сцена показывает страницу как есть, пока захват не вернётся.
      touchedRef.current = false;
      setApplied(null);
      setFailed(false);
      return undefined;
    }
    if (webContentsId === null || width === null || height === null) return undefined;
    if (viewport === null && !touchedRef.current) return undefined;
    let current = true;
    touchedRef.current = true;
    bridge.browser.setViewport(webContentsId, viewport, fitArea({ width, height })).then(
      ({ scale }) => {
        if (!current) return;
        if (viewport === null) touchedRef.current = false;
        setApplied(viewport === null ? null : { spec: viewport, scale });
        setFailed(false);
      },
      (error: unknown) => {
        if (!current) return;
        console.error('[parley] setViewport failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.setViewport));
        setApplied(null);
        setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [bridge, webContentsId, viewport, width, height, captureLost, attempt]);

  return { applied, failed, retry: () => setAttempt((count) => count + 1) };
}
