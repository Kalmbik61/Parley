// Хранилище маршрутов и устройств (спека 6.2): JSON-файл с атомарной записью, без нативных зависимостей.
// Хранятся только sha256 секрета маршрута и sha256 токенов устройств.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RouteRecord {
  secretHash: string;
  createdAt: number;
  lastSeen: number;
}
export interface DeviceRecord {
  device: string;
  tokenHash: string;
}
interface Snapshot {
  v: 1;
  routes: Record<string, RouteRecord>;
  devices: Record<string, DeviceRecord[]>;
}

export const MAX_ROUTES = 10_000;
export const MAX_DEVICES_PER_ROUTE = 64;
/** Маршрут без устройств, к которому не было моста сутки, — мусор (ревью A4, M2). */
export const EMPTY_ROUTE_TTL_MS = 24 * 3_600_000;
/** Маршрут, мост которого не появлялся 30 дней, удаляется; вернувшийся мост создаст его заново тем же `hello`. */
export const ROUTE_TTL_MS = 30 * 24 * 3_600_000;
/** Запись на диск отложена: всплеск `hello` и `devices` даёт одну запись (ревью A4, M2, m8). */
export const WRITE_DELAY_MS = 1_000;

/** `path = null` — только память (dev-relay: мост сам шлёт `hello` и `devices` после перезапуска). */
export class Store {
  private routes = new Map<string, RouteRecord>();
  private devices = new Map<string, DeviceRecord[]>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string | null,
    private readonly now: () => number = Date.now,
    /** Ошибка записи не роняет relay: состояние остаётся в памяти, код ошибки уходит в журнал. */
    private readonly onError: (code: string) => void = () => {},
    private readonly writeDelayMs: number = WRITE_DELAY_MS,
  ) {
    if (path === null) return;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('store: cannot read the data file');
    }
    let snap: Snapshot;
    try {
      snap = JSON.parse(text) as Snapshot;
    } catch {
      throw new Error('store: the data file is not valid JSON');
    }
    if (snap.v !== 1 || typeof snap.routes !== 'object' || typeof snap.devices !== 'object') {
      throw new Error('store: unsupported data file');
    }
    for (const [id, r] of Object.entries(snap.routes)) this.routes.set(id, r);
    for (const [id, l] of Object.entries(snap.devices)) this.devices.set(id, l);
  }

  routeCount(): number {
    return this.routes.size;
  }

  route(routeId: string): RouteRecord | undefined {
    return this.routes.get(routeId);
  }

  /** Создаёт маршрут (доверие при первом использовании). */
  createRoute(routeId: string, secretHash: string): void {
    const t = this.now();
    this.routes.set(routeId, { secretHash, createdAt: t, lastSeen: t });
    this.persist();
  }

  touch(routeId: string): void {
    const r = this.routes.get(routeId);
    if (!r) return;
    r.lastSeen = this.now();
    this.persist();
  }

  devicesOf(routeId: string): readonly DeviceRecord[] {
    return this.devices.get(routeId) ?? [];
  }

  deviceHash(routeId: string, device: string): string | undefined {
    return this.devices.get(routeId)?.find((d) => d.device === device)?.tokenHash;
  }

  /** Полная замена списка устройств маршрута. */
  replaceDevices(routeId: string, list: DeviceRecord[]): void {
    this.devices.set(
      routeId,
      list.slice(0, MAX_DEVICES_PER_ROUTE).map((d) => ({ device: d.device, tokenHash: d.tokenHash })),
    );
    this.persist();
  }

  /**
   * Сборка мусора: маршруты без устройств, не видевшие моста `EMPTY_ROUTE_TTL_MS`, и любые маршруты, не видевшие
   * его `ROUTE_TTL_MS`. Маршрут с подключённым мостом не трогается. Возвращает число удалённых.
   */
  gc(attached: (routeId: string) => boolean): number {
    const t = this.now();
    let removed = 0;
    for (const [id, r] of this.routes) {
      if (attached(id)) continue;
      const idle = t - r.lastSeen;
      const empty = (this.devices.get(id)?.length ?? 0) === 0;
      if (idle >= ROUTE_TTL_MS || (empty && idle >= EMPTY_ROUTE_TTL_MS)) {
        this.routes.delete(id);
        this.devices.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** Немедленная запись отложенных изменений (остановка relay). */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || this.path === null) return;
    this.dirty = false;
    const snap: Snapshot = {
      v: 1,
      routes: Object.fromEntries(this.routes),
      devices: Object.fromEntries(this.devices),
    };
    try {
      this.write(snap, this.path);
    } catch (e) {
      // Следующее изменение или остановка повторят запись.
      this.dirty = true;
      this.onError((e as NodeJS.ErrnoException).code ?? 'EIO');
    }
  }

  private persist(): void {
    if (this.path === null) return;
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.writeDelayMs);
    this.timer.unref();
  }

  private write(snap: Snapshot, path: string): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.relay-${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(snap));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }
}
