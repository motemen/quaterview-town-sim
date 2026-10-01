import { Rng } from "./rng";
import { START_MINUTES } from "./time";

export const MAP_W = 256;
export const MAP_H = 256;
export const MAX_HEIGHT = 3;

export const enum Kind {
  Grass = 0,
  Forest = 1,
  Water = 2,
  Road = 3,
  Rail = 4,
  Crossing = 5,
  Station = 6,
  Building = 7,
  Lot = 8,
  Park = 9,
  /** 田畑。bStyle & 3 が種類 (0=田 1=畑 2=花畑 3=果樹園)、bStyle & 4 が畝の向き */
  Farm = 10,
  /** 農道 (未舗装の道) */
  FarmPath = 11,
  /** 神社 */
  Shrine = 12,
}

export const enum BState {
  None = 0,
  Constructing = 1,
  Built = 2,
  Abandoned = 3,
}

export const MAX_LEVEL = 4;

/** 方向: 0=N(0,-1) 1=E(1,0) 2=S(0,1) 3=W(-1,0) */
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;
export const DIR_N = 1, DIR_E = 2, DIR_S = 4, DIR_W = 8;
export const DIR_BIT = [DIR_N, DIR_E, DIR_S, DIR_W] as const;

/** 8 方向 (線路用): 0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW */
export const DX8 = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const DY8 = [-1, -1, 0, 1, 1, 1, 0, -1] as const;
export const R8_N = 1, R8_NE = 2, R8_E = 4, R8_SE = 8, R8_S = 16, R8_SW = 32, R8_W = 64, R8_NW = 128;
export const R8_BIT = [R8_N, R8_NE, R8_E, R8_SE, R8_S, R8_SW, R8_W, R8_NW] as const;
/** 線路が東西方向の直線か */
export function railIsStraightX(mask: number): boolean {
  return mask === (R8_E | R8_W);
}
export function railIsStraightY(mask: number): boolean {
  return mask === (R8_N | R8_S);
}

export interface Station {
  x: number;
  y: number;
  /** 駅前広場の側 (方向インデックス) */
  plazaDir: number;
  name?: string;
}

export interface World {
  seed: number;
  w: number;
  h: number;
  /** 頂点の高さ (w+1)*(h+1) */
  height: Uint8Array;
  /** タイルが水面か */
  water: Uint8Array;
  /** タイルの傾斜 (Slope)。地形から導出、保存しない */
  slope: Uint8Array;
  /** 線路の 8 方向接続マスク (R8_*)。経路から導出、保存しない */
  railMask: Uint8Array;
  kind: Uint8Array;
  /** 地価 0..255 */
  value: Uint8Array;
  bLevel: Uint8Array;
  bStyle: Uint8Array;
  bState: Uint8Array;
  /** 建設進捗 0..255 */
  bProgress: Uint8Array;
  /** 建物の築年数 (日) */
  bAge: Uint16Array;
  /** 空き地・廃墟の経過日数 */
  lotTimer: Uint8Array;
  /** 夜の窓明かりパターン */
  lights: Uint8Array;
  stations: Station[];
  rng: Rng;
  /** ゲーム内経過分 */
  minutes: number;
  population: number;
  /** 直近に処理した時間 (時) */
  lastHour: number;
  /** ニュース等の通知 */
  events: string[];
  /** 駅が増えたことを描画側に知らせるフラグ */
  stationsChanged: boolean;
  /** 天候 (Weather) */
  weather: number;
  /** この冬に初雪を見たか */
  snowSeen: boolean;
  /** 人口の節目 (通知済みの最大値) */
  popMilestone: number;
  /** 通知済みの出来事フラグ (ビット) */
  flags: number;
  /** 支線 (branch.ts) */
  branches: import("./branch").Branch[];
  /** 地形が変わったことを描画側に知らせるフラグ */
  terrainChanged: boolean;
}

export function createEmptyWorld(seed: number, w = MAP_W, h = MAP_H): World {
  const n = w * h;
  return {
    seed,
    w,
    h,
    height: new Uint8Array((w + 1) * (h + 1)),
    water: new Uint8Array(n),
    slope: new Uint8Array(n),
    railMask: new Uint8Array(n),
    kind: new Uint8Array(n),
    value: new Uint8Array(n),
    bLevel: new Uint8Array(n),
    bStyle: new Uint8Array(n),
    bState: new Uint8Array(n),
    bProgress: new Uint8Array(n),
    bAge: new Uint16Array(n),
    lotTimer: new Uint8Array(n),
    lights: new Uint8Array(n),
    stations: [],
    rng: new Rng(seed),
    minutes: START_MINUTES,
    population: 0,
    lastHour: Math.floor(START_MINUTES / 60),
    events: [],
    stationsChanged: false,
    weather: 0,
    snowSeen: false,
    popMilestone: 0,
    flags: 0,
    branches: [],
    terrainChanged: false,
  };
}

export function idx(w: World, x: number, y: number): number {
  return y * w.w + x;
}

export function inBounds(w: World, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w.w && y < w.h;
}

export function vertexHeight(w: World, vx: number, vy: number): number {
  return w.height[vy * (w.w + 1) + vx];
}

/** タイル4隅の高さ: [T=(x,y), R=(x+1,y), B=(x+1,y+1), L=(x,y+1)] */
export function cornerHeights(w: World, x: number, y: number): [number, number, number, number] {
  const s = w.w + 1;
  const i = y * s + x;
  return [w.height[i], w.height[i + 1], w.height[i + s + 1], w.height[i + s]];
}

export const enum Slope {
  Flat = 0,
  /** x 方向 (東西) に傾く: 東西の道路・線路が通れる */
  AlongX = 1,
  /** y 方向 (南北) に傾く */
  AlongY = 2,
  Irregular = 3,
}

export function slopeOf(c: [number, number, number, number]): Slope {
  const [t, r, b, l] = c;
  if (t === r && r === b && b === l) return Slope.Flat;
  if (t === l && r === b) return Slope.AlongX;
  if (t === r && l === b) return Slope.AlongY;
  return Slope.Irregular;
}

/** 高さ配列から各タイルの傾斜を計算し直す */
export function updateSlopes(w: World): void {
  for (let y = 0; y < w.h; y++) {
    for (let x = 0; x < w.w; x++) {
      w.slope[y * w.w + x] = slopeOf(cornerHeights(w, x, y));
    }
  }
}

export function isFlat(w: World, x: number, y: number): boolean {
  return w.slope[y * w.w + x] === Slope.Flat;
}

/** 方向 dir (0..3) の道路・線路が通れる傾斜か */
export function passableAlong(w: World, x: number, y: number, dir: number): boolean {
  const s = w.slope[y * w.w + x] as Slope;
  if (s === Slope.Flat) return true;
  if (s === Slope.AlongX) return dir === 1 || dir === 3;
  if (s === Slope.AlongY) return dir === 0 || dir === 2;
  return false;
}

export function isRailLike(k: number): boolean {
  return k === Kind.Rail || k === Kind.Crossing || k === Kind.Station;
}

export function isRoadLike(k: number): boolean {
  return k === Kind.Road || k === Kind.Crossing;
}

/** 道路・線路の接続ビットマスク */
export function connections(w: World, x: number, y: number, pred: (k: number) => boolean): number {
  let m = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (!inBounds(w, nx, ny)) {
      // マップ端では線路は外へ続いているとみなす
      continue;
    }
    if (pred(w.kind[idx(w, nx, ny)])) m |= DIR_BIT[d];
  }
  return m;
}

/** 線路の接続 (8 方向マスク)。rail.ts の updateRailMask で計算したものを返す。 */
export function railConnections(w: World, x: number, y: number): number {
  return w.railMask[y * w.w + x];
}

export function roadConnections(w: World, x: number, y: number): number {
  return connections(w, x, y, isRoadLike);
}

export function isBuildableGround(k: number): boolean {
  return k === Kind.Grass || k === Kind.Forest || k === Kind.Lot || k === Kind.Farm || k === Kind.FarmPath;
}
