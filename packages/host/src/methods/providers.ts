import { commandInPath, loadProviders } from '@harnas/core';
import type { Handler } from '../context.js';

/** `available` — команда провайдера видна в PATH (или через `HARNAS_*_BIN`-оверрайд). */
export const providersList: Handler<'providers.list'> = async () => {
  const registry = await loadProviders();
  const providers = await Promise.all(
    Object.values(registry).map(async (entry) => ({
      id: entry.id,
      label: entry.label,
      available: await commandInPath(entry.runner.command),
    })),
  );
  return { providers };
};
