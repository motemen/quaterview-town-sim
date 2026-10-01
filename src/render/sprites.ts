import { hash2, hash3 } from "../sim/rng";
import { buildingFloors, isMixedUse } from "../sim/growth";
import { DIR_E, DIR_N, DIR_S, DIR_W, BState } from "../sim/world";
import { HALF_H, HALF_W, TILE_H, TILE_W, diamondRows, pixelToUV, uvToPixel } from "./iso";
import { PAL, ROOFS, SIGNS, TOWER_WALLS, WALLS } from "./palette";
import { RGB, Raster, Sprite, SpriteCache, mix, shade, toSprite } from "./raster";

const cache = new SpriteCache<Sprite>(6000);
const pairCache = new SpriteCache<{ base: Sprite; emissive: Sprite | null }>(6000);

export function clearSpriteCache(): void {
  cache.clear();
  pairCache.clear();
}

export type GroundKind = "grass" | "lot" | "park" | "concrete" | "water" | "sand" | "rubble" | "paddy" | "field";

/** ダイヤ内の全ピクセルを (x, y, u, v) で巡る */
function forEachDiamondPixel(fn: (x: number, y: number, u: number, v: number) => void): void {
  for (let x = 0; x < TILE_W; x++) {
    const [yt, yb] = diamondRows(x);
    for (let y = yt; y <= yb; y++) {
      const [u, v] = pixelToUV(x + 0.5, y + 0.5);
      fn(x, y, u, v);
    }
  }
}

/** (u,v) 空間の線分をピクセルに落とす */
function lineUV(r: Raster, u0: number, v0: number, u1: number, v1: number, c: RGB, dy = 0): void {
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [px, py] = uvToPixel(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
    r.set(Math.floor(px), Math.floor(py) + dy, c);
  }
}

// ---------------------------------------------------------------------------
// 地面

const GROUND_COLORS: Record<GroundKind, [RGB, RGB, RGB]> = {
  grass: [PAL.grass, PAL.grassDark, PAL.grassLight],
  lot: [PAL.dirt, PAL.dirtDark, shade(PAL.dirt, 1.1)],
  park: [shade(PAL.grass, 1.08), PAL.grassDark, PAL.grassLight],
  concrete: [PAL.concrete, PAL.concreteDark, shade(PAL.concrete, 1.05)],
  water: [PAL.water, PAL.waterDark, PAL.waterLight],
  sand: [PAL.sand, shade(PAL.sand, 0.9), shade(PAL.sand, 1.08)],
  rubble: [PAL.dirtDark, shade(PAL.dirtDark, 0.8), PAL.concreteDark],
  paddy: [[96, 156, 80], [72, 128, 64], [120, 176, 96]],
  field: [[164, 128, 88], [136, 104, 68], [92, 152, 72]],
};

/** 田畑の [地, 畝の影, 作物] の色 */
function farmColors(kind: "paddy" | "field", season: SeasonTint): [RGB, RGB, RGB] {
  if (kind === "paddy") {
    if (season === 0) return [[126, 164, 172], [104, 140, 152], [112, 176, 96]]; // 水を張った田
    if (season === 1) return [[84, 156, 72], [64, 128, 56], [112, 184, 88]];
    if (season === 2) return [[212, 180, 80], [176, 144, 56], [232, 204, 104]]; // 稲穂
    return [[204, 196, 180], [172, 160, 140], [236, 232, 224]]; // 刈り取り後・雪
  }
  if (season === 0) return [[164, 128, 88], [136, 104, 68], [104, 168, 80]];
  if (season === 1) return [[156, 120, 80], [128, 96, 60], [72, 140, 64]];
  if (season === 2) return [[160, 124, 84], [132, 100, 64], [184, 136, 72]];
  return [[212, 208, 200], [180, 172, 160], [236, 234, 230]];
}

/**
 * 地面タイル。rel は 4 隅の相対高さ [T,R,B,L] (0 or 1)。
 * スプライトは 32x24 で、タイル原点の 8px 上から始まる (oy = 8)。
 */
export type SeasonTint = 0 | 1 | 2 | 3; // 0=春/夏 1=夏 2=秋 3=冬

function seasonalGround(kind: GroundKind, season: SeasonTint): [RGB, RGB, RGB] {
  const base = GROUND_COLORS[kind];
  if (kind === "water" || kind === "concrete" || kind === "rubble") return base;
  if (season === 3) {
    // 雪
    if (kind === "lot") return [[220, 216, 212], [196, 190, 184], [236, 234, 230]];
    return [[226, 232, 238], [204, 212, 222], [242, 246, 250]];
  }
  if (season === 2 && (kind === "grass" || kind === "park")) {
    return [mix(base[0], [170, 150, 70], 0.45), mix(base[1], [140, 120, 60], 0.45), mix(base[2], [200, 180, 90], 0.45)];
  }
  if (season === 1 && (kind === "grass" || kind === "park")) {
    return [shade(base[0], 0.92), shade(base[1], 0.9), shade(base[2], 0.95)];
  }
  return base;
}

export function groundSprite(kind: GroundKind, rel: readonly [number, number, number, number], variant: number, season: SeasonTint = 0): Sprite {
  const key = `g:${kind}:${rel.join("")}:${variant}:${season}`;
  return cache.get(key, () => {
    const r = new Raster(TILE_W, TILE_H + 8);
    const [rT, rR, rB, rL] = rel;
    const Ty = 8 - rT * 8;
    const Ry = 16 - rR * 8;
    const By = 24 - rB * 8;
    const Ly = 16 - rL * 8;
    const dzdx = (rR + rB - rT - rL) / 2;
    const dzdy = (rB + rL - rT - rR) / 2;
    const bright = kind === "water" ? 1 : 1 + 0.22 * dzdx + 0.12 * dzdy;
    const [base, dark, light] = seasonalGround(kind, season).map((c) => shade(c, bright)) as [RGB, RGB, RGB];
    const farm = kind === "paddy" || kind === "field" ? farmColors(kind, season) : null;
    const farmAlongX = (variant & 2) !== 0;
    for (let x = 0; x < TILE_W; x++) {
      const xc = x + 0.5;
      let top: number;
      let bottom: number;
      if (x < HALF_W) {
        const t = xc / HALF_W;
        top = Ly + (Ty - Ly) * t;
        bottom = Ly + (By - Ly) * t;
      } else {
        const t = (xc - HALF_W) / HALF_W;
        top = Ty + (Ry - Ty) * t;
        bottom = By + (Ry - By) * t;
      }
      const y0 = Math.floor(top);
      const y1 = Math.ceil(bottom) - 1;
      for (let y = y0; y <= y1; y++) {
        const n = hash3(variant * 7 + 1, x, y, kind.length);
        let c = base;
        if (kind === "water") {
          if (n < 0.06) c = light;
          else if (n < 0.1) c = dark;
        } else if (kind === "concrete") {
          if (n < 0.04) c = dark;
          // 縁石
          if (y === y0 || y === y1) c = dark;
        } else if (kind === "rubble") {
          if (n < 0.2) c = light;
          else if (n < 0.3) c = dark;
        } else if (farm) {
          // 畝 (うね) の縞と、縁の畦 (あぜ)
          const [u, v] = pixelToUV(x + 0.5, y - 8 + 0.5);
          const along = farmAlongX ? v : u;
          const phase = (along * 7) % 1;
          if (u < 0.08 || v < 0.08 || u > 0.97 || v > 0.97) c = shade(PAL.dirtDark, 0.95);
          else if (phase < 0.45) c = farm[2];
          else if (phase < 0.6) c = farm[1];
          else c = farm[0];
          if (season === 3 && kind === "field" && n < 0.5) c = farm[2];
        } else {
          if (n < 0.09) c = dark;
          else if (n < 0.15) c = light;
        }
        r.set(x, y, c);
      }
    }
    if (kind === "park" && season !== 3) {
      // 小道
      lineUV(r, 0.5, 0.0, 0.5, 1.0, shade(PAL.sand, 0.95), 8);
      lineUV(r, 0.0, 0.5, 1.0, 0.5, shade(PAL.sand, 0.95), 8);
    }
    return toSprite(r, 0, 8);
  });
}

// ---------------------------------------------------------------------------
// 木

/** 木。基部中央を原点にする (ox=4, oy=11)。 */
export function treeSprite(variant: number, tint = 0): Sprite {
  const key = `t:${variant}:${tint}`;
  return cache.get(key, () => {
    const r = new Raster(9, 12);
    const big = variant % 3 === 0;
    const canopy = tint === 1 ? ([240, 184, 200] as RGB) : tint === 2 ? ([208, 128, 56] as RGB) : tint === 3 ? ([236, 240, 246] as RGB) : PAL.canopy;
    const canopyLight = tint === 0 ? PAL.canopyLight : tint === 3 ? ([252, 252, 255] as RGB) : shade(canopy, 1.12);
    const canopyDark = tint === 0 ? PAL.canopyDark : tint === 3 ? ([120, 140, 120] as RGB) : shade(canopy, 0.78);
    r.vline(4, 8, 11, PAL.trunk);
    const rad = big ? 3.6 : 3;
    const cy = big ? 5 : 6;
    r.disc(4.5, cy, rad, canopy);
    r.disc(3.5, cy - 1, rad * 0.6, canopyLight);
    // 下側の影
    for (let x = 0; x < 9; x++) {
      for (let y = 0; y < 12; y++) {
        if (r.alpha(x, y) && y > cy + 1 && hash2(variant, x, y) < 0.6) r.set(x, y, canopyDark);
      }
    }
    return toSprite(r, 4, 11);
  });
}

/** 木に巻いたイルミネーション (発光のみ)。treeSprite と同じ基準点。 */
export function treeLightsSprite(variant: number): Sprite {
  return cache.get(`tl:${variant}`, () => {
    const r = new Raster(9, 12);
    const colors: RGB[] = [
      [255, 220, 120],
      [120, 220, 255],
      [255, 140, 200],
      [160, 255, 160],
    ];
    const big = variant % 3 === 0;
    const cy = big ? 5 : 6;
    for (let k = 0; k < 7; k++) {
      const a = hash2(variant, k, 1) * 6.28;
      const rad = (big ? 3 : 2.4) * (0.5 + hash2(variant, k, 2) * 0.5);
      const x = Math.round(4 + Math.cos(a) * rad);
      const y = Math.round(cy + Math.sin(a) * rad);
      r.set(x, y, colors[k % colors.length]);
    }
    return toSprite(r, 4, 11);
  });
}

// ---------------------------------------------------------------------------
// 道路・線路

const ROAD_HW = 0.24;
const WALK_HW = 0.33;

function inBand(u: number, v: number, hw: number, mask: number): boolean {
  const cx = Math.abs(u - 0.5) <= hw;
  const cy = Math.abs(v - 0.5) <= hw;
  if (cx && cy) return true;
  if (cy && ((u < 0.5 && mask & DIR_W) || (u >= 0.5 && mask & DIR_E))) return true;
  if (cx && ((v < 0.5 && mask & DIR_N) || (v >= 0.5 && mask & DIR_S))) return true;
  return false;
}

function grassPixel(x: number, y: number, season: SeasonTint): RGB {
  const [base, dark, light] = seasonalGround("grass", season);
  const n = hash2(99, x, y);
  return n < 0.09 ? dark : n < 0.15 ? light : base;
}

function paintRoad(r: Raster, mask: number, bridge: boolean, dy = 0, season: SeasonTint = 0): void {
  forEachDiamondPixel((x, y, u, v) => {
    const road = inBand(u, v, ROAD_HW, mask);
    const walk = !road && inBand(u, v, WALK_HW, mask);
    if (road) {
      const n = hash2(mask, x, y);
      r.set(x, y + dy, n < 0.05 ? PAL.roadDark : PAL.road);
    } else if (walk) {
      r.set(x, y + dy, bridge ? PAL.railDark : season === 3 ? ([214, 218, 224] as RGB) : PAL.sidewalk);
    } else if (!bridge) {
      // 周囲は草
      r.set(x, y + dy, grassPixel(x, y, season));
    }
  });
}

export function roadSprite(mask: number, bridge: boolean, season: SeasonTint = 0): Sprite {
  return cache.get(`r:${mask}:${bridge ? 1 : 0}:${season}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRoad(r, mask, bridge, 0, season);
    return toSprite(r, 0, 0);
  });
}

/** 街灯の明かり (夜用) */
export function roadEmissive(mask: number): Sprite | null {
  const straight = mask === (DIR_E | DIR_W) || mask === (DIR_N | DIR_S);
  if (!straight) return null;
  return cache.get(`re:${mask}`, () => {
    const r = new Raster(TILE_W, TILE_H + 8);
    const alongX = mask === (DIR_E | DIR_W);
    const [px, py] = alongX ? uvToPixel(0.5, 0.5 - WALK_HW + 0.03) : uvToPixel(0.5 - WALK_HW + 0.03, 0.5);
    const lx = Math.floor(px);
    const ly = Math.floor(py) + 8;
    // 淡い光だまり
    for (let yy = -2; yy <= 2; yy++) {
      for (let xx = -5; xx <= 5; xx++) {
        const d = (xx * xx) / 25 + (yy * yy) / 4;
        if (d <= 1) r.blend(lx + xx, ly + yy + 2, PAL.lamp, Math.round(70 * (1 - d)));
      }
    }
    r.set(lx, ly - 6, PAL.lamp);
    r.set(lx + 1, ly - 6, PAL.lamp);
    return toSprite(r, 0, 8);
  });
}

function paintRail(r: Raster, mask: number, bridge: boolean, dy = 0, withBallast = true, season: SeasonTint = 0): void {
  const alongX = (mask & (DIR_E | DIR_W)) !== 0;
  const alongY = (mask & (DIR_N | DIR_S)) !== 0;
  if (withBallast) {
    forEachDiamondPixel((x, y, u, v) => {
      if (inBand(u, v, 0.2, mask)) {
        const n = hash2(mask + 500, x, y);
        r.set(x, y + dy, bridge ? PAL.concreteDark : n < 0.15 ? shade(PAL.ballast, 0.85) : PAL.ballast);
      } else if (!bridge) {
        r.set(x, y + dy, grassPixel(x, y, season));
      }
    });
  }
  const segs: [number, number, number, number][] = [];
  // 各接続方向について中心から端まで
  if (mask & DIR_W) segs.push([0.5, 0.5, 0, 0.5]);
  if (mask & DIR_E) segs.push([0.5, 0.5, 1, 0.5]);
  if (mask & DIR_N) segs.push([0.5, 0.5, 0.5, 0]);
  if (mask & DIR_S) segs.push([0.5, 0.5, 0.5, 1]);
  if (!alongX && !alongY) segs.push([0, 0.5, 1, 0.5]);
  // 枕木
  for (const [u0, v0, u1, v1] of segs) {
    const horizontal = v0 === v1;
    for (let t = 0.08; t < 1; t += 0.16) {
      const u = u0 + (u1 - u0) * t;
      const v = v0 + (v1 - v0) * t;
      if (horizontal) lineUV(r, u, v - 0.13, u, v + 0.13, PAL.sleeper, dy);
      else lineUV(r, u - 0.13, v, u + 0.13, v, PAL.sleeper, dy);
    }
  }
  // レール
  for (const [u0, v0, u1, v1] of segs) {
    const horizontal = v0 === v1;
    for (const off of [-0.08, 0.08]) {
      if (horizontal) lineUV(r, u0, v0 + off, u1, v1 + off, PAL.rail, dy);
      else lineUV(r, u0 + off, v0, u1 + off, v1, PAL.rail, dy);
    }
  }
}

export function railSprite(mask: number, bridge: boolean, season: SeasonTint = 0): Sprite {
  return cache.get(`rl:${mask}:${bridge ? 1 : 0}:${season}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRail(r, mask, bridge, 0, true, season);
    return toSprite(r, 0, 0);
  });
}

export function crossingSprite(railMask: number, roadMask: number, season: SeasonTint = 0): Sprite {
  return cache.get(`x:${railMask}:${roadMask}:${season}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRoad(r, roadMask, false, 0, season);
    paintRail(r, railMask, false, 0, false);
    // 踏切の縞模様
    const alongX = (railMask & (DIR_E | DIR_W)) !== 0;
    for (const side of [-1, 1]) {
      const v = 0.5 + side * 0.3;
      for (let t = 0.26; t <= 0.74; t += 0.06) {
        const [px, py] = alongX ? uvToPixel(t, v) : uvToPixel(v, t);
        const stripe = Math.floor(t / 0.06) % 2 === 0;
        r.set(Math.floor(px), Math.floor(py), stripe ? ([240, 240, 240] as RGB) : ([220, 60, 50] as RGB));
      }
    }
    return toSprite(r, 0, 0);
  });
}

/** 駅: 線路 + ホーム + 屋根。スプライトは 32x26 (oy=10)。 */
export function stationSprite(plazaDir: number, season: SeasonTint = 0): { base: Sprite; emissive: Sprite | null } {
  return pairCache.get(`st:${plazaDir}:${season}`, () => {
    const DY = 10;
    const r = new Raster(TILE_W, TILE_H + DY);
    const e = new Raster(TILE_W, TILE_H + DY);
    paintRail(r, DIR_E | DIR_W, false, DY, true, season);
    const south = plazaDir === 2;
    const inPlatform = (v: number) => (south ? v >= 0.66 : v <= 0.34);
    forEachDiamondPixel((x, y, u, v) => {
      if (inPlatform(v) && u > 0.02 && u < 0.98) {
        const edge = south ? v < 0.7 : v > 0.3;
        r.set(x, y + DY, edge ? PAL.concreteDark : PAL.platform);
      }
    });
    // 屋根 (9px 上)
    const ROOF = 9;
    forEachDiamondPixel((x, y, u, v) => {
      const vv = south ? v : 1 - v;
      if (vv >= 0.7 && vv <= 0.96 && u >= 0.1 && u <= 0.9) {
        const edge = vv > 0.94 || vv < 0.72 || u < 0.12 || u > 0.88;
        r.set(x, y + DY - ROOF, edge ? shade(PAL.roofStation, 0.8) : PAL.roofStation);
      }
    });
    // 柱
    for (const u of [0.18, 0.5, 0.82]) {
      const v = south ? 0.9 : 0.1;
      const [px, py] = uvToPixel(u, v);
      r.vline(Math.floor(px), Math.floor(py) + DY - ROOF + 1, Math.floor(py) + DY - 1, PAL.concreteDark);
    }
    // 明かり
    for (const u of [0.32, 0.68]) {
      const v = south ? 0.82 : 0.18;
      const [px, py] = uvToPixel(u, v);
      const lx = Math.floor(px);
      const ly = Math.floor(py) + DY - ROOF + 2;
      e.set(lx, ly, PAL.lamp);
      e.set(lx + 1, ly, PAL.lamp);
      for (let yy = 1; yy <= 5; yy++) {
        for (let xx = -4; xx <= 4; xx++) {
          const d = (xx * xx) / 16 + ((yy - 3) * (yy - 3)) / 6;
          if (d <= 1) e.blend(lx + xx, ly + yy, PAL.lamp, Math.round(90 * (1 - d)));
        }
      }
    }
    return { base: toSprite(r, 0, DY), emissive: toSprite(e, 0, DY) };
  });
}

// ---------------------------------------------------------------------------
// 建物

export interface BuildingSpec {
  level: number;
  style: number;
  /** 見えている階数 (建設中は少ない) */
  floors: number;
  state: BState;
  lights: number;
}

const FLOOR_H = [0, 6, 6, 6, 6] as const;
const FOOTPRINT = [0, 20, 28, 30, 32] as const;
const TOTAL_FLOORS = [0, 1, 2, 5, 10] as const;

const HOUSE_WALLS: RGB[] = [
  [240, 236, 224],
  [232, 220, 192],
  [196, 160, 120],
  [212, 212, 208],
  [204, 220, 232],
  [224, 204, 184],
];
const HOUSE_ROOFS: RGB[] = [
  [176, 72, 64],
  [72, 104, 168],
  [104, 104, 112],
  [64, 128, 96],
  [168, 112, 64],
  [120, 80, 120],
  [88, 96, 104],
  [200, 120, 72],
];
const NEON: RGB[] = [
  [255, 104, 168],
  [104, 232, 255],
  [255, 224, 104],
  [120, 255, 136],
  [255, 160, 96],
];

/** 窓の 1 ピクセルを両方のラスタに置く */
function putWindow(r: Raster, e: Raster, x: number, y: number, dayColor: RGB, lit: RGB | null): boolean {
  r.set(x, y, dayColor);
  if (lit) e.set(x, y, lit);
  return lit !== null;
}

/** 建物スプライト (壁・屋根のみ、地面は別)。oy = 高さ - 16。 */
export function buildingSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const key = `b:${spec.level}:${spec.style}:${spec.floors}:${spec.state}:${spec.lights}`;
  return pairCache.get(key, () => {
    if (spec.level === 1) return houseSprite(spec);
    if (spec.level >= 5) return landmarkSprite(spec);
    if (isMixedUse(spec.level, spec.style)) return mixedUseSprite(spec);
    return boxBuildingSprite(spec);
  });
}

/** 民家: 大きさ・階数・屋根の形と向き・色がスタイルで変わる */
function houseSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const st = spec.style;
  const total = buildingFloors(1, st);
  const constructing = spec.state === BState.Constructing;
  const abandoned = spec.state === BState.Abandoned;
  const floors = constructing ? spec.floors : total;
  const fh = 6;
  const fw = [16, 20, 20, 24][(st >> 5) & 3];
  const hip = ((st >> 3) & 1) === 1;
  const ridgeAlongX = ((st >> 4) & 1) === 0;
  const H = TILE_H + 2 * fh + 14;
  const baseTop = H - TILE_H;
  const r = new Raster(TILE_W, H);
  const e = new Raster(TILE_W, H);
  let anyLight = false;
  let wall: RGB = HOUSE_WALLS[(st >> 1) % HOUSE_WALLS.length];
  let roof: RGB = HOUSE_ROOFS[st % HOUSE_ROOFS.length];
  if (abandoned) {
    wall = mix(wall, [110, 110, 104], 0.55);
    roof = mix(roof, [90, 90, 90], 0.55);
  }
  const wallL = wall;
  const wallR = shade(wall, 0.72);
  const x0 = HALF_W - fw / 2;
  const x1 = HALF_W + fw / 2;
  const wallH = floors * fh;

  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = diamondRows(x, fw);
    const yt = ytR + baseTop;
    const yb = ybR + baseTop;
    const left = x < HALF_W;
    const along = left ? x - x0 : x1 - 1 - x;
    const wc = left ? wallL : wallR;
    for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, wc);
    // 窓 (2px 幅、壁の端と中央の角は空ける)
    if ((along % 4 === 1 || along % 4 === 2) && along < fw / 2 - 2) {
      for (let f = 0; f < floors; f++) {
        const fTop = yb - (f + 1) * fh + 1;
        const lit = !abandoned && !constructing && hash3(spec.lights, f, along >> 2, left ? 1 : 2) < 0.45;
        for (let wy = 2; wy <= 3; wy++) {
          if (putWindow(r, e, x, fTop + wy, abandoned ? [60, 60, 64] : shade(PAL.windowDay, left ? 1 : 0.8), lit ? PAL.windowLitWarm : null)) anyLight = true;
        }
      }
    }
    // 玄関
    if (left && along === fw / 2 - 3 && floors > 0) {
      for (let y = yb - 3; y <= yb; y++) r.set(x, y, shade(wc, 0.5));
      r.set(x + 1, yb - 3, shade(wc, 0.5));
      r.set(x + 1, yb - 2, shade(wc, 0.5));
    }
    if (x === HALF_W && wallH > 0) r.vline(x, yb - wallH + 1, yb, shade(wallR, 0.85));
    // 屋根
    if (floors === total && !constructing) {
      const ridgeH = hip ? 3 : 4;
      let last = -1;
      for (let y = yt - wallH; y <= yb - wallH; y++) {
        const A = (x + 0.5 - HALF_W) / (fw / 2);
        const B = (y + 0.5 - baseTop - HALF_H + wallH) / (fw / 4) + 1;
        const u = (A + B) / 2;
        const v = (B - A) / 2;
        const dv = 1 - Math.abs(2 * v - 1);
        const du = 1 - Math.abs(2 * u - 1);
        let eh: number;
        let litFace: boolean;
        if (hip) {
          eh = Math.round(ridgeH * Math.min(1, 1.6 * Math.min(du, dv)));
          litFace = dv < du ? v < 0.5 : u < 0.5;
        } else if (ridgeAlongX) {
          eh = Math.round(ridgeH * dv);
          litFace = v < 0.5;
        } else {
          eh = Math.round(ridgeH * du);
          litFace = u < 0.5;
        }
        const target = y - eh;
        const color = litFace ? shade(roof, 1.1) : shade(roof, 0.78);
        if (last >= 0) {
          const lo = Math.min(last + 1, target);
          const hi = Math.max(last - 1, target);
          for (let yy = lo; yy <= hi; yy++) r.set(x, yy, color);
        }
        r.set(x, target, color);
        last = target;
      }
      r.set(x, yb - wallH + 1, shade(roof, 0.6));
    } else if (constructing) {
      // 足場
      const top = yb - (floors + 1) * fh + 1;
      for (let y = top; y <= yb - floors * fh; y++) {
        if (along % 3 === 0 || (y - top) % 3 === 0) r.set(x, y, PAL.scaffold);
      }
    }
  }
  // 煙突
  if (!constructing && (st & 0x40) && !hip) {
    const cx = x0 + 4;
    const [, ybR] = diamondRows(cx, fw);
    const top = ybR + baseTop - wallH - 6;
    r.fillRect(cx, top, 2, 4, [150, 90, 80]);
    r.hline(cx, cx + 1, top, [110, 70, 60]);
  }
  // 庭木 (小さい家)
  if (fw <= 20 && ((st >> 2) & 1) && !constructing) {
    const tx = fw === 16 ? 4 : 3;
    const ty = baseTop + 11;
    r.vline(tx, ty - 1, ty + 1, PAL.trunk);
    r.disc(tx + 0.5, ty - 3, 2.2, PAL.canopy);
    r.set(tx, ty - 4, PAL.canopyLight);
  }
  return { base: toSprite(r, 0, baseTop), emissive: anyLight ? toSprite(e, 0, baseTop) : null };
}

/** 雑居ビル: 細長く、各階に看板、屋上に広告塔。夜はネオンが光る */
function mixedUseSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const st = spec.style;
  const total = buildingFloors(spec.level, st);
  const constructing = spec.state === BState.Constructing;
  const abandoned = spec.state === BState.Abandoned;
  const floors = constructing ? spec.floors : total;
  const fh = 6;
  const fw = 24;
  const H = TILE_H + total * fh + 22;
  const baseTop = H - TILE_H;
  const r = new Raster(TILE_W, H);
  const e = new Raster(TILE_W, H);
  let anyLight = false;
  const MIXED_WALLS: RGB[] = [[200, 200, 196], [216, 208, 192], [184, 188, 192], [228, 224, 216], [172, 168, 164]];
  let wall: RGB = MIXED_WALLS[(st >> 1) % MIXED_WALLS.length];
  if (abandoned) wall = mix(wall, [100, 100, 96], 0.55);
  const wallL = wall;
  const wallR = shade(wall, 0.72);
  const roof: RGB = shade(wall, 0.85);
  const x0 = HALF_W - fw / 2;
  const x1 = HALF_W + fw / 2;
  const wallH = floors * fh;
  const signColor = (f: number, k: number) => SIGNS[Math.floor(hash3(st, f, k, 11) * SIGNS.length)];
  const neonColor = (f: number, k: number) => NEON[Math.floor(hash3(st, f, k, 13) * NEON.length)];
  const signLit = (f: number, k: number) => !abandoned && !constructing && hash3(spec.lights, f, k, 17) < 0.75;

  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = diamondRows(x, fw);
    const yt = ytR + baseTop;
    const yb = ybR + baseTop;
    const left = x < HALF_W;
    const along = left ? x - x0 : x1 - 1 - x;
    const wc = left ? wallL : wallR;
    for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, wc);
    for (let f = 0; f < floors; f++) {
      const fTop = yb - (f + 1) * fh + 1;
      if (!left) {
        // 右壁: 各階の横看板 (上 2 行) と窓
        if (along >= 1 && along < fw / 2 - 3 && hash3(st, f, 0, 23) < 0.7) {
          const sc = shade(signColor(f, 0), 0.85);
          const lit = signLit(f, 0);
          r.set(x, fTop + 1, abandoned ? shade(sc, 0.5) : sc);
          r.set(x, fTop + 2, abandoned ? shade(sc, 0.4) : shade(sc, 0.8));
          if (lit && hash3(st, f, along, 19) < 0.85) {
            e.set(x, fTop + 1, neonColor(f, 0));
            e.set(x, fTop + 2, shade(neonColor(f, 0), 0.8));
            anyLight = true;
          }
        }
        if (along % 3 === 1 && along < fw / 2 - 3) {
          const lit = !abandoned && !constructing && hash3(spec.lights, f, along, 2) < 0.5;
          if (putWindow(r, e, x, fTop + 4, shade(PAL.windowDay, 0.8), lit ? PAL.windowLit : null)) anyLight = true;
        }
      } else {
        // 左壁: 窓と、角の縦看板
        if (along % 3 === 1 && along < fw / 2 - 4) {
          const lit = !abandoned && !constructing && hash3(spec.lights, f, along, 1) < 0.5;
          for (let wy = 2; wy <= 4; wy++) {
            if (putWindow(r, e, x, fTop + wy, PAL.windowDay, lit ? PAL.windowLit : null)) anyLight = true;
          }
        }
        if (along >= fw / 2 - 3 && along <= fw / 2 - 2) {
          const sc = signColor(f, 1);
          for (let wy = 1; wy <= 4; wy++) {
            r.set(x, fTop + wy, abandoned ? shade(sc, 0.5) : wy === 1 ? shade(sc, 0.8) : sc);
            if (signLit(f, 1)) {
              e.set(x, fTop + wy, neonColor(0, 1));
              anyLight = true;
            }
          }
        }
      }
      // 1 階の入口
      if (f === 0 && left && along >= 1 && along <= 2) {
        for (let y = yb - 3; y <= yb; y++) r.set(x, y, shade(wc, 0.45));
        if (!abandoned && !constructing) {
          e.set(x, yb - 3, PAL.windowLitWarm);
          anyLight = true;
        }
      }
    }
    // 屋根
    for (let y = yt - wallH; y <= yb - wallH; y++) {
      const edge = y === yt - wallH || y === yb - wallH;
      r.set(x, y, edge ? shade(roof, 0.75) : roof);
    }
    if (x === HALF_W && wallH > 0) r.vline(x, yb - wallH + 1, yb, shade(wallR, 0.85));
  }
  if (!constructing) {
    // 屋上: 階段室と広告塔
    drawRoofBox(r, baseTop - wallH, 8, 3, shade(wall, 0.95), shade(wall, 0.7), shade(roof, 0.85), -4);
    const bx = HALF_W + 2;
    const [, ybR] = diamondRows(bx, fw);
    const roofY = ybR + baseTop - wallH;
    if (spec.level === 3 && (st & 0x20)) {
      const panel = shade(SIGNS[(st >> 3) % SIGNS.length], 0.8);
      r.vline(bx - 1, roofY - 5, roofY - 1, PAL.railDark);
      r.vline(bx + 3, roofY - 5, roofY - 1, PAL.railDark);
      r.fillRect(bx - 3, roofY - 9, 9, 4, abandoned ? shade(panel, 0.5) : panel);
      r.fillRect(bx - 2, roofY - 8, 7, 2, abandoned ? shade(panel, 0.6) : shade(panel, 1.2));
      if (!abandoned && hash2(spec.lights, st, 5) < 0.8) {
        e.fillRect(bx - 3, roofY - 9, 9, 4, panel);
        e.fillRect(bx - 2, roofY - 8, 7, 2, [255, 255, 240]);
        anyLight = true;
      }
    }
  } else if (floors < total) {
    drawScaffoldAndCrane(r, e, x0, x1, fw, baseTop, floors, fh, true);
    anyLight = true;
  }
  return { base: toSprite(r, 0, baseTop), emissive: anyLight ? toSprite(e, 0, baseTop) : null };
}

/** 商店・アパート・中層・高層の箱型ビル */
function boxBuildingSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const level = spec.level;
  const fh = FLOOR_H[level];
  const fw = FOOTPRINT[level];
  const total = buildingFloors(level, spec.style);
  const constructing = spec.state === BState.Constructing;
  const abandoned = spec.state === BState.Abandoned;
  const floors = constructing ? spec.floors : total;
  const H = TILE_H + total * fh + 22;
  const baseTop = H - TILE_H;
  const r = new Raster(TILE_W, H);
  const e = new Raster(TILE_W, H);
  let anyLight = false;

  const st = spec.style;
  let wall: RGB = level === 4 ? TOWER_WALLS[st % TOWER_WALLS.length] : WALLS[st % WALLS.length];
  let roof: RGB = level <= 2 ? ROOFS[(st >> 3) % ROOFS.length] : shade(wall, 0.9);
  if (abandoned) {
    wall = mix(wall, [110, 110, 104], 0.55);
    roof = mix(roof, [90, 90, 90], 0.55);
  }
  const wallL = wall;
  const wallR = shade(wall, 0.72);
  const roofLight = shade(roof, 1.1);
  const sign = SIGNS[(st >> 2) % SIGNS.length];
  const wallH = floors * fh;
  const x0 = HALF_W - fw / 2;
  const x1 = HALF_W + fw / 2;
  const windowRows = fh - 3;

  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = diamondRows(x, fw);
    const yt = ytR + baseTop;
    const yb = ybR + baseTop;
    const left = x < HALF_W;
    const along = left ? x - x0 : x1 - 1 - x;
    const wc = left ? wallL : wallR;
    for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, wc);
    const windowCol = level === 4 ? along % 3 !== 0 : along % 4 === 1 || along % 4 === 2;
    if (windowCol && along < fw / 2 - 2) {
      for (let f = 0; f < floors; f++) {
        const fTop = yb - (f + 1) * fh + 1;
        const lit = !abandoned && !constructing && hash3(spec.lights, f, along >> 2, left ? 1 : 2) < 0.62;
        const boarded = abandoned && hash3(st, f, along >> 2, 7) < 0.5;
        const warm = hash3(spec.lights, f, along >> 2, 3) < 0.7;
        for (let wy = 1; wy <= windowRows; wy++) {
          const y = fTop + wy;
          const day: RGB = boarded ? shade(PAL.dirtDark, 0.8) : abandoned ? [60, 60, 64] : shade(PAL.windowDay, left ? 1 : 0.8);
          if (putWindow(r, e, x, y, day, lit ? (warm ? PAL.windowLitWarm : level === 4 ? PAL.windowLitCool : PAL.windowLit) : null)) anyLight = true;
        }
      }
    }
    if (left && (along === 2 || along === 3) && floors > 0 && level <= 3) {
      for (let y = yb - 3; y <= yb; y++) r.set(x, y, shade(wc, 0.5));
      if (!abandoned && !constructing && along === 2) {
        e.set(x, yb - 3, PAL.windowLitWarm);
        anyLight = true;
      }
    }
    if (level === 2 && !left && floors === total && along >= 1 && along < fw / 2 - 3) {
      const top = yb - wallH + 1;
      r.set(x, top + 1, sign);
      r.set(x, top + 2, shade(sign, 0.8));
    }
    for (let y = yt - wallH; y <= yb - wallH; y++) {
      const edge = y === yt - wallH || y === yb - wallH;
      r.set(x, y, edge ? shade(roof, 0.75) : y === yt - wallH + 1 ? roofLight : roof);
    }
    if (x === HALF_W && wallH > 0) r.vline(x, yb - wallH + 1, yb, shade(wallR, 0.85));
  }
  if (!constructing && level === 3) {
    drawRoofBox(r, baseTop - wallH, 10, 4, shade(wall, 0.95), shade(wall, 0.7), shade(roof, 0.85));
  }
  if (!constructing && level === 4) {
    const topY = baseTop + HALF_H - 1 - wallH;
    r.vline(HALF_W, topY - 7, topY - 1, PAL.railDark);
    r.set(HALF_W, topY - 8, PAL.redLight);
    e.set(HALF_W, topY - 8, PAL.redLight);
    anyLight = true;
  }
  if (constructing && floors < total) {
    drawScaffoldAndCrane(r, e, x0, x1, fw, baseTop, floors, fh, level >= 2);
    if (level >= 2) anyLight = true;
  }
  return { base: toSprite(r, 0, baseTop), emissive: anyLight ? toSprite(e, 0, baseTop) : null };
}

/** ランドマーク: 市役所 (5)、タワー (6)、観覧車 (7) */
function landmarkSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const constructing = spec.state === BState.Constructing;
  const H = TILE_H + 110;
  const baseTop = H - TILE_H;
  const r = new Raster(TILE_W, H);
  const e = new Raster(TILE_W, H);
  if (constructing) {
    // 工事現場: 柵と資材とクレーン
    forEachDiamondPixel((x, y, u, v) => {
      if (u > 0.08 && u < 0.92 && v > 0.08 && v < 0.92) {
        const n = hash2(spec.style, x, y);
        r.set(x, y + baseTop, n < 0.12 ? PAL.concreteDark : n < 0.2 ? PAL.sand : PAL.dirt);
      }
    });
    drawScaffoldAndCrane(r, e, 4, 28, 24, baseTop, 0, 6, true);
    return { base: toSprite(r, 0, baseTop), emissive: toSprite(e, 0, baseTop) };
  }
  if (spec.level === 5) drawHall(r, e, baseTop, spec);
  else if (spec.level === 6) drawTower(r, e, baseTop);
  else drawWheel(r, e, baseTop, spec);
  return { base: toSprite(r, 0, baseTop), emissive: toSprite(e, 0, baseTop) };
}

function drawHall(r: Raster, e: Raster, baseTop: number, spec: BuildingSpec): void {
  const fw = 32;
  const fh = 6;
  const floors = 3;
  const wall: RGB = [238, 236, 226];
  const wallR = shade(wall, 0.74);
  const roof: RGB = [96, 128, 112];
  const x0 = 0;
  const x1 = 32;
  const wallH = floors * fh;
  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = diamondRows(x, fw);
    const yt = ytR + baseTop;
    const yb = ybR + baseTop;
    const left = x < HALF_W;
    const along = left ? x - x0 : x1 - 1 - x;
    for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, left ? wall : wallR);
    if (along % 4 === 1 || along % 4 === 2) {
      for (let f = 0; f < floors; f++) {
        const fTop = yb - (f + 1) * fh + 1;
        const lit = hash3(spec.lights, f, along >> 2, left ? 1 : 2) < 0.4;
        for (let wy = 2; wy <= 4; wy++) putWindow(r, e, x, fTop + wy, shade(PAL.windowDay, left ? 1 : 0.8), lit ? PAL.windowLit : null);
      }
    }
    // 正面玄関 (左壁の中央寄り)
    if (left && along >= 11 && along <= 13) {
      for (let y = yb - 4; y <= yb; y++) r.set(x, y, shade(wall, 0.45));
      e.set(x, yb - 4, PAL.windowLitWarm);
    }
    for (let y = yt - wallH; y <= yb - wallH; y++) {
      const edge = y === yt - wallH || y === yb - wallH;
      r.set(x, y, edge ? shade(roof, 0.75) : roof);
    }
    if (x === HALF_W) r.vline(x, yb - wallH + 1, yb, shade(wallR, 0.85));
  }
  // 時計塔
  const towerTop = baseTop - wallH;
  drawRoofBox(r, towerTop, 10, 12, wall, wallR, shade(roof, 0.9));
  const cx = HALF_W - 3;
  const cy = towerTop + HALF_H - 1 - 8;
  r.fillRect(cx - 1, cy - 1, 3, 3, [250, 250, 240]);
  r.set(cx, cy, [40, 40, 48]);
  e.fillRect(cx - 1, cy - 1, 3, 3, [255, 248, 200]);
  // 旗
  const fx = HALF_W;
  const fy = towerTop + HALF_H - 1 - 12;
  r.vline(fx, fy - 7, fy - 1, PAL.railDark);
  r.fillRect(fx + 1, fy - 7, 3, 2, [220, 60, 50]);
}

function drawTower(r: Raster, e: Raster, baseTop: number): void {
  // 土台
  forEachDiamondPixel((x, y, u, v) => {
    if (u > 0.1 && u < 0.9 && v > 0.1 && v < 0.9) r.set(x, y + baseTop, hash2(5, x, y) < 0.08 ? PAL.concreteDark : PAL.concrete);
  });
  const orange: RGB = [232, 104, 48];
  const dark: RGB = [168, 72, 32];
  const height = 98;
  const bottom = baseTop + HALF_H + 2;
  const top = bottom - height;
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / height;
    const hw = 1 + t * t * 13;
    const lx = Math.round(HALF_W - hw);
    const rx = Math.round(HALF_W + hw);
    r.set(lx, y, orange);
    r.set(rx, y, dark);
    const row = y - top;
    if (row % 7 === 0 && hw > 2) {
      for (let x = lx + 1; x < rx; x++) r.set(x, y, (x - lx) % 2 === 0 ? orange : dark);
    } else if (hw > 3) {
      // 斜めの筋交い
      const k = row % 7;
      const span = rx - lx;
      const px = lx + Math.round((k / 7) * span);
      const qx = rx - Math.round((k / 7) * span);
      r.set(px, y, dark);
      r.set(qx, y, orange);
    }
  }
  // 展望台
  const deckY = top + Math.round(height * 0.45);
  const dhw = Math.round(1 + 0.45 * 0.45 * 13) + 3;
  r.fillRect(HALF_W - dhw, deckY - 2, dhw * 2 + 1, 4, [236, 236, 228]);
  r.hline(HALF_W - dhw, HALF_W + dhw, deckY + 2, [160, 160, 152]);
  for (let x = HALF_W - dhw + 1; x < HALF_W + dhw; x += 2) {
    r.set(x, deckY, PAL.windowDay);
    e.set(x, deckY, PAL.windowLit);
  }
  // アンテナと灯
  r.vline(HALF_W, top - 6, top - 1, PAL.railDark);
  r.set(HALF_W, top - 7, PAL.redLight);
  e.set(HALF_W, top - 7, PAL.redLight);
  e.set(HALF_W - 1, deckY - 3, PAL.redLight);
  e.set(HALF_W + 1, deckY - 3, PAL.redLight);
  // 脚の灯り
  for (const y of [bottom - 8, bottom - 20, bottom - 32, bottom - 44, bottom - 56, bottom - 68, bottom - 80]) {
    const t = (y - top) / height;
    const hw = 1 + t * t * 13;
    e.set(Math.round(HALF_W - hw), y, [255, 200, 120]);
    e.set(Math.round(HALF_W + hw), y, [255, 200, 120]);
  }
}

function drawWheel(r: Raster, e: Raster, baseTop: number, spec: BuildingSpec): void {
  forEachDiamondPixel((x, y, u, v) => {
    if (u > 0.08 && u < 0.92 && v > 0.08 && v < 0.92) r.set(x, y + baseTop, hash2(7, x, y) < 0.1 ? PAL.concreteDark : PAL.concrete);
  });
  const cx = HALF_W;
  const cy = baseTop + HALF_H - 24;
  const R = 15;
  // 支柱
  for (let k = 0; k <= 24; k++) {
    const t = k / 24;
    r.set(Math.round(cx - 1 - t * 10), Math.round(cy + t * 28), PAL.railDark);
    r.set(Math.round(cx + 1 + t * 10), Math.round(cy + t * 28), PAL.railDark);
  }
  // リムとスポーク
  const rim: RGB = [200, 204, 212];
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180;
    r.set(Math.round(cx + Math.cos(rad) * R), Math.round(cy + Math.sin(rad) * R * 0.85), rim);
  }
  for (let g = 0; g < 8; g++) {
    const rad = (g * Math.PI) / 4 + spec.style * 0.01;
    for (let k = 0; k <= 14; k++) {
      const t = k / 14;
      r.set(Math.round(cx + Math.cos(rad) * R * t), Math.round(cy + Math.sin(rad) * R * 0.85 * t), [150, 154, 164]);
    }
    const gx = Math.round(cx + Math.cos(rad) * R);
    const gy = Math.round(cy + Math.sin(rad) * R * 0.85) + 2;
    const c = SIGNS[g % SIGNS.length];
    r.fillRect(gx - 1, gy - 1, 3, 3, c);
    r.set(gx, gy - 2, PAL.railDark);
    e.fillRect(gx - 1, gy - 1, 3, 3, shade(c, 1.2));
  }
  r.fillRect(cx - 1, cy - 1, 3, 3, [240, 240, 232]);
  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180;
    e.set(Math.round(cx + Math.cos(rad) * R), Math.round(cy + Math.sin(rad) * R * 0.85), PAL.lamp);
  }
}

function drawScaffoldAndCrane(r: Raster, e: Raster, x0: number, x1: number, fw: number, baseTop: number, floors: number, fh: number, crane: boolean): void {
  for (let x = x0; x < x1; x++) {
    const [, ybR] = diamondRows(x, fw);
    const yb = ybR + baseTop;
    const top = yb - (floors + 1) * fh + 1;
    for (let y = top; y <= yb - floors * fh; y++) {
      const along = x < HALF_W ? x - x0 : x1 - 1 - x;
      if (along % 3 === 0 || (y - top) % 3 === 0) r.set(x, y, PAL.scaffold);
    }
  }
  if (!crane) return;
  const mx = HALF_W + 3;
  const [, ybR] = diamondRows(mx, fw);
  const base = ybR + baseTop - (floors + 1) * fh;
  const top = base - 14;
  for (let y = top; y <= base; y++) r.set(mx, y, (y - top) % 2 === 0 ? PAL.crane : PAL.craneDark);
  r.hline(mx - 11, mx + 7, top, PAL.crane);
  r.hline(mx - 11, mx - 8, top + 1, PAL.craneDark);
  r.vline(mx + 5, top + 1, top + 6, PAL.railDark);
  r.set(mx + 5, top + 7, PAL.craneDark);
  r.set(mx, top - 1, PAL.redLight);
  e.set(mx, top - 1, PAL.redLight);
}

function drawRoofBox(r: Raster, roofBaseTop: number, fw: number, h: number, wl: RGB, wr: RGB, top: RGB, dx = 0): void {
  const x0 = HALF_W - fw / 2 + dx;
  const x1 = HALF_W + fw / 2 + dx;
  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = diamondRows(x, fw, HALF_W + dx);
    const yt = ytR + roofBaseTop;
    const yb = ybR + roofBaseTop;
    for (let y = yb - h + 1; y <= yb; y++) r.set(x, y, x < HALF_W + dx ? wl : wr);
    for (let y = yt - h; y <= yb - h; y++) r.set(x, y, top);
  }
}

export const BUILDING_TOTAL_FLOORS = TOTAL_FLOORS;

// ---------------------------------------------------------------------------
// 列車・踏切

/**
 * タイル内座標の矩形 [u0,u1]×[v0,v1] を高さ h で押し出した箱を描く。
 * baseTop はラスタ内でタイルのダイヤが始まる行。
 */
function isoBox(
  r: Raster,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
  baseTop: number,
  colors: { top: RGB; sw: RGB; se: RGB },
  sidePixel?: (x: number, y: number, side: "sw" | "se", u: number, v: number, k: number) => RGB | null,
): void {
  const ground: [number, number, number, number][] = [];
  forEachDiamondPixel((x, y, u, v) => {
    if (u >= u0 && u <= u1 && v >= v0 && v <= v1) ground.push([x, y + baseTop, u, v]);
  });
  ground.sort((a, b) => a[1] - b[1]);
  for (const [x, y, u, v] of ground) {
    const side: "sw" | "se" = v1 - v < u1 - u ? "sw" : "se";
    const base = side === "sw" ? colors.sw : colors.se;
    for (let k = 1; k <= h; k++) {
      const c = sidePixel ? (sidePixel(x, y - k, side, u, v, k) ?? base) : base;
      r.set(x, y - k, c);
    }
  }
  for (const [x, y] of ground) r.set(x, y - h, colors.top);
}

export interface CarSpriteSpec {
  axis: "x" | "y";
  facing: 1 | -1;
  kind: "head" | "mid" | "tail";
}

/** 車両。タイル中心を (16, 24) に置いた 32x32 のラスタ (ox=16, oy=24)。 */
export function carSprite(spec: CarSpriteSpec): { base: Sprite; emissive: Sprite | null } {
  const key = `car:${spec.axis}:${spec.facing}:${spec.kind}`;
  return pairCache.get(key, () => {
    const r = new Raster(32, 32);
    const e = new Raster(32, 32);
    const baseTop = 16;
    const half = 0.4;
    const wid = 0.15;
    const [u0, u1, v0, v1] = spec.axis === "x" ? [0.5 - half, 0.5 + half, 0.5 - wid, 0.5 + wid] : [0.5 - wid, 0.5 + wid, 0.5 - half, 0.5 + half];
    const body: RGB = [236, 232, 216];
    const stripe: RGB = [48, 96, 192];
    const H = 7;
    // 前端が見える側か: 東向き (x軸 +1) なら前端は u1 側 (SE面)、南向き (y軸 +1) なら v1 側 (SW面)
    const frontVisible = spec.facing === 1;
    const front = spec.kind === "head";
    const back = spec.kind === "tail";
    isoBox(r, u0, v0, u1, v1, H, baseTop, { top: [120, 124, 132], sw: body, se: shade(body, 0.75) }, (_x, _y, side, u, v, k) => {
      const longSide = spec.axis === "x" ? side === "sw" : side === "se";
      const along = spec.axis === "x" ? u - u0 : v - v0;
      if (k === 2) return side === "sw" ? stripe : shade(stripe, 0.75);
      if (longSide && (k === 4 || k === 5)) {
        const w = (along / (2 * half)) * 7;
        if (w % 1 < 0.55 && w > 0.4 && w < 6.6) return side === "sw" ? PAL.windowDay : shade(PAL.windowDay, 0.8);
      }
      if (!longSide && front && frontVisible && k === 3) return PAL.windowDay;
      return null;
    });
    // 前照灯・尾灯 (見える端面の下のほう)
    const endSide: "sw" | "se" = spec.axis === "x" ? "se" : "sw";
    const endU = spec.axis === "x" ? u1 : 0.5;
    const endV = spec.axis === "x" ? 0.5 : v1;
    const [ex, ey] = uvToPixel(endU, endV);
    const lx = Math.floor(ex);
    const ly = Math.floor(ey) + baseTop - 2;
    void endSide;
    if (frontVisible && front) {
      e.set(lx - 1, ly, PAL.lamp);
      e.set(lx + 1, ly, PAL.lamp);
      r.set(lx - 1, ly, [255, 250, 200]);
      r.set(lx + 1, ly, [255, 250, 200]);
    } else if (!frontVisible && back) {
      e.set(lx - 1, ly, PAL.redLight);
      e.set(lx + 1, ly, PAL.redLight);
      r.set(lx - 1, ly, [200, 60, 50]);
      r.set(lx + 1, ly, [200, 60, 50]);
    }
    // 窓明かり
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const d = r.data;
        if (d[i + 3] && d[i] === PAL.windowDay[0] && d[i + 1] === PAL.windowDay[1] && d[i + 2] === PAL.windowDay[2]) {
          e.set(x, y, PAL.windowLit);
        }
      }
    }
    return { base: toSprite(r, 16, 24), emissive: toSprite(e, 16, 24) };
  });
}

/** 踏切の遮断機 (降りた状態) と警報灯。railAlongX は線路が東西方向か。 */
export function gateSprite(railAlongX: boolean, lit: boolean): { base: Sprite; emissive: Sprite | null } {
  return pairCache.get(`gate:${railAlongX ? 1 : 0}:${lit ? 1 : 0}`, () => {
    const r = new Raster(32, 24);
    const e = new Raster(32, 24);
    const DY = 8;
    // 線路の両側、道路の上に横たわる棒
    for (const side of [-1, 1]) {
      const off = 0.5 + side * 0.3;
      const [a0, a1] = [0.26, 0.74];
      for (let t = 0; t <= 1; t += 0.03) {
        const u = railAlongX ? a0 + (a1 - a0) * t : off;
        const v = railAlongX ? off : a0 + (a1 - a0) * t;
        const [px, py] = uvToPixel(u, v);
        const stripe = Math.floor(t * 8) % 2 === 0;
        r.set(Math.floor(px), Math.floor(py) + DY - 4, stripe ? ([240, 240, 240] as RGB) : ([220, 60, 50] as RGB));
      }
      // 支柱と警報灯
      const [px, py] = railAlongX ? uvToPixel(0.24, off) : uvToPixel(off, 0.24);
      const sx = Math.floor(px);
      const sy = Math.floor(py) + DY;
      r.vline(sx, sy - 7, sy, PAL.railDark);
      r.set(sx, sy - 8, lit ? PAL.redLight : ([120, 40, 40] as RGB));
      if (lit) e.set(sx, sy - 8, PAL.redLight);
    }
    return { base: toSprite(r, 0, DY), emissive: lit ? toSprite(e, 0, DY) : null };
  });
}
