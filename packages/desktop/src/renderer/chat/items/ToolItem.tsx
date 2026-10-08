/**
 * Вызов инструмента в ленте (план 2026-10-01, решения 3 и 10): строка «статус · имя · сводка», по клику
 * раскрывается — аргументы JSON моноширинно, результат в `pre` с пределом высоты и прокруткой, дифф
 * хунками. Длинная команда или путь строку не раздвигают: сводка обрезается многоточием, целиком она
 * в подсказке и в раскрытых аргументах. Усечение результата (64 КБ хоста), входа и диффа — явной
 * пометкой «откройте терминал».
 *
 * Сжатый вид (`compact`) — вложенный вызов в карточке субагента: строка мельче, хунков у него нет.
 * Раскрытие управляется снаружи (лента помнит его по `id`: виртуальный список размонтирует строки вне
 * экрана) или, без `expanded`, самим элементом.
 */

import { useMemo, useState } from 'react';
import { Ban, Check, ChevronRight, LoaderCircle, X } from 'lucide-react';
import type { FeedTool, FeedToolStatus } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { toolHeadline } from '../feed-model.js';
import { DiffHunks } from './DiffHunks.js';

export interface ToolItemProps {
  item: FeedTool;
  compact?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}

export function ToolStatusIcon({ status }: { status: FeedToolStatus }): JSX.Element {
  const label = S.chat.toolStatus[status];
  const className = 'size-3.5 shrink-0';
  switch (status) {
    case 'running':
      return <LoaderCircle aria-label={label} data-status="running" className={cn(className, 'animate-spin text-muted-foreground motion-reduce:animate-none')} />;
    case 'done':
      return <Check aria-label={label} data-status="done" className={cn(className, 'text-[var(--status-success-text)]')} />;
    case 'failed':
      return <X aria-label={label} data-status="failed" className={cn(className, 'text-destructive')} />;
    case 'rejected':
      return <Ban aria-label={label} data-status="rejected" className={cn(className, 'text-muted-foreground')} />;
  }
}

const PRE = 'm-0 overflow-auto whitespace-pre-wrap rounded-sm bg-muted px-2 py-1.5 font-mono text-xs leading-[18px] [overflow-wrap:anywhere]';

function Note({ children }: { children: string }): JSX.Element {
  return <p className="m-0 text-xs text-[var(--status-warning-text)]">{children}</p>;
}

export function ToolItem({ item, compact = false, expanded, onToggle }: ToolItemProps): JSX.Element {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = expanded ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen((value) => !value));
  const headline = toolHeadline(item.name, item.input);
  // Вход `Write` бывает в сотни КБ: JSON строится, только пока вызов раскрыт, и лишь при новом входе.
  const args = useMemo(() => (open ? JSON.stringify(item.input, null, 2) : ''), [open, item.input]);
  const failedWord = item.status === 'failed' || item.status === 'rejected' ? S.chat.toolStatus[item.status] : null;

  return (
    <div data-testid="chat-tool" data-tool-status={item.status} className="flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        title={headline.summary ?? headline.name}
        onClick={toggle}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left hover:bg-foreground/7',
          compact ? 'h-6 text-xs' : 'h-7 text-sm',
        )}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <ToolStatusIcon status={item.status} />
        <span data-tool-name="" className="max-w-[45%] shrink-0 truncate font-mono font-semibold">
          {headline.name}
        </span>
        {headline.summary === null ? null : (
          <span data-tool-summary="" className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
            {headline.summary}
          </span>
        )}
        {failedWord === null ? null : <span className="ml-auto shrink-0 text-xs text-muted-foreground">{failedWord}</span>}
      </button>
      {open ? (
        <div data-testid="chat-tool-details" className="flex min-w-0 flex-col gap-1.5 pl-6">
          <span className="text-xs text-muted-foreground">{S.chat.arguments}</span>
          <pre className={cn(PRE, 'max-h-48')}>{args}</pre>
          {item.truncated === true ? <Note>{S.chat.inputTruncated}</Note> : null}
          {item.patch === undefined || item.patch.length === 0 ? null : (
            <>
              <span className="text-xs text-muted-foreground">{S.chat.changes}</span>
              <DiffHunks hunks={item.patch} />
              {item.patchTruncated === true ? <Note>{S.chat.patchTruncated}</Note> : null}
            </>
          )}
          {/* Законченный вызов без результата (правка файла Codex: в журнале у неё нет вывода) — без раздела Result. */}
          {item.response === undefined && item.status !== 'running' ? null : (
            <span className="text-xs text-muted-foreground">{S.chat.result}</span>
          )}
          {item.response === undefined ? (
            item.status === 'running' ? <span className="text-xs text-muted-foreground">{S.chat.noResult}</span> : null
          ) : (
            <>
              <pre data-testid="chat-tool-result" className={cn(PRE, 'max-h-60')}>
                {item.response.text}
              </pre>
              {item.response.truncated ? <Note>{S.chat.resultTruncated}</Note> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
