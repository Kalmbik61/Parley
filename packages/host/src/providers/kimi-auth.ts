import { homedir } from 'node:os';
import { findRunnerBinary } from '@parley/core';
import { kimiLoginEnv } from './kimi-env.js';
import { createKimiAcp } from '../kimi/acp.js';

const REFRESH_MS = 30_000;

/** Best-effort ACP authentication hint without creating a Kimi session or reading login files. */
export function createKimiAuth(onChange: () => void) {
  let status: boolean | null = null;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let stopped = false;
  let checking: Promise<void> | undefined;
  let probe: ReturnType<typeof createKimiAcp> | undefined;

  function observe(value: boolean | null): void {
    if (stopped) return;
    generation += 1;
    lastCheck = Date.now();
    if (value === status) return;
    status = value;
    onChange();
  }

  async function refresh(command: string, checkedGeneration: number): Promise<void> {
    try {
      const binary = await findRunnerBinary(command);
      if (stopped || checkedGeneration !== generation) return;
      probe = createKimiAcp({
        command: binary, args: ['acp'], cwd: homedir(),
        env: kimiLoginEnv(process.env), mcpServers: [],
      });
      const next = await probe.checkAuth();
      if (checkedGeneration === generation) observe(next);
    } catch {
      // The provider registry separately detects a missing CLI.
    } finally {
      await probe?.close();
      probe = undefined;
      checking = undefined;
    }
  }

  return {
    current: () => status,
    async refreshNow(command: string): Promise<boolean> {
      await checking;
      if (stopped) return false;
      observe(null);
      checking = refresh(command, generation);
      await checking;
      return status === true;
    },
    observe,
    refreshIfStale(command: string): void {
      if (stopped || checking !== undefined || Date.now() - lastCheck < REFRESH_MS) return;
      lastCheck = Date.now();
      checking = refresh(command, generation);
    },
    async stop(): Promise<void> {
      stopped = true;
      await probe?.close();
      await checking;
    },
  };
}

export type KimiAuth = ReturnType<typeof createKimiAuth>;
