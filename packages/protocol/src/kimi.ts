import { z } from 'zod';

const id = z.string().min(1).max(1024);
export const kimiConfigValue = z.union([id, z.boolean()]);
const configChoice = z.object({ value: id, name: z.string(), description: z.string().nullish() });
const configGroup = z.object({ group: id, name: z.string(), options: z.array(configChoice) });
const configBase = {
  id,
  name: z.string(),
  description: z.string().nullish(),
  category: z.string().nullish(),
};

export const kimiConfigOption = z.discriminatedUnion('type', [
  z.object({ ...configBase, type: z.literal('select'), currentValue: id, options: z.array(z.union([configChoice, configGroup])) }),
  z.object({ ...configBase, type: z.literal('boolean'), currentValue: z.boolean() }),
]);
export type KimiConfigOption = z.infer<typeof kimiConfigOption>;

export const kimiPermissionOption = z.object({
  optionId: id,
  name: z.string(),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

export const kimiElicitationSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
  required: z.array(z.string()).nullish(),
});

/** ACP tool-call preview, limited to the display formats Parley can render. */
export type KimiPermissionContent =
  | { type: 'content'; content: { type: 'text'; text: string }; truncated?: true }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string; truncated?: true };

export type KimiRequest =
  | {
      kind: 'permission';
      id: string;
      toolCallId: string;
      title: string;
      options: z.infer<typeof kimiPermissionOption>[];
      content: KimiPermissionContent[];
      contentTruncated?: true;
    }
  | { kind: 'elicitation'; id: string; toolCallId?: string; message: string; requestedSchema: z.infer<typeof kimiElicitationSchema> };

const formContent = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
export const kimiResponse = z.union([
  z.object({ kind: z.literal('permission'), optionId: id.nullable() }),
  z.object({ kind: z.literal('elicitation'), action: z.literal('accept'), content: formContent }),
  z.object({ kind: z.literal('elicitation'), action: z.enum(['decline', 'cancel']) }),
]);
export type KimiResponse = z.infer<typeof kimiResponse>;

export interface KimiState {
  requests: KimiRequest[];
  config: KimiConfigOption[];
}

export interface KimiMethodResults {
  'kimi.getState': KimiState;
  'kimi.setConfig': { config: KimiConfigOption[] };
}
