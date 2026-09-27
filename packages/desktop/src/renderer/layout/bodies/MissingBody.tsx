/**
 * Тело вкладки, чья сессия или комната пропали из карты работы, пока вкладка
 * была открыта (кусок 2.4, спека 5.10, план «На что смотреть», п. 3): вкладка
 * не закрывается сама — открывшее её восстановление раскладки уже выкинуло бы
 * её (`pruneLayout`, кусок 2.1/2.2), а тут вкладка ещё жива в памяти и просто
 * говорит, что показывать нечего. «Закрыть» убирает её явно.
 */

import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';

export interface MissingBodyProps {
  kind: 'session' | 'room';
  onClose: () => void;
}

export function MissingBody({ kind, onClose }: MissingBodyProps): JSX.Element {
  const message = kind === 'session' ? S.tabs.missingSession : S.tabs.missingRoom;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <p>{message}</p>
      <Button type="button" size="sm" onClick={onClose}>
        {S.common.close}
      </Button>
    </div>
  );
}
