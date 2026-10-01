import type { RGB } from "./raster";

export const PAL = {
  grass: [104, 172, 84] as RGB,
  grassDark: [84, 148, 68] as RGB,
  grassLight: [132, 196, 100] as RGB,
  dirt: [168, 140, 96] as RGB,
  dirtDark: [140, 112, 72] as RGB,
  water: [60, 120, 204] as RGB,
  waterLight: [112, 168, 236] as RGB,
  waterDark: [44, 96, 176] as RGB,
  sand: [212, 196, 148] as RGB,
  road: [116, 116, 124] as RGB,
  roadDark: [96, 96, 104] as RGB,
  sidewalk: [176, 176, 168] as RGB,
  sidewalkDark: [144, 144, 136] as RGB,
  ballast: [140, 124, 108] as RGB,
  sleeper: [112, 80, 48] as RGB,
  rail: [184, 184, 192] as RGB,
  railDark: [120, 120, 128] as RGB,
  concrete: [204, 204, 196] as RGB,
  concreteDark: [168, 168, 160] as RGB,
  platform: [216, 212, 200] as RGB,
  roofStation: [96, 112, 144] as RGB,
  trunk: [104, 72, 40] as RGB,
  canopy: [48, 120, 56] as RGB,
  canopyLight: [80, 156, 76] as RGB,
  canopyDark: [32, 92, 44] as RGB,
  windowDay: [72, 92, 128] as RGB,
  windowLit: [255, 228, 140] as RGB,
  windowLitWarm: [255, 196, 96] as RGB,
  windowLitCool: [200, 232, 255] as RGB,
  scaffold: [160, 160, 152] as RGB,
  crane: [232, 176, 48] as RGB,
  craneDark: [184, 128, 24] as RGB,
  redLight: [255, 64, 48] as RGB,
  earth: [120, 92, 64] as RGB,
  earthDark: [88, 64, 44] as RGB,
  lamp: [255, 240, 180] as RGB,
};

/** 建物の壁色 (スタイルで選ぶ) */
export const WALLS: RGB[] = [
  [228, 208, 172],
  [212, 184, 160],
  [168, 184, 200],
  [236, 236, 228],
  [188, 144, 124],
  [204, 196, 176],
  [176, 196, 184],
  [220, 200, 200],
  [160, 168, 184],
  [232, 220, 196],
];

/** 高層ビルの壁色 */
export const TOWER_WALLS: RGB[] = [
  [168, 184, 204],
  [196, 200, 208],
  [140, 160, 184],
  [204, 196, 184],
  [120, 136, 160],
  [184, 176, 168],
];

export const ROOFS: RGB[] = [
  [176, 72, 64],
  [72, 104, 168],
  [104, 104, 112],
  [64, 128, 96],
  [168, 112, 64],
  [120, 80, 120],
];

export const SIGNS: RGB[] = [
  [232, 72, 64],
  [64, 128, 224],
  [240, 192, 48],
  [72, 176, 112],
  [232, 120, 176],
];
