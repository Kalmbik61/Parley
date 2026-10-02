/**
 * Граница ошибок вокруг отрисовки Markdown, который написал агент (Parley 0.3.0): сообщение комнаты
 * (`rooms/RoomMarkdown.tsx`) и письмо в почте (`mail/Letter.tsx`). Текст с тысячами вложенных `>` переполняет стек
 * в разборе или в отрисовке, и без этой границы ошибка уходила наверх — вкладка комнаты или почты целиком попадала в
 * `ErrorBoundary` (`shell/ErrorBoundary.tsx`) из-за одного сообщения. Теперь вместо Markdown человек видит сырой текст
 * сообщения как есть (`whitespace-pre-wrap`, цвета берутся от окружающего текста, как у отрисованного), а остальная
 * лента и вкладка живы.
 *
 * Граница сбрасывается, когда меняется текст: новый текст — новая попытка отрисовки (решение комнаты ведущий может
 * заменить до ответа человека). Превью файлов (`files/preview/MarkdownPreview.tsx`) границы не имеет.
 */

import { Component, type ReactNode } from 'react';

export interface MarkdownBoundaryProps {
  /** Исходный текст: при ошибке показывается он; смена текста сбрасывает границу. */
  text: string;
  /** Отрисованный Markdown. */
  children: ReactNode;
}

interface MarkdownBoundaryState {
  failed: boolean;
  /** Текст, под который выставлено `failed`: другой текст — другая попытка. */
  text: string;
}

export class MarkdownBoundary extends Component<MarkdownBoundaryProps, MarkdownBoundaryState> {
  override state: MarkdownBoundaryState = { failed: false, text: this.props.text };

  static getDerivedStateFromProps(
    props: MarkdownBoundaryProps,
    state: MarkdownBoundaryState,
  ): Partial<MarkdownBoundaryState> | null {
    return props.text === state.text ? null : { failed: false, text: props.text };
  }

  static getDerivedStateFromError(): Partial<MarkdownBoundaryState> {
    return { failed: true };
  }

  override render(): ReactNode {
    // Строчный элемент: граница стоит и в блоке, и в строчном виде плашки решений.
    return this.state.failed ? (
      <span data-markdown-fallback="" className="whitespace-pre-wrap">
        {this.props.text}
      </span>
    ) : (
      this.props.children
    );
  }
}
