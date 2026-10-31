/**
 * Диалог «Continue on another provider» (спека 2026-10-30, 5.2, 5.7, 6.9, 6.10): при открытии `sessions.switchOptions`,
 * цели — пилюли провайдеров (значок, лимиты, причина недоступности `needs`), предвыбран `suggested`; модель и effort
 * цели — как в «New session» (без выбора — умолчание роли); «Carry» — пакет передачи или транскрипт (только у цели с
 * `transcript`); блок «Keeps» и `blockers`. Живой агент не у приглашения (`busy`) — предупреждение и «Stop and continue»
 * (повтор с `force`). Один `requestId` на открытие: повторный клик — тот же запрос.
 *
 * Показывает диалог `SwitchAgentDialogHost`, смонтированный в `AppShell`; открывает `openSwitchAgent(ref)`.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Result, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { providerName, S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { effortChoices } from '../../lib/effort-choices.js';
import { PILL } from '../providers/pill.js';
import { closeSwitchAgent, useSwitchAgentStore } from '../../store/switch-agent.js';
import { useProvidersStore } from '../../store/providers.js';
import { useWorksStore } from '../../store/works.js';
import { sessionRowLabel } from '../../lib/participant.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { AgentIcon } from '../AgentIcon.js';
import { chosenEffort, chosenModel, DEFAULT_EFFORT, DEFAULT_MODEL } from './agent-rows.js';
import { ITEM_CLIP, LIST_HEIGHT } from './AgentRowsEditor.js';
import { radioGroupKeyDown } from './radio-keys.js';

type Options = Result<'sessions.switchOptions'>;
type Target = Options['targets'][number];

const text = S.dialogs.switchAgent;

function limitsText(limits: Target['limits']): string | null {
  const parts = [
    limits?.fiveHour == null ? null : text.limitsFive(limits.fiveHour.usedPercent),
    limits?.week == null ? null : text.limitsWeek(limits.week.usedPercent),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Строка «Keeps»: только непустые части. */
function keepsParts(keeps: Options['keeps'], sessionId: string): string[] {
  return [
    sessionId,
    keeps.leads.length > 0 ? text.lead(keeps.leads) : null,
    keeps.owns.length > 0 ? text.owner(keeps.owns) : null,
    keeps.children > 0 ? text.children(keeps.children) : null,
    keeps.worktree === null ? null : text.worktree(keeps.worktree),
    keeps.unread > 0 ? text.unread(keeps.unread) : null,
  ].filter((part): part is string => part !== null);
}

export interface SwitchAgentDialogProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  onClose: () => void;
}

export function SwitchAgentDialog({ bridge, sessionRef, onClose }: SwitchAgentDialogProps): JSX.Element {
  // Один запрос на открытие: повторный клик «Continue» несёт тот же id, и хост отвечает на него тем же ответом.
  const [requestId] = useState(() => crypto.randomUUID());
  const [options, setOptions] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [carry, setCarry] = useState<'handover' | 'transcript'>('handover');
  const [busy, setBusy] = useState(false);
  const [busyReason, setBusyReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = useProvidersStore((state) => state.providers);
  const session = useWorksStore((state) =>
    state.entries.find((entry) => entry.projectPath === sessionRef.projectPath && entry.map.work.id === sessionRef.workId)?.map.sessions.find((item) => item.id === sessionRef.sessionId),
  );

  useEffect(() => {
    let stale = false;
    bridge
      .call('sessions.switchOptions', { ref: sessionRef })
      .then((result) => {
        if (stale) return;
        setOptions(result);
        setProvider(result.suggested);
      })
      .catch((err: unknown) => {
        if (stale) return;
        console.warn('[parley] sessions.switchOptions', err);
        setLoadError(decodeIpcError(err).message);
      });
    return () => {
      stale = true;
    };
  }, [bridge, sessionRef]);

  const target = options?.targets.find((item) => item.id === provider) ?? null;
  const info = providers.find((item) => item.id === provider);
  const models = info?.models ?? [];
  const shownModel = chosenModel({ model }, info);
  const efforts = effortChoices(info, shownModel);
  const effectiveCarry = target?.transcript === true ? carry : 'handover';
  const blocked = options === null || options.blockers.length > 0 || target === null || !target.available;

  const select = (id: string): void => {
    setProvider(id);
    setModel(null);
    setEffort(null);
    setBusyReason(null);
    setError(null);
  };

  const submit = async (force: boolean): Promise<void> => {
    if (busy || target === null) return;
    // «Default» — умолчание роли: поля не шлются, иначе `null` перебил бы модель и effort роли (как в «New session»).
    const sentEffort = chosenEffort({ model: shownModel, effort }, info);
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.call('sessions.switchAgent', {
        ref: sessionRef,
        requestId,
        provider: target.id,
        ...(shownModel === null ? {} : { model: shownModel }),
        ...(sentEffort === null ? {} : { effort: sentEffort }),
        carry: effectiveCarry,
        ...(force ? { force: true } : {}),
      });
      if (result.outcome === 'held') {
        // Согласие на папку ждёт человека в отдельной карточке: диалог закрывается с пояснением.
        toast(text.held);
      }
      onClose();
    } catch (err) {
      console.warn('[parley] sessions.switchAgent', err);
      const failure = decodeIpcError(err);
      if (failure.data?.['reason'] === 'busy') setBusyReason(failure.message);
      else setError(failure.message || text.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[560px] max-w-[calc(100vw-2rem)]" aria-describedby={undefined}>
        <div className="flex shrink-0 flex-col gap-0.5">
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription className="text-xs text-neutral-700">{text.description(sessionRowLabel(sessionRef.sessionId, session?.label ?? ''))}</DialogDescription>
        </div>
        {loadError !== null ? (
          <p role="alert" className="text-sm text-destructive">{loadError}</p>
        ) : options === null ? (
          <p className="text-sm text-muted-foreground">{text.loading}</p>
        ) : (
          <div className="flex flex-col gap-(--space-3)">
            <div role="radiogroup" aria-label={text.targetGroup} onKeyDown={radioGroupKeyDown} className="flex flex-wrap gap-1.5">
              {options.targets.map((item) => {
                const on = item.id === provider;
                const limits = limitsText(item.limits);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    disabled={!item.available || busy}
                    title={item.available ? undefined : (item.needs ?? undefined)}
                    onClick={() => select(item.id)}
                    className={cn(PILL, on ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7', !item.available && 'opacity-45')}
                  >
                    <span aria-hidden="true" className="inline-flex"><AgentIcon provider={item.id} size={14} /></span>
                    {providerName(item.id, item.label)}
                    {limits === null ? null : <span className="text-xs font-normal text-muted-foreground">{limits}</span>}
                    {item.available || item.needs === null ? null : <span className="text-xs font-normal text-muted-foreground">{item.needs}</span>}
                  </button>
                );
              })}
            </div>
            {target !== null && (models.length > 0 || efforts !== null) ? (
              <div className="flex items-center gap-2">
                {models.length > 0 ? (
                  <Select
                    value={shownModel ?? DEFAULT_MODEL}
                    disabled={busy}
                    onValueChange={(value) => {
                      const next = value === DEFAULT_MODEL ? null : value;
                      setModel(next);
                      setEffort(chosenEffort({ model: next, effort }, info));
                    }}
                  >
                    <SelectTrigger aria-label={text.modelField} className="min-w-[120px] flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent className={LIST_HEIGHT}>
                      <SelectItem value={DEFAULT_MODEL} className={ITEM_CLIP}>{text.modelDefault}</SelectItem>
                      {models.map((item) => <SelectItem key={item.id} value={item.id} className={ITEM_CLIP}>{item.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : null}
                {efforts === null ? null : (
                  <Select value={chosenEffort({ model: shownModel, effort }, info) ?? DEFAULT_EFFORT} disabled={busy} onValueChange={(value) => setEffort(value === DEFAULT_EFFORT ? null : value)}>
                    <SelectTrigger aria-label={text.effortField} className="w-32 shrink-0"><SelectValue /></SelectTrigger>
                    <SelectContent className={LIST_HEIGHT}>
                      <SelectItem value={DEFAULT_EFFORT} className={ITEM_CLIP}>{text.effortDefault}</SelectItem>
                      {efforts.map((level) => <SelectItem key={level.id} value={level.id} description={level.description} className={ITEM_CLIP}>{level.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : null}
            <div role="radiogroup" aria-label={text.carryField} onKeyDown={radioGroupKeyDown} className="flex flex-col gap-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="carry" checked={effectiveCarry === 'handover'} onChange={() => setCarry('handover')} />
                {text.carryHandover}
              </label>
              {target?.transcript === true ? (
                <>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="carry" checked={effectiveCarry === 'transcript'} onChange={() => setCarry('transcript')} />
                    {text.carryTranscript}
                  </label>
                  <p data-transcript-hint className="pl-6 text-xs text-muted-foreground">{text.transcriptHint}</p>
                </>
              ) : null}
            </div>
            <p data-switch-keeps className="text-xs text-neutral-700">
              {text.keeps}: {keepsParts(options.keeps, sessionRef.sessionId).join(' · ')}
            </p>
            {options.blockers.length > 0 ? (
              <div role="alert" className="text-sm text-destructive">
                <p className="font-medium">{text.blockers}</p>
                <ul className="list-disc pl-5">{options.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
              </div>
            ) : null}
            {busyReason !== null ? (
              <div role="alert" data-switch-busy className="text-sm text-destructive">
                <p className="font-medium">{text.busyTitle}</p>
                <p>{busyReason} {text.busyHint}</p>
              </div>
            ) : null}
            {error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">{S.common.cancel}</Button>
          </DialogClose>
          <Button type="button" disabled={blocked || busy} onClick={() => void submit(busyReason !== null)}>
            {busyReason !== null ? text.stopAndContinue : text.continue}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Монтируется в `AppShell`: показывает диалог, пока в сторе есть сессия; новая сессия — новое открытие и новый `requestId`. */
export function SwitchAgentDialogHost({ bridge }: { bridge: ParleyBridge }): JSX.Element | null {
  const ref = useSwitchAgentStore((state) => state.ref);
  if (ref === null) return null;
  return <SwitchAgentDialog key={`${ref.projectPath} ${ref.workId} ${ref.sessionId}`} bridge={bridge} sessionRef={ref} onClose={closeSwitchAgent} />;
}
