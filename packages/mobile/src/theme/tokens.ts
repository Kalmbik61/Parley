// Design tokens from D1 §17 (docs/design/2026-10-31-mobile-mvp-screens.md). Colors are the light/dark values of the
// table; the system semantic colors (§17.1 "Source") match them, so screens may use either.
export interface Colors {
  bg: string;
  surface: string;
  surface2: string;
  label: string;
  label2: string;
  label3: string;
  separator: string;
  tint: string;
  onTint: string;
  needsYou: string;
  working: string;
  idle: string;
  off: string;
  success: string;
  danger: string;
  warningBg: string;
  neutralBg: string;
}

export const lightColors: Colors = {
  bg: '#F2F2F7',
  surface: '#FFFFFF',
  surface2: '#F2F2F7',
  label: '#000000',
  label2: 'rgba(60,60,67,0.6)',
  label3: 'rgba(60,60,67,0.3)',
  separator: 'rgba(60,60,67,0.29)',
  tint: '#A8531E',
  onTint: '#FFFFFF',
  needsYou: '#C93400',
  working: '#A8531E',
  idle: '#8E8E93',
  off: '#C7C7CC',
  success: '#248A3D',
  danger: '#D70015',
  warningBg: '#FFF4E5',
  neutralBg: '#E5E5EA',
};

export const darkColors: Colors = {
  bg: '#000000',
  surface: '#1C1C1E',
  surface2: '#2C2C2E',
  label: '#FFFFFF',
  label2: 'rgba(235,235,245,0.6)',
  label3: 'rgba(235,235,245,0.3)',
  separator: 'rgba(84,84,88,0.6)',
  tint: '#E08A52',
  onTint: '#000000',
  needsYou: '#FF9F0A',
  working: '#E08A52',
  idle: '#98989D',
  off: '#48484A',
  success: '#30D158',
  danger: '#FF453A',
  warningBg: '#3A2A12',
  neutralBg: '#2C2C2E',
};

/** D1 §17.3. Grid 4 pt. */
export const spacing = {
  unit: 4,
  screenMargin: 16,
  cardPaddingX: 16,
  cardPaddingY: 14,
  cardGap: 12,
  rowGap: 4,
  blockGap: 12,
  cardRadius: 16,
  nestedRadius: 10,
  decisionButtonHeight: 50,
  minTouchTarget: 44,
  statusDot: 10,
} as const;

/** Spring from D1 §17.3 (`damping 20, stiffness 220`). */
export const spring = { damping: 20, stiffness: 220 } as const;

/** Dynamic Type roles, D1 §17.2: iOS text styles at the default (Large) size; RN scales them with `allowFontScaling`. */
export const typography = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  button: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption1: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  caption2: { fontSize: 11, lineHeight: 13, fontWeight: '600' },
} as const;
