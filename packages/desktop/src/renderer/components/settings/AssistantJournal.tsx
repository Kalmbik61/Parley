/**
 * Settings → Assistant → «Recent actions»: журнал решений помощника (`assistant.journal`). Читается при открытии
 * вкладки; хоста без метода это не касается — список не показывается.
 */
import { useEffect, useState } from 'react';
import type { AssistantJournalItem } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { getHostClient } from '../../host-client.js';
import { hostMethods } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';

const text = S.assistant.settings;

export function AssistantJournal(): JSX.Element | null {
  const status = useHostStore((state) => state.status);
  const supported = hostMethods(status).has('assistant.journal');
  const [items, setItems] = useState<AssistantJournalItem[] | null>(null);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void getHostClient()
      .call('assistant.journal', { limit: 30 })
      .then((result) => {
        if (alive) setItems(result.items);
      });
    return () => {
      alive = false;
    };
  }, [supported]);

  if (!supported || items === null) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="assistant-journal">
      <span>{text.journalTitle}</span>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{text.journalEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-col rounded border px-2 py-1 text-xs" data-testid="assistant-journal-row">
              <span className="text-muted-foreground">
                {item.decidedAt === null ? '' : new Date(item.decidedAt).toLocaleString()}
                {item.via === 'auto' ? <span className="ml-1 rounded bg-muted px-1">{text.journalAuto}</span> : null}
              </span>
              {item.lines.map((line, index) => (
                <span key={index} className="truncate" title={line}>
                  {line}
                </span>
              ))}
              {item.outcome !== null ? <span className="truncate text-muted-foreground">{item.outcome}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
