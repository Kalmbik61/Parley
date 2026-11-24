/**
 * Переключатель вида вкладки комнаты: Feed / Board. Повторное нажатие на выбранный пункт снимает
 * выбор у ToggleGroup — пустое значение пропускаем, как в `chat/ChatToolbar.tsx`.
 */

import type { RoomView } from '../../../../shared/layout-types.js';
import { S } from '../../../../shared/strings.js';
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group.js';

const ITEM = 'h-6 whitespace-nowrap px-2.5 text-xs';

export interface RoomViewSwitchProps {
  view: RoomView;
  onChange: (view: RoomView) => void;
}

export function RoomViewSwitch({ view, onChange }: RoomViewSwitchProps): JSX.Element {
  const choose = (value: string): void => {
    if (value !== 'feed' && value !== 'board') return;
    onChange(value);
  };
  return (
    <ToggleGroup type="single" size="sm" aria-label={S.roomBoard.viewLabel} value={view} onValueChange={choose}>
      <ToggleGroupItem value="feed" className={ITEM}>
        {S.roomBoard.feed}
      </ToggleGroupItem>
      <ToggleGroupItem value="board" className={ITEM}>
        {S.roomBoard.board}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
