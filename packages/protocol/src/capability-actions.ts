import { z } from 'zod';
import { capabilityProvider, capabilityActionReason } from './capability-snapshot.js';

const boundedText = z.string().max(8192).refine(value => !value.includes('\0'), 'NUL is not permitted');
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256);
const env = z.record(envName, boundedText).refine(value => Object.keys(value).length <= 128, 'Too many environment variables');
const command = boundedText.refine(value => value.trim().length > 0, 'Command is required');
const args = z.array(boundedText).max(512);
const url = boundedText.refine(value => {
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !/[\r\n]/.test(value); }
  catch { return false; }
}, 'HTTP URL is required');
const headers = z.record(z.string().max(256).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  boundedText.refine(value => !/[\r\n]/.test(value), 'Header line breaks are not permitted'))
  .refine(value => Object.keys(value).length <= 128, 'Too many headers');

/** Explicit write fields only; an arbitrary config object is never accepted or returned. */
export const capabilityMcpInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdio'), command, args: args.optional(), env: env.optional() }).strict(),
  z.object({ kind: z.literal('http'), url, headers: headers.optional(), bearerTokenEnvVar: envName.optional() }).strict(),
  z.object({ kind: z.literal('json'), server: z.union([
    z.object({ type: z.literal('stdio').optional(), command, args: args.optional(), env: env.optional() }).strict(),
    z.object({ type: z.literal('http'), url, headers: headers.optional(), bearer_token_env_var: envName.optional() }).strict(),
  ]) }).strict(),
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536, 'MCP input is too large');

export const capabilityMcpWriteScope = z.enum(['user', 'project', 'local']);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectPath = z.string().min(1).max(8192).refine(value => !value.includes('\0'), 'Invalid project path');
export const capabilityMcpAdd = z.object({
  projectPath, provider: capabilityProvider, revision, scope: capabilityMcpWriteScope,
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), input: capabilityMcpInput,
}).strict().superRefine((request, context) => {
  if (request.provider === 'codex' && request.scope !== 'user')
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Codex mutations require user scope' });
  const server = request.input.kind === 'json' ? request.input.server : request.input;
  if ('url' in server) {
    if (request.provider === 'codex' && 'headers' in server)
      context.addIssue({ code: 'custom', path: ['input'], message: 'Codex HTTP headers are unsupported' });
    if (request.provider === 'claude' && ('bearerTokenEnvVar' in server || 'bearer_token_env_var' in server))
      context.addIssue({ code: 'custom', path: ['input'], message: 'Claude bearer environment flag is unsupported' });
  }
});

/** The host resolves this id through its private registry, never through a display name. */
export const capabilityMcpTarget = z.object({
  projectPath, provider: capabilityProvider, presenceId: z.string().min(1).max(4096), revision,
}).strict();

/** No output, request echo, arbitrary error text or native selector can cross the response boundary. */
export const capabilityActionResult = z.object({
  outcome: z.enum(['ok', 'denied', 'failed', 'unavailable', 'cancelled']),
  code: z.enum(['ok', ...capabilityActionReason.options, 'invalid-input', 'conflict', 'timeout', 'output-limit',
    'cli-error', 'invalid-output', 'context-changed', 'shutdown']),
  exitCode: z.number().int().min(0).max(255).optional(),
  status: z.enum(['ok', 'off', 'needs-auth', 'pending-approval', 'failed', 'unknown']).optional(),
  recovery: z.enum(['native-mcp']).nullable().optional(),
}).strict();

export type CapabilityMcpInput = z.infer<typeof capabilityMcpInput>;
export type CapabilityMcpAdd = z.infer<typeof capabilityMcpAdd>;
export type CapabilityMcpTarget = z.infer<typeof capabilityMcpTarget>;
export type CapabilityActionResult = z.infer<typeof capabilityActionResult>;
