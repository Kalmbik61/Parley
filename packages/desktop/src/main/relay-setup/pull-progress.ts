/**
 * Progress of the relay image download (spec 7.1): the lines of the Docker Engine API (`POST /images/create`, one
 * JSON object per line) or, as a fallback, the plain output of `docker pull` (layers only). Unknown statuses are
 * tolerated: a Docker release that renames one must not break the wizard. The raw lines never reach the window or
 * the log; they are turned into a few progress events and a short summary.
 */

import type { RelayPullProgress } from '../../shared/relay-setup-types.js';

/**
 * Query of the `images/create` call for an image reference. A digest wins over a text tag
 * (`caddy:2.11.7@sha256:…` → `fromImage=caddy&tag=sha256:…`); no digest → the tag or `latest`. `tag` is never empty,
 * an empty one would pull every tag of the repository.
 */
export function engineApiQuery(ref: string): string {
  const [named = '', digest] = ref.split('@');
  const slash = named.lastIndexOf('/');
  const colon = named.indexOf(':', slash + 1);
  const repository = colon === -1 ? named : named.slice(0, colon);
  const tag = digest ?? (colon === -1 ? 'latest' : named.slice(colon + 1));
  // ':' and '/' are legal in a query and keep the URL readable in the plan.
  const encode = (value: string): string => encodeURIComponent(value).replace(/%3A/g, ':').replace(/%2F/g, '/');
  return `fromImage=${encode(repository)}&tag=${encode(tag === '' ? 'latest' : tag)}`;
}

/** One image of the step: the Engine API when `curl` and the socket exist (progress by bytes), else `docker pull`. */
export function pullCommand(ref: string, quote: (value: string) => string, socket = '/var/run/docker.sock'): string {
  const url = `http://localhost/images/create?${engineApiQuery(ref)}`;
  return (
    `if command -v curl >/dev/null 2>&1 && [ -S ${socket} ]; then ` +
    `curl -sS --no-buffer --unix-socket ${socket} -X POST ${quote(url)}; ` +
    `else docker pull ${quote(ref)}; fi; docker image inspect ${quote(ref)} >/dev/null`
  );
}

export interface PullProgressSink {
  onProgress(progress: RelayPullProgress): void;
  /** A line for the log and the step output. */
  onLog(line: string): void;
  now?: () => number;
}

export interface PullProgress {
  feed(line: string): void;
  /** Flushes the last progress event. */
  finish(): void;
}

interface Layer {
  done: boolean;
  current: number;
  total: number;
}

const EVENT_GAP_MS = 250;
const LOG_GAP_MS = 15_000;
const LAYER_ID = /^[0-9a-f]{12,64}$/;
const PLAIN_LAYER = /^([0-9a-f]{12,64}): (.+)$/;
const REGISTERING = new Set(['Pulling fs layer', 'Waiting', 'Downloading', 'Extracting', 'Pull complete', 'Already exists']);

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

/** «41.2 of 82.0 MB · 3 of 8 layers»; only layers when the sizes are unknown. */
export function describeProgress(p: RelayPullProgress): string {
  const layers = `${p.layersDone} of ${p.layersTotal} layers`;
  return p.bytesTotal === null || p.bytesDone === null ? layers : `${megabytes(p.bytesDone)} of ${megabytes(p.bytesTotal)} MB · ${layers}`;
}

export function createPullProgress(sink: PullProgressSink): PullProgress {
  const now = sink.now ?? Date.now;
  const layers = new Map<string, Layer>();
  let lastEvent = Number.NEGATIVE_INFINITY;
  // Nothing is reported until the first layer shows up.
  let emitted = JSON.stringify({ layersDone: 0, layersTotal: 0, bytesDone: null, bytesTotal: null });
  let pending = false;
  let lastLogAt = now();
  let lastLogPercent = 0;

  const snapshot = (): RelayPullProgress => {
    let done = 0;
    let bytesDone = 0;
    let bytesTotal = 0;
    for (const layer of layers.values()) {
      if (layer.done) done += 1;
      bytesTotal += layer.total;
      bytesDone += layer.done ? layer.total : Math.min(layer.current, layer.total);
    }
    return { layersDone: done, layersTotal: layers.size, bytesDone: bytesTotal > 0 ? bytesDone : null, bytesTotal: bytesTotal > 0 ? bytesTotal : null };
  };

  const percentOf = (p: RelayPullProgress): number => {
    if (p.bytesTotal !== null && p.bytesDone !== null) return (p.bytesDone / p.bytesTotal) * 100;
    return p.layersTotal === 0 ? 0 : (p.layersDone / p.layersTotal) * 100;
  };

  function publish(force: boolean): void {
    const p = snapshot();
    const key = JSON.stringify(p);
    if (key === emitted) {
      pending = false;
      return;
    }
    const t = now();
    if (!force && t - lastEvent < EVENT_GAP_MS) {
      pending = true;
      return;
    }
    emitted = key;
    lastEvent = t;
    pending = false;
    sink.onProgress(p);
    const percent = percentOf(p);
    if (percent >= lastLogPercent + 10 || t - lastLogAt >= LOG_GAP_MS) {
      lastLogPercent = Math.floor(percent / 10) * 10;
      lastLogAt = t;
      sink.onLog(`downloading: ${describeProgress(p)}`);
    }
  }

  function layerStatus(id: string, status: string, current?: number, total?: number): void {
    let layer = layers.get(id);
    if (layer === undefined) {
      if (!REGISTERING.has(status)) return;
      layer = { done: false, current: 0, total: 0 };
      layers.set(id, layer);
    }
    if (status === 'Pull complete' || status === 'Already exists') layer.done = true;
    if (status === 'Downloading' && typeof total === 'number' && total > 0) {
      layer.total = total;
      layer.current = typeof current === 'number' ? current : layer.current;
    }
    if (status === 'Download complete' || status === 'Verifying Checksum') layer.current = layer.total;
  }

  function summary(text: string): void {
    sink.onLog(text);
    // A finished pull completes every layer, whatever their last status was.
    if (/^Status: (Downloaded newer image|Image is up to date)/.test(text)) for (const layer of layers.values()) layer.done = true;
  }

  function feedJson(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const o = value as { status?: unknown; id?: unknown; error?: unknown; message?: unknown; progressDetail?: { current?: unknown; total?: unknown; units?: unknown } };
    if (typeof o.error === 'string') {
      sink.onLog(`error: ${o.error}`);
      return;
    }
    if (typeof o.status !== 'string') {
      if (typeof o.message === 'string') sink.onLog(`error: ${o.message}`);
      return;
    }
    if (typeof o.id === 'string' && LAYER_ID.test(o.id)) {
      const detail = o.progressDetail;
      // «Extracting» carries a unit («s»), not bytes.
      const bytes = detail !== undefined && detail.units === undefined;
      layerStatus(o.id, o.status, bytes && typeof detail.current === 'number' ? detail.current : undefined, bytes && typeof detail.total === 'number' ? detail.total : undefined);
      return;
    }
    if (/^(Status|Digest):|^Pulling from /.test(o.status)) summary(o.status);
  }

  return {
    feed(raw) {
      const line = raw.trim();
      if (line === '') return;
      if (line.startsWith('{')) {
        try {
          feedJson(JSON.parse(line));
          publish(false);
          return;
        } catch {
          // not JSON after all: handled as text below
        }
      }
      const layer = PLAIN_LAYER.exec(line);
      if (layer !== null) {
        layerStatus(layer[1] as string, layer[2] as string);
        publish(false);
        return;
      }
      if (/^(Status|Digest):/.test(line)) summary(line);
      else sink.onLog(line);
      publish(false);
    },
    finish() {
      if (pending) publish(true);
    },
  };
}
