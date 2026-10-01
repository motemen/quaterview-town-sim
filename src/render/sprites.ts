import { hash2, hash3 } from "../sim/rng";
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

export type GroundKind = "grass" | "lot" | "park" | "concrete" | "water" | "sand" | "rubble";

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
};

/**
 * 地面タイル。rel は 4 隅の相対高さ [T,R,B,L] (0 or 1)。
 * スプライトは 32x24 で、タイル原点の 8px 上から始まる (oy = 8)。
 */
export function groundSprite(kind: GroundKind, rel: readonly [number, number, number, number], variant: number): Sprite {
  const key = `g:${kind}:${rel.join("")}:${variant}`;
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
    const [base, dark, light] = GROUND_COLORS[kind].map((c) => shade(c, bright)) as [RGB, RGB, RGB];
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
        } else {
          if (n < 0.09) c = dark;
          else if (n < 0.15) c = light;
        }
        r.set(x, y, c);
      }
    }
    if (kind === "park") {
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
    const canopy = tint === 1 ? ([232, 176, 192] as RGB) : tint === 2 ? ([200, 120, 64] as RGB) : tint === 3 ? ([224, 232, 240] as RGB) : PAL.canopy;
    const canopyLight = tint === 0 ? PAL.canopyLight : shade(canopy, 1.15);
    const canopyDark = tint === 0 ? PAL.canopyDark : shade(canopy, 0.8);
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

function paintRoad(r: Raster, mask: number, bridge: boolean, dy = 0): void {
  forEachDiamondPixel((x, y, u, v) => {
    const road = inBand(u, v, ROAD_HW, mask);
    const walk = !road && inBand(u, v, WALK_HW, mask);
    if (road) {
      const n = hash2(mask, x, y);
      r.set(x, y + dy, n < 0.05 ? PAL.roadDark : PAL.road);
    } else if (walk) {
      r.set(x, y + dy, bridge ? PAL.railDark : PAL.sidewalk);
    } else if (!bridge) {
      // 周囲は草
      const n = hash2(99, x, y);
      r.set(x, y + dy, n < 0.09 ? PAL.grassDark : n < 0.15 ? PAL.grassLight : PAL.grass);
    }
  });
}

export function roadSprite(mask: number, bridge: boolean): Sprite {
  return cache.get(`r:${mask}:${bridge ? 1 : 0}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRoad(r, mask, bridge);
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

function paintRail(r: Raster, mask: number, bridge: boolean, dy = 0, withBallast = true): void {
  const alongX = (mask & (DIR_E | DIR_W)) !== 0;
  const alongY = (mask & (DIR_N | DIR_S)) !== 0;
  if (withBallast) {
    forEachDiamondPixel((x, y, u, v) => {
      if (inBand(u, v, 0.2, mask)) {
        const n = hash2(mask + 500, x, y);
        r.set(x, y + dy, bridge ? PAL.concreteDark : n < 0.15 ? shade(PAL.ballast, 0.85) : PAL.ballast);
      } else if (!bridge) {
        const n = hash2(99, x, y);
        r.set(x, y + dy, n < 0.09 ? PAL.grassDark : n < 0.15 ? PAL.grassLight : PAL.grass);
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

export function railSprite(mask: number, bridge: boolean): Sprite {
  return cache.get(`rl:${mask}:${bridge ? 1 : 0}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRail(r, mask, bridge);
    return toSprite(r, 0, 0);
  });
}

export function crossingSprite(railMask: number, roadMask: number): Sprite {
  return cache.get(`x:${railMask}:${roadMask}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRoad(r, roadMask, false);
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
export function stationSprite(plazaDir: number): { base: Sprite; emissive: Sprite | null } {
  return pairCache.get(`st:${plazaDir}`, () => {
    const DY = 10;
    const r = new Raster(TILE_W, TILE_H + DY);
    const e = new Raster(TILE_W, TILE_H + DY);
    paintRail(r, DIR_E | DIR_W, false, DY);
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

const FLOOR_H = [0, 7, 6, 6, 6] as const;
const FOOTPRINT = [0, 20, 28, 30, 32] as const;
const TOTAL_FLOORS = [0, 1, 2, 5, 10] as const;

/** 建物スプライト (壁・屋根のみ、地面は別)。oy = 高さ - 16。 */
export function buildingSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const key = `b:${spec.level}:${spec.style}:${spec.floors}:${spec.state}:${spec.lights}`;
  return pairCache.get(key, () => {
    const level = spec.level;
    const fh = FLOOR_H[level];
    const fw = FOOTPRINT[level];
    const total = TOTAL_FLOORS[level];
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
    const windowRows = level === 1 ? 2 : fh - 3;
    const windowTop = level === 1 ? 2 : 1;

    for (let x = x0; x < x1; x++) {
      const [ytR, ybR] = diamondRows(x, fw);
      const yt = ytR + baseTop;
      const yb = ybR + baseTop;
      const left = x < HALF_W;
      const along = left ? x - x0 : x1 - 1 - x;
      const wc = left ? wallL : wallR;
      // 壁
      for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, wc);
      // 窓
      const windowCol = level === 4 ? along % 3 !== 0 : along % 4 === 1 || along % 4 === 2;
      if (windowCol && along < fw / 2 - 2) {
        for (let f = 0; f < floors; f++) {
          const fTop = yb - (f + 1) * fh + 1;
          const lit = !abandoned && !constructing && hash3(spec.lights, f, along >> 2, left ? 1 : 2) < (level === 1 ? 0.5 : 0.62);
          const boarded = abandoned && hash3(st, f, along >> 2, 7) < 0.5;
          const warm = hash3(spec.lights, f, along >> 2, 3) < 0.7;
          for (let wy = windowTop; wy < windowTop + windowRows; wy++) {
            const y = fTop + wy;
            r.set(x, y, boarded ? shade(PAL.dirtDark, 0.8) : abandoned ? [60, 60, 64] : shade(PAL.windowDay, left ? 1 : 0.8));
            if (lit) {
              e.set(x, y, warm ? PAL.windowLitWarm : level === 4 ? PAL.windowLitCool : PAL.windowLit);
              anyLight = true;
            }
          }
        }
      }
      // 玄関 (左壁の1階)
      if (left && (along === 2 || along === 3) && floors > 0 && level <= 3) {
        for (let y = yb - 3; y <= yb; y++) r.set(x, y, shade(wc, 0.5));
        if (!abandoned && !constructing && along === 2) {
          e.set(x, yb - 3, PAL.windowLitWarm);
          anyLight = true;
        }
      }
      // 看板 (商店)
      if (level === 2 && !left && floors === total && along >= 1 && along < fw / 2 - 3) {
        const top = yb - wallH + 1;
        r.set(x, top + 1, sign);
        r.set(x, top + 2, shade(sign, 0.8));
      }
      // 屋根
      if (level === 1) {
        // 切妻屋根: 棟は東西方向。列ごとに連続して塗る (持ち上げ量の差で穴が開かないように)
        const ridgeH = 4;
        let last = -1;
        for (let y = yt - wallH; y <= yb - wallH; y++) {
          const A = (x + 0.5 - HALF_W) / (fw / 2);
          const B = (y + 0.5 - baseTop - HALF_H + wallH) / (fw / 4) + 1;
          const v = (B - A) / 2;
          const eh = Math.round(ridgeH * (1 - Math.abs(2 * v - 1)));
          const target = y - eh;
          const color = v < 0.5 ? roofLight : shade(roof, 0.8);
          if (last >= 0) {
            const lo = Math.min(last + 1, target);
            const hi = Math.max(last - 1, target);
            for (let yy = lo; yy <= hi; yy++) r.set(x, yy, color);
          }
          r.set(x, target, color);
          last = target;
        }
        // 軒先の線
        r.set(x, yb - wallH + 1, shade(roof, 0.6));
      } else {
        for (let y = yt - wallH; y <= yb - wallH; y++) {
          const edge = y === yt - wallH || y === yb - wallH;
          r.set(x, y, edge ? shade(roof, 0.75) : y === yt - wallH + 1 ? roofLight : roof);
        }
      }
      // 壁の角の線
      if (x === HALF_W && wallH > 0) r.vline(x, yb - wallH + 1, yb, shade(wallR, 0.85));
    }

    // 煙突 (家)
    if (level === 1 && !constructing) {
      const cx = x0 + 5;
      const [, ybR] = diamondRows(cx, fw);
      const top = ybR + baseTop - wallH - 6;
      r.fillRect(cx, top, 2, 4, [150, 90, 80]);
      r.hline(cx, cx + 1, top, [110, 70, 60]);
    }
    // 屋上設備 (中層)・アンテナ (高層)
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
    // 建設中: 足場とクレーン
    if (constructing && floors < total) {
      for (let x = x0; x < x1; x++) {
        const [, ybR] = diamondRows(x, fw);
        const yb = ybR + baseTop;
        const top = yb - (floors + 1) * fh + 1;
        for (let y = top; y <= yb - floors * fh; y++) {
          const along = x < HALF_W ? x - x0 : x1 - 1 - x;
          if (along % 3 === 0 || (y - top) % 3 === 0) r.set(x, y, PAL.scaffold);
        }
      }
      if (level >= 2) {
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
        anyLight = true;
      }
    }
    return { base: toSprite(r, 0, baseTop), emissive: anyLight ? toSprite(e, 0, baseTop) : null };
  });
}

function drawRoofBox(r: Raster, roofBaseTop: number, fw: number, h: number, wl: RGB, wr: RGB, top: RGB): void {
  const x0 = HALF_W - fw / 2;
  const x1 = HALF_W + fw / 2;
  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = diamondRows(x, fw);
    const yt = ytR + roofBaseTop;
    const yb = ybR + roofBaseTop;
    for (let y = yb - h + 1; y <= yb; y++) r.set(x, y, x < HALF_W ? wl : wr);
    for (let y = yt - h; y <= yb - h; y++) r.set(x, y, top);
  }
}

export const BUILDING_TOTAL_FLOORS = TOTAL_FLOORS;
