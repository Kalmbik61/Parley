/**
 * Что умеет хост, к которому подключено окно (спека 3.2). Хост живёт дольше
 * окна: после обновления приложения окно может говорить со старым хостом. Тогда
 * функции с неизвестным ему методом прячутся, а строка статуса предлагает
 * перезапуск, — жёсткий `mismatch` остаётся только для несовместимого протокола.
 */

import type { HostStatus } from '../../shared/bridge.js';
import { useHostStore } from '../store/host.js';

/**
 * Методы и уведомления протокола 1 до этого плана — их умеет любой хост.
 * Дословно ключи `METHODS` и `NOTIFICATIONS` на коммите `0a93b93`: хост без
 * поля `methods` в `hello` понимает ровно их.
 */
export const BASELINE_METHODS: readonly string[] = [
  'hello',
  'host.info',
  'host.shutdown',
  'providers.list',
  'works.list',
  'works.create',
  'works.delete',
  'sessions.create',
  'sessions.resume',
  'sessions.stop',
  'sessions.delete',
  'sessions.close',
  'sessions.interrupted',
  'sessions.resumeInterrupted',
  'pty.attach',
  'pty.detach',
  'wake.pause',
  'wake.resume',
  'wake.state',
  'settings.get',
  'settings.set',
  'rooms.create',
  'rooms.send',
  'worktrees.available',
  'worktrees.diff',
  'worktrees.commit',
  'worktrees.merge',
  'worktrees.discard',
  'pty.input',
  'pty.resize',
];

/**
 * Что нужно окну этой сборки; пополняется в 3.1, 4.1, 5.1, 8.1 и комнатами Organic. `rooms.addMember` (вступление в
 * комнату, бросок на её строку) и `rooms.resolveProposal` (ответ на решение) — хост старее окна их не знает, и строка
 * статуса предлагает перезапуск, а не молча прячет функции (спека Orca-UI 3.2).
 */
export const REQUIRED_METHODS: readonly string[] = [
  ...BASELINE_METHODS,
  'providers.setKey',
  'providers.clearKey',
  'works.rename',
  'works.setStatus',
  'activity.seen',
  'mail.markRead',
  'pty.send',
  'worktrees.mergeCheck',
  'changes.project',
  'changes.commitProject',
  'rooms.addMember',
  'rooms.resolveProposal',
];

/** Методы хоста; без связи — пусто: звать всё равно некого. */
export function hostMethods(status: HostStatus): Set<string> {
  if (status.state !== 'connected') return new Set();
  return new Set(status.methods ?? BASELINE_METHODS);
}

/**
 * Чего окну не хватает у хоста. Только у `connected`: без связи подсказывать
 * про версию некому, а у `mismatch` свой экран.
 */
export function missingMethods(status: HostStatus): string[] {
  if (status.state !== 'connected') return [];
  const known = hostMethods(status);
  return REQUIRED_METHODS.filter((method) => !known.has(method));
}

/**
 * Хост прежней сборки Parley (0.2.0): окно обновили, а хост работает от старого приложения. Протокол тот же,
 * но агенты и git, которые хост запускает, — от старой копии, и macOS считает копии разными приложениями
 * (подпись ad-hoc у каждой сборки своя): доступ к папкам спрашивается по кругу. Такой хост перезапускают.
 * Только хост СТАРШЕ окна: новее (открыта старая копия приложения) — не «устарел», и перезапуск откатил бы
 * его. `null` — та же или новее сборка, версия не `x.y.z`, версия окна ещё не пришла или связи нет.
 */
export function otherHostBuild(
  status: HostStatus,
  appVersion: string | null,
): { host: string; window: string } | null {
  if (status.state !== 'connected' || appVersion === null) return null;
  const host = semver(status.hostVersion);
  const window = semver(appVersion);
  if (host === null || window === null) return null;
  const at = host.findIndex((part, index) => part !== window[index]);
  if (at === -1 || host[at]! > window[at]!) return null;
  return { host: status.hostVersion, window: appVersion };
}

/** `x.y.z` (хвост `-…` не важен) → [x, y, z]; не такая версия — `null`. */
export function semver(version: string): [number, number, number] | null {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return found === null ? null : [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** Понимает ли хост метод — для пунктов меню и жестов, которые без него прячутся. */
export function useHostSupports(method: string): boolean {
  return useHostStore((state) => hostMethods(state.status).has(method));
}
