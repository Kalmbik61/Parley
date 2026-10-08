import { z } from 'zod';
import { capabilityProvider } from './capability-snapshot.js';
const scalar = (value: string): boolean => !value.includes('\0') && new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) === value;
const text = z.string().min(1).max(8192).refine(scalar);
/** Authenticated manual host surface; native paths/permissions come from the private current presence binding. */
export const capabilitySkillTarget = z.object({ projectPath: text, provider: capabilityProvider,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), presenceId: text,
}).strict();
export const capabilitySkillResult = z.object({ outcome: z.enum(['ok', 'denied', 'failed']),
  code: z.enum(['ok', 'unverified', 'unsupported-scope', 'builtin', 'ambiguous', 'occupied', 'context-changed', 'receipt-unverified', 'symlink-error', 'io-error', 'stale', 'shutdown']),
  scope: z.enum(['user', 'project']).optional(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'ok') !== (value.code === 'ok') || value.outcome === 'ok' && value.scope === undefined)
    context.addIssue({ code: 'custom', message: 'Success requires known scope and success code' });
});
export type CapabilitySkillTarget = z.infer<typeof capabilitySkillTarget>;
export type CapabilitySkillResult = z.infer<typeof capabilitySkillResult>;

export const capabilitySkillMethodSchemas = { 'capabilities.skills.share': capabilitySkillTarget, 'capabilities.skills.unshare': capabilitySkillTarget } as const;
export interface CapabilitySkillMethodResults { 'capabilities.skills.share': CapabilitySkillResult; 'capabilities.skills.unshare': CapabilitySkillResult }
