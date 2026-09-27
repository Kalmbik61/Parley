/**
 * Тело вкладки терминала (кусок 2.4): пока прямая обёртка над `TerminalPanel`
 * этапа 1 — сам терминал рисуется прямо в теле группы. В 2.5 подключение к
 * хосту и xterm переезжают в отдельный слой поверхностей (спека 5.5), а тело
 * остаётся только якорем позиционирования; до тех пор группа, потерявшая
 * фокус или видимость, просто размонтирует эту вкладку целиком — терминал
 * переподключается заново тем же путём, что и раньше (`use-terminal.ts`,
 * снимок хоста возвращает экран).
 */

import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { TerminalPanel } from '../../components/terminal/TerminalPanel.js';

export interface TerminalBodyProps {
  bridge: HarnasBridge;
  sessionRef: SessionRef;
  fontFamily: string;
  fontSize: number;
}

export function TerminalBody({ bridge, sessionRef, fontFamily, fontSize }: TerminalBodyProps): JSX.Element {
  return <TerminalPanel bridge={bridge} sessionRef={sessionRef} fontFamily={fontFamily} fontSize={fontSize} />;
}
