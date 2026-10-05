import { useEffect, useRef, useState } from 'react';
import { capabilityActionResult, capabilitySnapshot } from '@parley/protocol';
import type { CapabilityActionResult, CapabilityMcpAdd, CapabilityPresence, CapabilityProvider, CapabilitySnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { openParleyEditor } from '../../sidebar/SectionMenu.js';
import { useHostStore } from '../../store/host.js';
import { useWorksStore } from '../../store/works.js';
import { RoleChip } from '../../lib/role-summary.js';
import { BacklogPanel } from './BacklogPanel.js';
import { DecisionsPanel } from './DecisionsPanel.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { McpForm } from './McpForm.js';
import { CapabilitiesPanel } from './CapabilitiesPanel.js';

export interface ProjectPanelProps {
  bridge: ParleyBridge;
  projectPath: string | null;
  onOpenChange(open: boolean): void;
}

/** One project window, with one safe snapshot lifecycle independent of chat completion hints. */
export function ProjectPanel({ bridge, projectPath, onOpenChange }: ProjectPanelProps): JSX.Element {
  const status = useHostStore(state => state.status);
  const connection = useHostStore(state => state.connections);
  const methods = hostMethods(status);
  const supported = methods.has('capabilities.get') && methods.has('capabilities.refresh');
  const entries = useWorksStore(state => state.entries);
  const [pendingSuggestions, setPendingSuggestions] = useState(0);
  const backlogSupported = ['backlog.get', 'backlog.subscribe', 'backlog.unsubscribe', 'backlog.prepareTake', 'backlog.take'].every(method => methods.has(method));
  const backlogWork = entries.find(entry => entry.projectPath === projectPath && entry.map.work.status === 'active');
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef(new Set<string>());
  const generation = useRef(0);
  const revision = useRef(-1);
  const request = useRef<(() => void) | null>(null);
  const [parley, setParley] = useState<{ exists: boolean | null; busy: boolean; error: boolean }>({ exists: null, busy: false, error: false });
  const parleyGeneration = useRef(0);
  const [formOpen, setFormOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionAttempted, setActionAttempted] = useState(false);
  const [actionResult, setActionResult] = useState<CapabilityActionResult | null>(null);
  const [runningSessions, setRunningSessions] = useState<number | null>(null);
  const countRequest = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    revision.current = -1; request.current = null;
    setSnapshot(null); setError(false); setBusy(false); setFormOpen(false); setActionBusy(false); setActionAttempted(false); setActionResult(null); setRunningSessions(null); ++countRequest.current;
    if (projectPath === null || !supported) return;
    let sequence = 0;
    const apply = (value: unknown, reportInvalid = true): void => {
      if (generation.current !== current) return;
      const parsed = capabilitySnapshot.safeParse(value);
      if (!parsed.success) { if (reportInvalid) setError(true); return; }
      if (parsed.data.projectPath !== projectPath) return;
      if (parsed.data.revision <= revision.current) return;
      revision.current = parsed.data.revision;
      setSnapshot(parsed.data); setError(false);
    };
    const unsubscribe = bridge.on('capabilities.changed', event => {
      if (event.projectPath === projectPath) apply(event.snapshot);
    });
    const load = (refresh: boolean): void => {
      const id = ++sequence;
      const startedRevision = revision.current;
      setBusy(true); setError(false);
      void bridge.call(refresh ? 'capabilities.refresh' : 'capabilities.get', { projectPath }).then(value => {
        if (generation.current === current && id === sequence) apply(value, revision.current <= startedRevision);
      }).catch(() => {
        if (generation.current === current && id === sequence && revision.current <= startedRevision) setError(true);
      }).finally(() => {
        if (generation.current === current && id === sequence) setBusy(false);
      });
    };
    request.current = () => load(true);
    load(seen.current.has(projectPath)); seen.current.add(projectPath);
    return () => { ++generation.current; request.current = null; unsubscribe(); };
  }, [bridge, projectPath, supported, connection]);

  useEffect(() => {
    const current = ++parleyGeneration.current;
    setParley({ exists: null, busy: false, error: false });
    if (projectPath === null) return;
    void bridge.app.parleyMd(projectPath, false).then(result => {
      if (parleyGeneration.current === current) setParley({ exists: result.exists, busy: false, error: false });
    }).catch(() => {
      if (parleyGeneration.current === current) setParley({ exists: null, busy: false, error: true });
    });
    return () => { ++parleyGeneration.current; };
  }, [bridge, projectPath]);

  const openParley = (): void => {
    if (projectPath === null || parley.exists === null || parley.busy) return;
    const current = parleyGeneration.current;
    const create = parley.exists === false;
    setParley(value => ({ ...value, busy: true, error: false }));
    void bridge.app.parleyMd(projectPath, create).then(result => {
      if (parleyGeneration.current !== current) return;
      setParley({ exists: result.exists, busy: false, error: !result.exists });
      if (result.exists) { onOpenChange(false); openParleyEditor(projectPath); }
    }).catch(() => {
      if (parleyGeneration.current === current) setParley(value => ({ ...value, busy: false, error: true }));
    });
  };

  const loadRunningCount = (providers: readonly CapabilityProvider[], current: number): void => {
    const sequence = ++countRequest.current;
    setRunningSessions(null);
    if (projectPath === null || !methods.has('works.list')) return;
    void bridge.call('works.list', {}).then(value => {
      if (generation.current !== current || countRequest.current !== sequence) return;
      if (!Array.isArray(value.entries) || value.entries.length > 10_000) return;
      let count = 0; let visited = 0;
      for (const entry of value.entries) {
        if (typeof entry.projectPath !== 'string' || !Array.isArray(entry.map?.sessions)) return;
        if (entry.projectPath !== projectPath) continue;
        for (const session of entry.map.sessions) {
          if (++visited > 100_000 || !session || typeof session.provider !== 'string' ||
            !['pending', 'active', 'sleeping', 'closed'].includes(session.lifecycle)) return;
          if (session.lifecycle === 'active' && providers.some(provider => provider === session.provider)) ++count;
        }
      }
      setRunningSessions(count);
    }).catch(() => {});
  };

  const targetAction = (kind: 'remove' | 'check', provider: CapabilityProvider, presence: CapabilityPresence, expectedRevision: number): void => {
    if (projectPath === null || actionBusy || !methods.has(`capabilities.mcp.${kind}`)) return;
    const current = generation.current; const startedRevision = revision.current;
    setActionBusy(true); setActionAttempted(true); setActionResult(null); setRunningSessions(null); ++countRequest.current;
    const params = { projectPath, provider, presenceId: presence.id, revision: expectedRevision };
    void bridge.call(kind === 'remove' ? 'capabilities.mcp.remove' : 'capabilities.mcp.check', params).then(value => {
      if (generation.current !== current) return;
      loadRunningCount([provider], current);
      if (revision.current > startedRevision) return;
      const parsed = capabilityActionResult.safeParse(value);
      setActionResult(parsed.success ? parsed.data : { outcome: 'failed', code: 'invalid-output' });
    }).catch(() => {
      if (generation.current === current) { loadRunningCount([provider], current); if (revision.current <= startedRevision) setActionResult({ outcome: 'failed', code: 'cli-error' }); }
    }).finally(() => { if (generation.current === current) setActionBusy(false); });
  };
  const submitMcp = async (requests: CapabilityMcpAdd[]): Promise<Array<{ provider: CapabilityProvider; result: CapabilityActionResult }>> => {
    if (actionBusy || !methods.has('capabilities.mcp.add')) return [];
    const current = generation.current; const startedRevision = revision.current;
    setActionBusy(true); setActionAttempted(true); setActionResult(null); setRunningSessions(null); ++countRequest.current;
    try {
      const results = await Promise.all(requests.map(async request => {
        let result: CapabilityActionResult;
        try { const parsed = capabilityActionResult.safeParse(await bridge.call('capabilities.mcp.add', request));
          result = parsed.success ? parsed.data : { outcome: 'failed', code: 'invalid-output' };
        } catch { result = { outcome: 'failed', code: 'cli-error' }; }
        return { provider: request.provider, result };
      }));
      if (generation.current !== current) return [];
      loadRunningCount(requests.map(request => request.provider), current);
      if (revision.current > startedRevision) return [];
      return results;
    } finally { if (generation.current === current) setActionBusy(false); }
  };
  const canAdd = methods.has('capabilities.mcp.add') && snapshot !== null &&
    Object.values(snapshot.columns).some(column => Object.values(column.mcpAdd ?? {}).some(value => value.allowed));

  return <Dialog open={projectPath !== null} onOpenChange={onOpenChange}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-4xl">
      <DialogTitle>{S.projectPanel.title}</DialogTitle>
      <DialogDescription className="shrink-0 break-all">{projectPath}</DialogDescription>
      <div className="flex flex-col gap-5">
        <section aria-label="PARLEY.md" className="shrink-0 space-y-2 rounded-md border border-border p-3">
          <h3 className="font-medium">PARLEY.md</h3>
          <p className="text-sm">{S.projectPanel.parleyDescription}</p>
          {parley.exists === null && !parley.error && <p role="status" className="text-xs">{S.projectPanel.parleyLoading}</p>}
          {parley.error && <p role="alert" className="text-sm text-destructive">{S.projectPanel.parleyFailed}</p>}
          <Button type="button" variant="outline" disabled={parley.exists === null || parley.busy} onClick={openParley}>
            {parley.exists === false ? S.sidebar.createParleyMd : S.sidebar.openParleyMd}
          </Button>
        </section>
        <Tabs defaultValue="capabilities" className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label={S.projectPanel.title} className="self-start"><TabsTrigger value="capabilities">{S.projectPanel.capabilities}</TabsTrigger><TabsTrigger value="backlog">{S.backlog.title}{pendingSuggestions > 0 ? ` (${pendingSuggestions})` : ''}</TabsTrigger><TabsTrigger value="decisions">{S.decisions.title}</TabsTrigger></TabsList>
          <TabsContent value="capabilities" className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-muted-foreground">{S.projectPanel.appliesToNew}</p>
              <Button type="button" variant="outline" disabled={!supported || busy} onClick={() => request.current?.()}>{S.projectPanel.refresh}</Button>
            </div>
            {!supported ? <div role="status" className="space-y-2 text-sm">
              <p>{status.state === 'connected' ? S.projectPanel.unavailable : S.projectPanel.disconnected}</p>
              {status.state === 'connected' && <Button type="button" variant="outline" onClick={() => {
                onOpenChange(false); useUiStore.getState().confirmRestartHost();
              }}>{S.projectPanel.restartHost}</Button>}
            </div> : <>
              {error && <p role="alert" className="text-sm text-destructive">{S.projectPanel.loadFailed}</p>}
              {methods.has('capabilities.mcp.add') && <Button type="button" variant="outline" disabled={!canAdd || actionBusy} onClick={() => setFormOpen(true)}>{S.mcpActions.add}</Button>}
              {formOpen && snapshot && <McpForm key={`form:${projectPath}:${connection}`} snapshot={snapshot} submit={submitMcp} onCancel={() => setFormOpen(false)} />}
              {actionBusy && <p role="status" className="text-sm">{S.mcpActions.queued}</p>}
              {actionResult && <p role="status" className="text-sm">{S.mcpActions.codes[actionResult.code]}{actionResult.status ? ` · ${actionResult.status === 'ok' ? S.mcpActions.connected : S.projectPanel.statuses[actionResult.status]}` : ''}</p>}
              {actionResult?.recovery === 'native-mcp' && <p>{S.mcpActions.nativeRecovery}</p>}
              <CapabilitiesPanel key={`inventory:${projectPath}:${connection}`} snapshot={snapshot} bridge={bridge}
                {...(methods.has('capabilities.mcp.remove') || methods.has('capabilities.mcp.check') ? { actions: {
                  busy: actionBusy, supports: { remove: methods.has('capabilities.mcp.remove'), check: methods.has('capabilities.mcp.check') },
                  remove: (provider: CapabilityProvider, presence: CapabilityPresence, expected: number) => targetAction('remove', provider, presence, expected),
                  check: (provider: CapabilityProvider, presence: CapabilityPresence, expected: number) => targetAction('check', provider, presence, expected),
                } } : {})} />
              {actionAttempted || formOpen ? <p className="text-xs text-muted-foreground">{runningSessions === null ? S.mcpActions.appliesToNew : S.mcpActions.runningSessions(runningSessions)}</p> : null}
            </>}
          </TabsContent>
          <TabsContent value="backlog" forceMount className="data-[state=inactive]:hidden space-y-3">
            <BacklogPanel bridge={bridge} projectPath={projectPath} supported={backlogSupported} connection={connection}
              canTake={backlogWork !== undefined} onCount={setPendingSuggestions}
              onOpenFile={async project => { await bridge.app.openBacklog(project); }}
              onTake={(project, item, version) => {
                if (!backlogWork || item.id === null) throw new Error('An active workspace is required.');
                onOpenChange(false);
                useUiStore.getState().openNewSessionDialog({ projectPath: project, workId: backlogWork.map.work.id }, {
                  room: true, backlog: { projectPath: project, id: item.id, version,
                    task: [item.title, item.details].filter(Boolean).join('\n\n') } });
              }} renderAuthor={suggestion => suggestion.author ? <span>{suggestion.author.label} <RoleChip
                role={suggestion.author.role} sessionRef={{ projectPath: suggestion.author.projectPath,
                  workId: suggestion.author.workId, sessionId: suggestion.author.sessionId }} bridge={bridge} revision={suggestion.author.revision} /></span>
                : `${suggestion.workId}/${suggestion.sessionId}`} />
          </TabsContent>
          {/* Список решений прокручивается внутри диалога: общий верх (путь, PARLEY.md) его не вытесняет.
              min-h-48 — запас, чтобы в низком окне список не сжимался в одну строку: тогда прокручивается вся колонка. */}
          <TabsContent value="decisions" className="min-h-48 flex-1 overflow-auto">
            <DecisionsPanel bridge={bridge} projectPath={projectPath} supported={methods.has('decisions.list')} connection={connection}
              onOpen={async (project, file) => { await bridge.app.openDecision(project, file); }} />
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  </Dialog>;
}
