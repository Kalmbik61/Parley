// The launcher's Code Mode decision for one launch (plan T12a, §5, Delta 10). Pure order of gates, first refusal is the reason, cheapest first,
// so with no proven provider nothing costly runs. The decision is written for every launch, and only a replacement written as `true` gets a
// nonce into the MCP config: a fixture route can never reach a replacement server. Nothing here activates anything: `PROVEN_PROVIDERS` is
// empty until a provider's own T12b adds it.

import type { CodeModeRoutingReport } from './code-mode-instructions.js';
import { selectsClassic } from './code-mode-instructions.js';
import { selectExposure, type ExposureSelection } from '../mcp/code-mode/launch-decision.js';
import { MIGRATION_REGISTRY, type MigrationRegistry, writesExist } from '../mcp/code-mode/migration-registry.js';
import type { RecordView } from '../mcp/code-mode/run-record.js';
import { PROVEN_PROVIDERS } from '../mcp/code-mode/proven.js';

/** The one table (`mcp/code-mode/proven.ts`), shared with the session process. Empty: every launch is classic. */
export { PROVEN_PROVIDERS };

/** What the detector says, with three outcomes: a source that could not be inspected is never `clear`. */
export type DetectorVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'trigger' }
  | { readonly kind: 'uninspected'; readonly sourceClass: string };

/** The facts one launch has, each produced only when its gate is reached. */
export interface GateFacts {
  readonly provider: string;
  readonly confined: boolean;
  /** A session id and Parley's agent channel reach the MCP server of this launch. */
  readonly parleyLaunched: boolean;
  /** `{systemPrompt}` or `{developerInstructions}` in the launch template. */
  readonly deliverable: boolean;
  readonly proven: readonly string[];
  clientVersionReviewed(): Promise<boolean>;
  helperAvailable(): Promise<boolean>;
  /** `checkReplacement` of this launch's original list against the shipped registry. */
  registryOk(): Promise<boolean>;
  detector(): Promise<DetectorVerdict>;
  /** The role, playbook and skill verdicts against the shipped replacement routing. */
  routingReport(): Promise<CodeModeRoutingReport>;
}

/** The first gate that refuses, or null: in this order, and later gates are never asked once one refuses. */
export async function firstRefusal(f: GateFacts): Promise<string | null> {
  if (f.confined) return 'confined-attempt';
  if (!f.parleyLaunched) return 'not-parley-launched';
  if (!f.proven.includes(f.provider)) return 'provider-unproven';
  if (!(await f.clientVersionReviewed())) return 'client-version';
  if (!f.deliverable) return 'instructions-undeliverable';
  if (!(await f.helperAvailable())) return 'helper-unavailable';
  if (!(await f.registryOk())) return 'registry';
  const detected = await f.detector();
  if (detected.kind === 'trigger') return 'detector';
  if (detected.kind === 'uninspected') return `uninspected-source:${detected.sourceClass}`;
  const classic = selectsClassic(await f.routingReport());
  if (classic.classic) return classic.source;
  return null;
}

/**
 * The whole choice: the held record first (it wins over everything, a non-read one blocks), then the human's setting, then the gates. The gates
 * are not asked when the record or the setting already decide, so a held or turned-off session pays for nothing. `writesExist` comes from the
 * registry alone (sticky, m-7267/m-7366): false while every migratable method is a read. `registry` is for fixtures; the launcher passes none.
 */
export async function decideLaunchExposure(input: { readonly requested: boolean; readonly record: RecordView; readonly gates: GateFacts; readonly registry?: MigrationRegistry }): Promise<ExposureSelection> {
  const registry = input.registry ?? MIGRATION_REGISTRY;
  const held = { record: input.record, registry, writesExist: writesExist(registry) };
  const early = selectExposure({ requested: input.requested, refused: null, ...held });
  if (early.effective !== 'replacement') return early;
  return selectExposure({ requested: true, refused: await firstRefusal(input.gates), ...held });
}
