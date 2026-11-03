/**
 * The run record of the relay setup wizard changes by numbered events only (spec 8.1). The service in main applies
 * them to the record it keeps; the window applies the same ones to the snapshot it read with `state`. One function,
 * so the two never drift apart.
 */

import type { RelayPullProgress, RelayRunView, RelaySetupEventBody } from './relay-setup-types.js';

/** Lines kept per step in the record (the log file keeps all of them). */
export const RECORD_LINES = 200;

/** Changes `view` in place. */
export function applyRunEvent(view: RelayRunView, body: RelaySetupEventBody): void {
  switch (body.event) {
    case 'step': {
      const row = view.steps.find((step) => step.id === body.id);
      if (row !== undefined) row.status = body.status;
      // The download bar belongs to its step: it goes with it.
      if (body.status !== 'running' && view.progress?.step === body.id) view.progress = null;
      return;
    }
    case 'line': {
      const row = view.steps.find((step) => step.id === body.step);
      if (row === undefined) return;
      row.lines.push(body.text);
      if (row.lines.length > RECORD_LINES) row.lines.splice(0, row.lines.length - RECORD_LINES);
      return;
    }
    case 'progress':
      view.progress = { ...body.progress, step: body.step };
      return;
    case 'cancelling':
      view.cancelling = true;
      return;
    case 'phase':
      view.phase = body.phase;
      view.cancelling = false;
  }
}

/** The same on a copy; `seq` follows the event. For the window, whose state is immutable. */
export function withRunEvent(view: RelayRunView, event: RelaySetupEventBody & { seq: number }): RelayRunView {
  const next = structuredClone(view);
  applyRunEvent(next, event);
  next.seq = event.seq;
  return next;
}

/** «41.2 of 82.0 MB · 3 of 8 layers»; only layers when the sizes are unknown. */
export function describePullProgress(p: RelayPullProgress): string {
  const layers = `${p.layersDone} of ${p.layersTotal} layers`;
  return p.bytesTotal === null || p.bytesDone === null ? layers : `${(p.bytesDone / 1_000_000).toFixed(1)} of ${(p.bytesTotal / 1_000_000).toFixed(1)} MB · ${layers}`;
}

/** 0..100 for the bar: bytes when known, else layers. */
export function pullPercent(p: RelayPullProgress): number {
  const ratio = p.bytesTotal !== null && p.bytesDone !== null && p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : p.layersTotal > 0 ? p.layersDone / p.layersTotal : 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
