/**
 * Граница ошибки поверхности/вкладки (кусок 2.3, спека 5.10): упавший
 * компонент не роняет всё окно. «Повторить» перемонтирует детей целиком
 * (через `key`) — единственный надёжный способ дать упавшему поддереву
 * попытаться собраться заново, раз React не даёт `componentDidCatch` без
 * класса. Оборачивает сайдбар и центр (`AppShell.tsx`); вкладки — с 2.4,
 * поверхности — с 2.5.
 */

import { Component, Fragment, type ReactNode } from 'react';
import { S } from '../../shared/strings.js';
import { Button } from '../ui/button.js';

export interface ErrorBoundaryProps {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Меняется на «Повторить» — новый `key` у `Fragment` заставляет React пересобрать детей. */
  attempt: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  private readonly retry = (): void => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error !== null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-foreground">
          <p className="font-medium">{this.props.title}</p>
          <p className="text-xs text-muted-foreground">{error.message}</p>
          <div className="mt-1 flex gap-2">
            <Button type="button" size="sm" onClick={this.retry}>
              {S.common.retry}
            </Button>
            {this.props.onClose !== undefined ? (
              <Button type="button" size="sm" variant="ghost" onClick={this.props.onClose}>
                {S.common.close}
              </Button>
            ) : null}
          </div>
        </div>
      );
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>;
  }
}
