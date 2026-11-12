import type { ProviderEntry } from '../src/providers.js';
import type { WorkProvider } from '../src/work/types.js';

/** Synthetic qwen-family entry for family tests; the real registry entry arrives with A5. */
export const QWEN_FAMILY_ENTRY: ProviderEntry = {
  id: 'qwen' as WorkProvider,
  family: 'qwen',
  label: 'Qwen',
  mark: 'Qw',
  hasHistory: false,
  linkBy: 'cwd+time',
  runner: { command: 'qwen', args: ['{prompt}'] },
};

/** Synthetic opencode-family entry for family tests; the real registry entry arrives with the launch tasks (spec 2026-11-12). */
export const OPENCODE_FAMILY_ENTRY: ProviderEntry = {
  id: 'opencode' as WorkProvider,
  family: 'opencode',
  label: 'OpenCode',
  mark: 'Oc',
  hasHistory: false,
  linkBy: 'cwd+time',
  runner: { command: 'opencode', args: ['{prompt}'] },
};

/** Entry whose family is not one the registry knows. */
export const UNKNOWN_FAMILY_ENTRY = {
  id: 'mystery' as WorkProvider,
  family: 'mystery',
  label: 'Mystery',
  mark: 'My',
  hasHistory: false,
  linkBy: 'cwd+time',
  runner: { command: 'mystery', args: ['{prompt}'] },
} as unknown as ProviderEntry;
