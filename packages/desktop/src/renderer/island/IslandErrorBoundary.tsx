/**
 * Граница ошибок окна острова (спека 2026-10-12): упавшая отрисовка не должна оставить прозрачное окно поверх экрана и
 * при этом глушить системные уведомления (main не показывает их, пока остров «жив»). Граница не рисует ничего и один
 * раз сообщает main через `api.failed()` — тот снимает признак «страница загружена» и прячет окно.
 */

import { Component, type ReactNode } from 'react';
import type { IslandApi } from '../../shared/island.js';

export interface IslandErrorBoundaryProps {
  api: Pick<IslandApi, 'failed'>;
  children: ReactNode;
}

export class IslandErrorBoundary extends Component<IslandErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // После падения дети не рисуются, поэтому второй раз граница не сработает.
    this.props.api.failed();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
