// Brand colours of the providers' avatars (pure; the drawing is `avatars.tsx`).
const BRAND: Record<string, { bg: string; fg: string; mark: string }> = {
  claude: { bg: '#D97757', fg: '#FFFFFF', mark: 'C' },
  codex: { bg: '#111111', fg: '#FFFFFF', mark: 'X' },
  glm: { bg: '#2563EB', fg: '#FFFFFF', mark: 'G' },
  deepseek: { bg: '#4D6BFE', fg: '#FFFFFF', mark: 'D' },
  kimi: { bg: '#1783FF', fg: '#FFFFFF', mark: 'K' },
  minimax: { bg: '#F23F5D', fg: '#FFFFFF', mark: 'M' },
  openrouter: { bg: '#6467F2', fg: '#FFFFFF', mark: 'O' },
  qwen: { bg: '#615CED', fg: '#FFFFFF', mark: 'Q' },
  opencode: { bg: '#0B0B0B', fg: '#FFFFFF', mark: 'O' },
};

/** Brand colours and initial of a provider id; unknown providers get a neutral avatar with their first letter. */
export function brandOf(provider: string): { bg: string | null; fg: string | null; mark: string } {
  const known = BRAND[provider.toLowerCase()];
  if (known !== undefined) return known;
  return { bg: null, fg: null, mark: (provider.trim().slice(0, 1) || '?').toUpperCase() };
}
