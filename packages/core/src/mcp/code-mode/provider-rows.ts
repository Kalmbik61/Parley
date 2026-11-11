// The detector's provider rows (plan T12a, §7): each provider's own in-scope source classes, added by that provider's row task
// (T12a-Claude, T12a-Codex, T12a-GLM, T12a-custom), never inherited. A provider with no row scans as `uninspected:no-provider-row`, so its live
// source is never clear, even if its id were in PROVEN_PROVIDERS.

import { clientClass } from './claude-client.js';
import { claudePluginsClass } from './claude-plugins.js';
import { claudeSettingsClass } from './claude-settings.js';
import type { SourceClass } from './detector.js';
import type { LaunchIdentities } from './launch-decision.js';

/** Where a row's sources anchor: the session's real cwd (its worktree), never the project root by assumption (Delta 5); and what the launch recorded. */
export interface RowContext {
  readonly cwd: string;
  readonly identities?: LaunchIdentities;
}

export type ProviderRow = (context: RowContext) => readonly SourceClass[];

/** A class whose reader is not built yet: always uninspected, so the row can never scan clear before it is (fail-closed). */
const pending = (name: string): SourceClass => Object.freeze({ name, check: () => Object.freeze({ kind: 'uninspected' as const, sourceClass: name }) });

/**
 * Claude (T12a-Claude). C1 brings the client process, C2a and C2b the settings files (deny and ask rules, hooks, the managed layer), C2c
 * the active plugins; the nested sources (C2d, lead m-7515 Q3) come next and stay uninspected until then, so every Claude launch stays
 * classic.
 */
const claudeRow: ProviderRow = (context) => [
  clientClass(context.identities?.client), claudeSettingsClass(context.identities), claudePluginsClass(context.identities), pending('nested-sources'),
];

export const PROVIDER_ROWS: Readonly<Record<string, ProviderRow>> = Object.freeze({ claude: claudeRow });

/** The row's classes for this provider, or null when the build has none. */
export function providerSourceClasses(provider: string, context: RowContext): readonly SourceClass[] | null {
  const row = Object.hasOwn(PROVIDER_ROWS, provider) ? PROVIDER_ROWS[provider] : undefined;
  return row === undefined ? null : row(context);
}
