// packages/desktop/src/renderer/browser/use-viewport.ts
/**
 * Эмуляция размера вкладки в окне (спека 2026-10-07-browser-devtools-agent-design.md, 4.2).
 * - Размер из раскладки уходит в main (`setViewport`) вместе с местом под страницу; ответ `scale` ставит `<webview>`.
 * - Повтор — на смену размера, поля и гостя и после возврата захвата: отцепившийся отладчик эмуляцию теряет.
 * - Fit без прежней эмуляции main не трогает. Отказ — тост, страница во всё поле.
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

export function useViewport(input: {
  bridge: ParleyBridge;
  webContentsId: number | null;
  viewport: ViewportSpec | null;
  field: FieldSize | null;
  /** Захват недоступен: команды CDP откажут — ждём его возврата. */
  captureLost: boolean;
}): AppliedViewport | null {
  const { bridge, webContentsId, viewport, field, captureLost } = input;
  const [applied, setApplied] = useState<AppliedViewport | null>(null);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const width = field?.width ?? null;
  const height = field?.height ?? null;

  useEffect(() => {
    if (webContentsId === null || captureLost || width === null || height === null) return undefined;
    if (viewport === null && appliedRef.current === null) return undefined;
    let current = true;
    bridge.browser.setViewport(webContentsId, viewport, fitArea({ width, height })).then(
      ({ scale }) => {
        if (current) setApplied(viewport === null ? null : { spec: viewport, scale });
      },
      (error: unknown) => {
        if (!current) return;
        console.error('[parley] setViewport failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.setViewport));
        setApplied(null);
      },
    );
    return () => {
      current = false;
    };
  }, [bridge, webContentsId, viewport, width, height, captureLost]);

  return applied;
}
