/**
 * Тесты 6, 7 и 11 куска 3.1: какие методы окно считает у хоста и чего ему не
 * хватает. Список недостающих выводится из `REQUIRED_METHODS` и
 * `BASELINE_METHODS`, а не зашит: 4.1, 5.1 и 8.1 пополняют список, этот тест
 * не трогают.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { METHODS, NOTIFICATIONS } from '@parley/protocol';
import type { HostStatus } from '../../shared/bridge.js';
import { useHostStore } from '../store/host.js';
import {
  BASELINE_METHODS,
  REQUIRED_METHODS,
  hostMethods,
  missingMethods,
  otherHostBuild,
  useHostSupports,
} from './capabilities.js';

const connected = (methods: string[] | null): HostStatus => ({
  state: 'connected',
  hostVersion: '1.0.0',
  methods,
});

afterEach(() => {
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('capabilities', () => {
  it('методы ключа нужны новому окну: старому хосту предлагается перезапуск', () => {
    expect(REQUIRED_METHODS).toEqual(expect.arrayContaining(['providers.setKey', 'providers.clearKey']));
    expect(missingMethods(connected(null))).toEqual(expect.arrayContaining(['providers.setKey', 'providers.clearKey']));
  });
  it('хост до этапа 3 (methods: null): умеет ровно BASELINE_METHODS, не хватает новых', () => {
    expect([...hostMethods(connected(null))].sort()).toEqual([...BASELINE_METHODS].sort());
    expect(missingMethods(connected(null))).toEqual(
      REQUIRED_METHODS.filter((method) => !BASELINE_METHODS.includes(method)),
    );
    expect(missingMethods(connected(null))).toContain('works.rename');
  });

  it('окну этапа 4 нужны activity.seen и mail.markRead (кусок 4.1)', () => {
    expect(REQUIRED_METHODS).toContain('activity.seen');
    expect(REQUIRED_METHODS).toContain('mail.markRead');
    expect(missingMethods(connected(null))).toEqual(
      expect.arrayContaining(['activity.seen', 'mail.markRead']),
    );
  });

  it('окну этапа 5 нужен pty.send (кусок 5.1)', () => {
    expect(REQUIRED_METHODS).toContain('pty.send');
    expect(missingMethods(connected(null))).toContain('pty.send');
  });

  it('окну этапа 8 нужны worktrees.mergeCheck, changes.project и changes.commitProject (кусок 8.1)', () => {
    const review = ['worktrees.mergeCheck', 'changes.project', 'changes.commitProject'];
    expect(REQUIRED_METHODS).toEqual(expect.arrayContaining(review));
    expect(missingMethods(connected(null))).toEqual(expect.arrayContaining(review));
  });

  it('новый хост, отдавший ключи METHODS и NOTIFICATIONS протокола, — недостающих нет', () => {
    const all = [...Object.keys(METHODS), ...Object.keys(NOTIFICATIONS)].sort();
    expect(missingMethods(connected(all))).toEqual([]);
  });

  it('окну комнат Organic нужны rooms.addMember и rooms.resolveProposal: хосту без них не хватает ровно их', () => {
    const rooms = ['rooms.addMember', 'rooms.resolveProposal'];
    expect(REQUIRED_METHODS).toEqual(expect.arrayContaining(rooms));
    // Хост, что умеет всё окно, кроме этих двух, — старее окна: строка статуса предложит перезапуск.
    const older = connected(REQUIRED_METHODS.filter((method) => !rooms.includes(method)));
    expect(missingMethods(older)).toEqual(rooms);
    for (const method of rooms) expect(missingMethods(connected(REQUIRED_METHODS.filter((known) => known !== method)))).toEqual([method]);
    expect(missingMethods(connected([...REQUIRED_METHODS]))).toEqual([]);
  });

  it('методы комнат дизайна Organic: у хоста без них окно их не видит и прячет функции, у нового — видит', () => {
    const rooms = ['rooms.addMember', 'rooms.resolveProposal'];
    // Хост до этого дизайна: то, что было в протоколе, но без вступления в комнату и решений.
    const older = connected([...BASELINE_METHODS, 'works.rename', 'mail.markRead']);
    for (const method of rooms) expect(hostMethods(older).has(method)).toBe(false);
    expect(hostMethods(connected(null)).has('rooms.addMember')).toBe(false);

    useHostStore.setState({ status: older });
    const { result } = renderHook(() => rooms.map((method) => useHostSupports(method)));
    expect(result.current).toEqual([false, false]);

    const all = [...Object.keys(METHODS), ...Object.keys(NOTIFICATIONS)];
    for (const method of rooms) expect(hostMethods(connected(all)).has(method)).toBe(true);
  });

  it.each<HostStatus>([
    { state: 'connecting' },
    { state: 'mismatch', hostVersion: '9.9.9', liveSessions: 1 },
    { state: 'disconnected', reason: 'closed' },
  ])('без связи ($state): методов нет, недостающих нет, useHostSupports — false', (status) => {
    expect(hostMethods(status).size).toBe(0);
    expect(missingMethods(status)).toEqual([]);
    useHostStore.setState({ status });
    const { result } = renderHook(() => useHostSupports('works.rename'));
    expect(result.current).toBe(false);
  });
});

describe('otherHostBuild — хост от другой сборки окна (0.2.0)', () => {
  it('версии разные — пара версий; одинаковые — null', () => {
    expect(otherHostBuild(connected(null), '1.1.0')).toEqual({ host: '1.0.0', window: '1.1.0' });
    expect(otherHostBuild(connected(null), '1.0.0')).toBeNull();
  });

  it('хост новее окна (открыта старая копия приложения) или версия не x.y.z — не «устарел» (ревью 0.2.0, п. 13)', () => {
    expect(otherHostBuild(connected(null), '0.9.0')).toBeNull();
    expect(
      otherHostBuild({ state: 'connected', hostVersion: 'unknown', methods: null }, '1.1.0'),
    ).toBeNull();
    expect(otherHostBuild(connected(null), 'dev')).toBeNull();
    expect(
      otherHostBuild({ state: 'connected', hostVersion: '0.10.0', methods: null }, '0.9.1'),
    ).toBeNull();
    expect(
      otherHostBuild({ state: 'connected', hostVersion: '0.9.1', methods: null }, '0.10.0'),
    ).toEqual({
      host: '0.9.1',
      window: '0.10.0',
    });
  });

  it('версия окна ещё не пришла или связи нет — не судим', () => {
    expect(otherHostBuild(connected(null), null)).toBeNull();
    expect(otherHostBuild({ state: 'connecting' }, '1.1.0')).toBeNull();
    expect(
      otherHostBuild({ state: 'mismatch', hostVersion: '0.9.0', liveSessions: 0 }, '1.1.0'),
    ).toBeNull();
  });
});
