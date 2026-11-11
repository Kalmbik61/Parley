// Providers whose live gates passed (T9b) and that a T12b activated, each by its own commit (plan T12a, §6.2). Empty: every launch is
// classic, the launcher stops at `provider-unproven`, and a session process gets no live native policy, so no broker and zero dispatch.
// One table for both readers, the launcher (`work/launch-exposure.ts`) and the session process (`native-policy.ts`). It imports nothing.

export const PROVEN_PROVIDERS: readonly string[] = Object.freeze([]);
