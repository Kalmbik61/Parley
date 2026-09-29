/**
 * Текст сообщения ленты (спека окна 2026-09-29, 1.3, 1.4): токены `@s02` — чипом с ярлыком участника,
 * ссылки http(s) — кликабельны (в системном браузере, `app.openExternal`: переход в самом окне открыл
 * бы чужой домен в песочнице). Остальное — как есть; переносы и пробелы держит `pre-wrap` родителя.
 * Разметка markdown не разбирается: текст комнаты — обычный текст (1.3).
 */

import { sessionTag } from '../../lib/participant.js';
import { MENTION_CHIP_CLASS, segmentText } from './mention.js';

export interface MentionTextProps {
  text: string;
  /** Ярлык участника для чипа: `S02 бэкенд`; неизвестной сессии — `S02`. */
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
}

export function MentionText({ text, labelOf, onOpenExternal }: MentionTextProps): JSX.Element {
  return (
    <>
      {segmentText(text).map((segment, index) => {
        if (segment.kind === 'text') return segment.text;
        if (segment.kind === 'link') {
          return (
            <a
              key={index}
              href={segment.url}
              onClick={(event) => {
                event.preventDefault();
                onOpenExternal(segment.url);
              }}
              className="text-primary underline"
            >
              {segment.text}
            </a>
          );
        }
        return (
          <span key={index} data-mention={segment.sessionId} className={MENTION_CHIP_CLASS}>
            @{labelOf(segment.sessionId) ?? sessionTag(segment.sessionId)}
          </span>
        );
      })}
    </>
  );
}
