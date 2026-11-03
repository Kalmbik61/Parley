/** Тело вкладки «Board»: одна доска на всю работу, подписками на бэклоги занят `BoardSync`. */
import type { ParleyBridge } from '../../../shared/bridge.js';
import { BoardView } from '../../board/BoardView.js';

export interface BoardBodyProps {
  bridge: ParleyBridge;
  /** Работа активна — `LayoutBodyContext.active` из `GroupView`; доске пока не нужен. */
  active: boolean;
}

export function BoardBody({ bridge }: BoardBodyProps): JSX.Element {
  return <BoardView bridge={bridge} />;
}
