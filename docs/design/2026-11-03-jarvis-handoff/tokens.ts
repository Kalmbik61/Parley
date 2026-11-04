// «Джарвис» · дизайн-токены (шаг 1). Выбрана палитра A (тёплая) — используйте `palette`.
export const paletteA = {
  "bg": "#100E0C",
  "bg2": "#1A1713",
  "field": "#1A1713",
  "surface": "#211D1A",
  "raised": "#2E2924",
  "bubble": "#2E2924",
  "border": "#39342F",
  "outline": "#39342F",
  "text": "#F3EEE6",
  "text2": "#C2BDB5",
  "text3": "#918B84",
  "accent": "#EFB05C",
  "onAccent": "#2B1C08",
  "success": "#7ECB9F",
  "error": "#E57159"
} as const;

export const paletteB = {
  "bg": "#17191C",
  "bg2": "#2B2F34",
  "field": "#2B2F34",
  "surface": "#222529",
  "raised": "#2B2F34",
  "bubble": "#2B2F34",
  "border": "#373B40",
  "outline": "#72787F",
  "text": "#F3F1EC",
  "text2": "#A4A8AD",
  "text3": "#A4A8AD",
  "accent": "#EAC084",
  "onAccent": "#241C13",
  "success": "#9AC5AD",
  "error": "#E98572"
} as const;

export type Palette = typeof paletteA;

// Выбранная палитра интерфейса. paletteB — только для справки.
export const palette: Palette = paletteA;

// Сфера не зависит от палитры интерфейса
export const orbPalettes = {
  "amber": {
    "c1": "#EFB05C",
    "c2": "#F48A64",
    "c3": "#F0DDA5",
    "c1w": "#F3C180",
    "edge": "#975C00"
  },
  "warm": {
    "c1": "#EFB05C",
    "c2": "#F7A062",
    "c3": "#F0DDA5",
    "c1w": "#F3C180",
    "edge": "#975C00"
  },
  "coral": {
    "c1": "#DC604C",
    "c2": "#C43F40",
    "c3": "#F8B287",
    "c1w": "#E48373",
    "edge": "#7A2E24"
  },
  "gray": {
    "c1": "#9C948A",
    "c2": "#6F665F",
    "c3": "#C3BCB1",
    "c1w": "#B2ABA4",
    "edge": "#4A4540"
  }
} as const;

export const type = {
  "display": [ 32, 38 ],
  "title": [ 22, 28 ],
  "subtitle": [ 17, 22 ],
  "body": [ 16, 24 ],
  "caption": [ 13, 18 ],
  "min": [ 12, 16 ]
} as const; // [fontSize, lineHeight], Golos Text
export const space = [4, 8, 16, 24, 40] as const;
export const radius = {
  "control": 10,
  "card": 16,
  "bubble": 22,
  "input": 22,
  "sheet": 22,
  "pill": 999
} as const;
export const touchTarget = 44;
