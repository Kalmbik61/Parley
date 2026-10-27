/** Только main решает, доказывает ли report текущей страницы реальный просмотр сессии. */
import type { BrowserWindow } from 'electron';
import { parseVisibilitySnapshot, type SessionVisibilitySnapshot } from '../../shared/island.js';

export function createSessionVisibility(push: (snapshot: SessionVisibilitySnapshot) => void) {
  let current: BrowserWindow | null = null;
  let seq = -1;
  let accepting = false;
  let snapshot: SessionVisibilitySnapshot = { version: 0, refs: [] };
  const publish = (refs: SessionVisibilitySnapshot['refs']): void => {
    snapshot = { version: snapshot.version + 1, refs };
    push(snapshot);
  };
  const alive = (): boolean => current !== null && !current.isDestroyed() && !current.webContents.isDestroyed();
  const visible = (): boolean => alive() && current!.isFocused() && current!.isVisible() && !current!.isMinimized();

  return {
    track(window: BrowserWindow): void {
      current = window;
      seq = -1;
      accepting = true;
      publish([]);
      const clear = (): void => { if (current === window) publish([]); };
      window.on('blur', clear);
      window.on('hide', clear);
      window.on('minimize', clear);
      window.on('closed', () => {
        if (current !== window) return;
        accepting = false;
        current = null;
        publish([]);
      });
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (current !== window || !isMainFrame || isInPlace) return;
        accepting = false;
        publish([]);
      });
      window.webContents.on('did-navigate', () => {
        if (current !== window) return;
        seq = -1;
        accepting = true;
        publish([]);
      });
      window.webContents.on('render-process-gone', () => {
        if (current !== window) return;
        accepting = false;
        publish([]);
      });
    },
    report(event: { sender?: unknown; senderFrame?: unknown }, value: unknown): void {
      if (!alive() || !accepting || event.sender !== current!.webContents || event.senderFrame !== current!.webContents.mainFrame) return;
      if (typeof value !== 'object' || value === null || Object.keys(value).some((key) => !['refs', 'seq', 'documentVisible'].includes(key))) return;
      const report = value as Record<string, unknown>;
      if (typeof report.documentVisible !== 'boolean') return;
      const parsed = parseVisibilitySnapshot({ version: report.seq, refs: report.refs });
      if (parsed === null || parsed.version <= seq) return;
      seq = parsed.version;
      publish(visible() && report.documentVisible ? parsed.refs : []);
    },
    snapshot(): SessionVisibilitySnapshot {
      if (!visible() && snapshot.refs.length > 0) publish([]);
      return snapshot;
    },
  };
}
