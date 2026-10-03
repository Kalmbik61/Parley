import { useEffect, useRef, useState } from 'react';
import { capabilitySnapshot } from '@parley/protocol';
import type { CapabilitySnapshot } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { hostMethods } from '../../lib/capabilities.js';
import { openParleyEditor } from '../../sidebar/SectionMenu.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
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
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef(new Set<string>());
  const generation = useRef(0);
  const revision = useRef(-1);
  const request = useRef<(() => void) | null>(null);
  const [parley, setParley] = useState<{ exists: boolean | null; busy: boolean; error: boolean }>({ exists: null, busy: false, error: false });
  const parleyGeneration = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    revision.current = -1; request.current = null;
    setSnapshot(null); setError(false); setBusy(false);
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

  return <Dialog open={projectPath !== null} onOpenChange={onOpenChange}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-4xl">
      <DialogTitle>{S.projectPanel.title}</DialogTitle>
      <DialogDescription className="break-all">{projectPath}</DialogDescription>
      <div className="space-y-5">
        <section aria-label="PARLEY.md" className="space-y-2 rounded-md border border-border p-3">
          <h3 className="font-medium">PARLEY.md</h3>
          <p className="text-sm">{S.projectPanel.parleyDescription}</p>
          {parley.exists === null && !parley.error && <p role="status" className="text-xs">{S.projectPanel.parleyLoading}</p>}
          {parley.error && <p role="alert" className="text-sm text-destructive">{S.projectPanel.parleyFailed}</p>}
          <Button type="button" variant="outline" disabled={parley.exists === null || parley.busy} onClick={openParley}>
            {parley.exists === false ? S.sidebar.createParleyMd : S.sidebar.openParleyMd}
          </Button>
        </section>
        <Tabs defaultValue="capabilities">
          <TabsList aria-label={S.projectPanel.title}><TabsTrigger value="capabilities">{S.projectPanel.capabilities}</TabsTrigger></TabsList>
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
              <CapabilitiesPanel snapshot={snapshot} />
            </>}
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  </Dialog>;
}
