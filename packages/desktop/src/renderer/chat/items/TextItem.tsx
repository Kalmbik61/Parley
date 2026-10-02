/**
 * Текст ответа модели (план 2026-10-01, решения 3 и 10): Markdown тем же `RoomMarkdown`, что в комнате
 * (правила ссылок и HTML — `lib/markdown-links.ts`), ссылки открываются в браузере человека. Упоминаний
 * сессий в ответе модели нет — `labelOf` пустой. Пока текст пишется (`streaming`), за ним мигает
 * курсор; обрезанный хостом текст — с пометкой.
 */

import type { FeedText } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { RoomMarkdown } from '../../components/rooms/RoomMarkdown.js';
import { useChatEnv } from '../chat-env.js';

const noLabel = (): null => null;

export function TextItem({ item }: { item: FeedText }): JSX.Element {
  const { bridge } = useChatEnv();
  return (
    <div data-testid="chat-text" className="min-w-0 text-sm [overflow-wrap:anywhere]">
      <RoomMarkdown text={item.text} labelOf={noLabel} onOpenExternal={(url) => void bridge.app.openExternal(url)} />
      {item.streaming ? (
        <span
          data-testid="chat-streaming"
          role="status"
          aria-label={S.chat.streaming}
          className="inline-block h-4 w-2 animate-pulse bg-foreground/60 align-text-bottom motion-reduce:animate-none"
        />
      ) : null}
      {item.truncated === true ? <p className="m-0 mt-1 text-xs text-[var(--status-warning-text)]">{S.chat.textTruncated}</p> : null}
    </div>
  );
}
