// Что телефон может в этом соединении (спека §4.2 «Запуск с телефона», §11.2 п. 9): по `methods` из hello моста,
// то есть по пересечению белого списка, переключателя хоста и методов хоста эпохи. Нет hello — нельзя ничего.
import type { RemoteState } from './state.js';

export interface LaunchCapabilities {
  canCreateSession: boolean;
  canCreateRoom: boolean;
  /** Письмо в комнату, в том числе первое — задача тихой комнаты. */
  canSendRoomMessage: boolean;
  /** Каталоги для диалогов запуска. */
  canListProviders: boolean;
  canListRoles: boolean;
}

export function selectLaunchCapabilities(state: Pick<RemoteState, 'methods'>): LaunchCapabilities {
  const has = (m: string): boolean => state.methods?.includes(m) ?? false;
  return {
    canCreateSession: has('sessions.create'),
    canCreateRoom: has('rooms.create'),
    canSendRoomMessage: has('rooms.send'),
    canListProviders: has('providers.list'),
    canListRoles: has('roles.list'),
  };
}
