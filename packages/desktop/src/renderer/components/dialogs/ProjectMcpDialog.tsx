/**
 * Карточка `project-mcp` в окне (спека 2026-11-02, 7): запуск Claude удержан, пока человек не выберет, какие серверы
 * MCP из `.mcp.json` включить. Все переключатели выключены. «Enable selected» шлёт `consents.decide(allow)` с включёнными
 * парами (возможно, пустым списком), «Reject all» — `deny`. Хост отказал как устаревшему (список сменился) — строка
 * «The server list changed — review again», диалог и карточка остаются. «Cancel» и Esc закрывают диалог, карточка
 * остаётся для острова.
 */

import { useState } from 'react';
import type { ProjectMcpCard } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { shortenMiddle } from '../../lib/shorten-middle.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { ProjectMcpServerList, repoName, useServerSelection } from './ProjectMcpServers.js';

export interface ProjectMcpDialogProps {
  card: ProjectMcpCard;
  /** Кто просил, готовой строкой («S03 Ruslan · create_session»); нет — строки нет. */
  requestedBy?: string;
  /** Решение уходит хосту; `stale` — хост отказал как устаревшему, `failed` — прочий сбой (тост у вызывающего). */
  onDecide: (decision: 'allow' | 'deny', enabled: Array<{ name: string; fingerprint: string }>) => Promise<'done' | 'stale' | 'failed'>;
  /** «Cancel», Esc и закрытие крестиком. */
  onCancel: () => void;
}

export function ProjectMcpDialog({ card, requestedBy, onDecide, onCancel }: ProjectMcpDialogProps): JSX.Element {
  const text = S.dialogs.projectMcp;
  const selection = useServerSelection(card.servers);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStale(false);
    const outcome = await onDecide(decision, decision === 'allow' ? selection.enabled : []);
    setBusy(false);
    if (outcome === 'stale') setStale(true);
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="w-[30rem] max-w-[calc(100vw-2rem)]">
        <DialogTitle>{text.title(repoName(card.repo))}</DialogTitle>
        <DialogDescription asChild>
          <div className="flex flex-col gap-1 text-sm">
            <span data-testid="project-mcp-repo" title={card.repo} className="font-mono text-[11px] text-muted-foreground">{shortenMiddle(card.repo)}</span>
            {requestedBy === undefined ? null : <span>{S.dialogs.trustFolder.requestedBy(requestedBy)}</span>}
            <span>{text.body}</span>
          </div>
        </DialogDescription>
        <ProjectMcpServerList servers={card.servers} isOn={selection.isOn} toggle={selection.toggle} disabled={busy} />
        {stale ? <p role="alert" data-testid="project-mcp-stale" className="text-sm text-[var(--status-warning-text)]">{text.stale}</p> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">{S.common.cancel}</Button>
          </DialogClose>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void decide('deny')}>{text.rejectAll}</Button>
          <Button type="button" variant="default" disabled={busy} onClick={() => void decide('allow')}>{text.enable}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
