// SAS presentation (D1 §6.5): six digits in two groups of three, read digit by digit by VoiceOver.
export const groupSas = (code: string): string => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

export const sasLabel = (code: string): string =>
  code.length === 6 ? [...code.slice(0, 3)].join(' ') + ', ' + [...code.slice(3)].join(' ') : [...code].join(' ');

/** Seconds left of the Mac's decision window as `m:ss`; never negative. */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The last 10 seconds are shown in orange. */
export const isLastSeconds = (expiresAt: number, now: number): boolean => expiresAt - now <= 10_000;
