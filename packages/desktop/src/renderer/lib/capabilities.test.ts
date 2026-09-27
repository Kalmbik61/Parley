/**
 * Тесты 6, 7 и 11 куска 3.1: какие методы окно считает у хоста и чего ему не
 * хватает. Список недостающих выводится из `REQUIRED_METHODS` и
 * `BASELINE_METHODS`, а не зашит: 4.1, 5.1 и 8.1 пополняют список, этот тест
 * не трогают.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { METHODS, NOTIFICATIONS } from '@harnas/protocol';
import type { HostStatus } from '../../shared/bridge.js';
import { useHostStore } from '../store/host.js';
import {
  BASELINE_METHODS,
  REQUIRED_METHODS,
  hostMethods,
  missingMethods,
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

  it('новый хост, отдавший ключи METHODS и NOTIFICATIONS протокола, — недостающих нет', () => {
    const all = [...Object.keys(METHODS), ...Object.keys(NOTIFICATIONS)].sort();
    expect(missingMethods(connected(all))).toEqual([]);
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
