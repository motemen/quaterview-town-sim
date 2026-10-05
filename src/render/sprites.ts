import { hash2, hash3 } from "../sim/rng";
import { buildingFloors, isMixedUse } from "../sim/growth";
import { DIR_E, DIR_N, DIR_S, DIR_W, BState, R8_BIT, R8_E, R8_W, railIsStraightX } from "../sim/world";
import { HALF_H, HALF_W, TILE_H, TILE_W, diamondRows, pixelToUV, uvToPixel } from "./iso";
import { PAL, ROOFS, SIGNS, TOWER_WALLS, WALLS } from "./palette";
import { RGB, Raster, Sprite, SpriteCache, atlas, currentSpriteFrame, mix, shade, toSprite } from "./raster";

const cache = new SpriteCache<Sprite>();
const pairCache = new SpriteCache<{ base: Sprite; emissive: Sprite | null }>();

/** すべてのスプライトを捨てる (アトラスも空にする)。描画の合間に呼ぶこと。 */
export function clearSpriteCache(): void {
  cache.clear();
  pairCache.clear();
  atlas.reset();
}

/** この何フレーム以内に使ったスプライトを compact で残すか */
const KEEP_FRAMES = 90;

/**
 * アトラスが埋まりそうなら、最近使ったスプライトだけを残して詰め直す。
 * 毎フレームの頭で呼ぶ。"cleared" を返したときは全部作り直したので、
 * 呼び出し側は静的レイヤーを描き直す必要がある。
 */
export function maintainSpriteAtlas(): "ok" | "compacted" | "cleared" {
  if (!atlas.nearlyFull) return "ok";
  if (atlas.overflowed) {
    clearSpriteCache();
    return "cleared";
  }
  const since = currentSpriteFrame() - KEEP_FRAMES;
  const keep = new Set<Sprite>();
  cache.prune((s) => {
    if (s.used < since) return false;
    keep.add(s);
    return true;
  });
  pairCache.prune((p) => {
    const recent = p.base.used >= since || (p.emissive !== null && p.emissive.used >= since);
    if (!recent) return false;
    keep.add(p.base);
    if (p.emissive) keep.add(p.emissive);
    return true;
  });
  if (atlas.compact(keep)) return "compacted";
  clearSpriteCache();
  return "cleared";
}

export type GroundKind = "grass" | "lot" | "park" | "concrete" | "water" | "sand" | "rubble" | "paddy" | "field" | "flower" | "orchard" | "farmpath";

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
  flower: [[164, 128, 88], [136, 104, 68], [240, 160, 180]],
  orchard: [[120, 168, 92], [96, 140, 76], [140, 184, 108]],
  farmpath: [[196, 176, 136], [168, 148, 108], [212, 196, 160]],
};

/** 田畑の [地, 畝の影, 作物] の色 */
function farmColors(kind: "paddy" | "field" | "flower", season: SeasonTint): [RGB, RGB, RGB] {
  if (kind === "flower") {
    if (season === 3) return [[212, 208, 200], [180, 172, 160], [236, 234, 230]];
    if (season === 2) return [[164, 128, 88], [136, 104, 68], [232, 200, 72]]; // コスモス・菊
    if (season === 1) return [[156, 120, 80], [128, 96, 60], [255, 212, 64]]; // ひまわり
    return [[164, 128, 88], [136, 104, 68], [240, 150, 180]]; // 春の花
  }
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
 * スプライトは 32x32 で、タイル原点の 16px 上から始まる (oy = 16)。対角の頂点は 2 段差があり得る。
 */
export type SeasonTint = 0 | 1 | 2 | 3; // 0=春/夏 1=夏 2=秋 3=冬

function seasonalGround(kind: GroundKind, season: SeasonTint): [RGB, RGB, RGB] {
  const base = GROUND_COLORS[kind];
  if (kind === "water" || kind === "concrete" || kind === "rubble" || kind === "farmpath") return base;
  if (kind === "orchard") {
    if (season === 3) return [[226, 232, 238], [204, 212, 222], [242, 246, 250]];
    if (season === 2) return [mix(base[0], [170, 150, 70], 0.3), mix(base[1], [140, 120, 60], 0.3), mix(base[2], [200, 180, 90], 0.3)];
    return base;
  }
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
    const TOP = 16;
    const r = new Raster(TILE_W, TILE_H + TOP);
    const [rT, rR, rB, rL] = rel;
    const Ty = TOP - rT * 8;
    const Ry = TOP + 8 - rR * 8;
    const By = TOP + 16 - rB * 8;
    const Ly = TOP + 8 - rL * 8;
    const dzdx = (rR + rB - rT - rL) / 2;
    const dzdy = (rB + rL - rT - rR) / 2;
    const bright = kind === "water" ? 1 : 1 + 0.22 * dzdx + 0.12 * dzdy;
    const [base, dark, light] = seasonalGround(kind, season).map((c) => shade(c, bright)) as [RGB, RGB, RGB];
    const farm = kind === "paddy" || kind === "field" || kind === "flower" ? farmColors(kind, season) : null;
    // 田畑: variant = 畝の向き (bit0) | 区画の縁 (bit1..4: N,E,S,W)
    const farmAlongX = (variant & 1) !== 0;
    const edgeMask = (variant >> 1) & 15;
    // 野原: variant = 種類 (bit3..4: 0=ふつう 1=灌木 2=草花 3=枯れ草) | 模様 (bit0..2)
    const meadow = kind === "grass" ? (variant >> 3) & 3 : 0;
    const dry: RGB = season === 3 ? base : mix(base, [196, 188, 96], 0.35);
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
          const [u, v] = pixelToUV(x + 0.5, y - TOP + 0.5);
          const along = farmAlongX ? v : u;
          const phase = (along * 7) % 1;
          const onEdge = (v < 0.08 && edgeMask & 1) || (u > 0.93 && edgeMask & 2) || (v > 0.93 && edgeMask & 4) || (u < 0.08 && edgeMask & 8);
          if (onEdge) c = season === 3 ? [190, 186, 176] : ([128, 108, 76] as RGB);
          else if (kind === "flower") {
            // 花は点々と
            if (phase < 0.5 && n < 0.55) c = n < 0.2 ? shade(farm[2], 1.15) : farm[2];
            else if (phase < 0.5) c = [96, 150, 72];
            else c = phase < 0.65 ? farm[1] : farm[0];
            if (season === 3) c = n < 0.5 ? farm[2] : farm[0];
          } else if (phase < 0.45) c = farm[2];
          else if (phase < 0.6) c = farm[1];
          else c = farm[0];
          if (season === 3 && kind === "field" && n < 0.5) c = farm[2];
        } else if (kind === "farmpath") {
          // 草地の中の細い土の道 (轍が 2 本)
          const [u, v] = pixelToUV(x + 0.5, y - TOP + 0.5);
          const alongX = (variant & 1) !== 0;
          const across = alongX ? v : u;
          const g = seasonalGround("grass", season);
          const inPath = Math.abs(across - 0.5) < 0.22;
          const rut = Math.abs(across - 0.4) < 0.045 || Math.abs(across - 0.6) < 0.045;
          if (!inPath) c = n < 0.09 ? g[1] : n < 0.15 ? g[2] : g[0];
          else if (rut) c = n < 0.3 ? mix(base, g[0], 0.4) : dark;
          else c = n < 0.35 ? mix(base, g[0], 0.5) : base;
          if (season === 3 && n < 0.6 && !rut) c = [226, 232, 238];
        } else if (kind === "grass" && meadow === 1) {
          // 灌木の茂み
          if (n < 0.16) c = [60, 112, 52];
          else if (n < 0.22) c = dark;
          else if (n < 0.26) c = light;
        } else if (kind === "grass" && meadow === 2) {
          // 草花 (まばらに)
          if (n < 0.018) c = season === 3 ? light : season === 2 ? [232, 200, 96] : [250, 250, 230];
          else if (n < 0.03) c = season === 3 ? light : [240, 176, 200];
          else if (n < 0.12) c = dark;
          else if (n < 0.16) c = light;
        } else if (kind === "grass" && meadow === 3) {
          // 枯れ草まじりの野原
          c = n < 0.1 ? shade(dry, 0.88) : n < 0.18 ? shade(dry, 1.08) : dry;
        } else if (kind === "orchard") {
          if (n < 0.06) c = dark;
        } else {
          if (n < 0.09) c = dark;
          else if (n < 0.15) c = light;
        }
        r.set(x, y, c);
      }
    }
    if (kind === "park" && season !== 3) {
      // 小道
      lineUV(r, 0.5, 0.0, 0.5, 1.0, shade(PAL.sand, 0.95), TOP);
      lineUV(r, 0.0, 0.5, 1.0, 0.5, shade(PAL.sand, 0.95), TOP);
    }
    return toSprite(r, 0, TOP);
  });
}

// ---------------------------------------------------------------------------
// 木

/** 木の形: 0=丸い広葉樹 1=針葉樹 (常緑) 2=細長い木 (ポプラ) 3=横に広い木 */
export const TREE_CONIFER = 1;

/**
 * 木の形を決める。evergreen なら針葉樹、そうでなければ落葉樹のどれか。
 * 常緑樹と落葉樹が混ざりすぎないよう、どちらにするかは呼び出し側が場所のノイズで決める。
 */
export function treeShape(variant: number, evergreen: boolean): number {
  if (evergreen) return TREE_CONIFER;
  return [0, 0, 2, 0, 0, 3, 0, 0][((variant % 8) + 8) % 8];
}

const EVERGREEN: RGB = [36, 92, 60];
const EVERGREEN_LIGHT: RGB = [64, 128, 84];
const EVERGREEN_DARK: RGB = [24, 68, 44];

/**
 * 木。基部中央が原点 (ox=5, oy=15)。tint: 0=緑 1=桜 2=紅葉 3=雪。
 * 形は variant で決まり、針葉樹は季節で色を変えない (雪だけかぶる)。
 */
export function treeSprite(variant: number, tint = 0, shape = treeShape(variant, false)): Sprite {
  if (shape === TREE_CONIFER && tint !== 3) tint = 0;
  const key = `t:${shape}:${variant % 3}:${tint}`;
  return cache.get(key, () => {
    const r = new Raster(11, 16);
    const big = variant % 3 === 0;
    const canopy = tint === 1 ? ([240, 184, 200] as RGB) : tint === 2 ? ([208, 128, 56] as RGB) : tint === 3 ? ([236, 240, 246] as RGB) : PAL.canopy;
    const canopyLight = tint === 0 ? PAL.canopyLight : tint === 3 ? ([252, 252, 255] as RGB) : shade(canopy, 1.12);
    const canopyDark = tint === 0 ? PAL.canopyDark : tint === 3 ? ([120, 140, 120] as RGB) : shade(canopy, 0.78);
    const shadeBelow = (cy: number, dark: RGB) => {
      for (let x = 0; x < r.w; x++) {
        for (let y = 0; y < r.h; y++) {
          if (r.alpha(x, y) && y > cy + 1 && y < 12 && hash2(variant, x, y) < 0.6) r.set(x, y, dark);
        }
      }
    };
    if (shape === 1) {
      // 針葉樹: 三角形。左側を明るく、雪は各段の左上に
      const top = big ? 1 : 3;
      const bottom = 12;
      r.vline(5, 12, 15, PAL.trunk);
      for (let y = top; y <= bottom; y++) {
        const t = (y - top) / (bottom - top);
        const hw = Math.round(t * (big ? 4 : 3.4));
        for (let x = 5 - hw; x <= 5 + hw; x++) r.set(x, y, x < 5 ? EVERGREEN_LIGHT : x === 5 ? EVERGREEN : EVERGREEN_DARK);
        // 段の縁 (枝先) は少し暗く
        if (hw > 0 && (y - top) % 3 === 2) {
          r.set(5 - hw, y, EVERGREEN_DARK);
          r.set(5 + hw, y, EVERGREEN_DARK);
        }
        if (tint === 3 && hw > 0 && (y - top) % 3 === 0) {
          for (let x = 5 - hw; x <= 5 + hw - 1; x++) if (hash2(variant, x, y) < 0.7) r.set(x, y, canopy);
        }
      }
      if (tint === 3) r.set(5, top, canopy);
      return toSprite(r, 5, 15);
    }
    if (shape === 2) {
      // ポプラ: 細長い楕円
      r.vline(5, 12, 15, PAL.trunk);
      const top = big ? 0 : 2;
      const bottom = 12;
      for (let y = top; y <= bottom; y++) {
        const t = (y - top) / (bottom - top);
        const hw = Math.sin(t * Math.PI) * 2.3;
        for (let x = Math.round(5 - hw); x <= Math.round(5 + hw); x++) r.set(x, y, x <= 4 && y < 8 ? canopyLight : canopy);
      }
      shadeBelow(7, canopyDark);
      return toSprite(r, 5, 15);
    }
    if (shape === 3) {
      // 横に広い木: 低い幹に丸を 3 つ重ねる
      r.vline(5, 11, 15, PAL.trunk);
      r.vline(4, 13, 15, PAL.trunk);
      r.disc(3, 9.5, 3, canopy);
      r.disc(8, 9.5, 3, canopy);
      r.disc(5.5, 7.5, 3.4, canopy);
      r.disc(4.5, 6.5, 2, canopyLight);
      shadeBelow(8, canopyDark);
      return toSprite(r, 5, 15);
    }
    // 丸い広葉樹 (従来)
    r.vline(5, 12, 15, PAL.trunk);
    const rad = big ? 3.6 : 3;
    const cy = big ? 9 : 10;
    r.disc(5.5, cy, rad, canopy);
    r.disc(4.5, cy - 1, rad * 0.6, canopyLight);
    shadeBelow(cy, canopyDark);
    return toSprite(r, 5, 15);
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

/** 果樹 (小さい丸い木)。基部中央が原点 (ox=3, oy=7)。 */
export function orchardTreeSprite(season: SeasonTint): Sprite {
  return cache.get(`ot:${season}`, () => {
    const r = new Raster(7, 8);
    const canopy: RGB = season === 3 ? [236, 240, 246] : season === 2 ? [184, 120, 56] : season === 0 ? [228, 176, 196] : [64, 136, 64];
    r.vline(3, 5, 7, PAL.trunk);
    r.disc(3.5, 3.5, 2.6, canopy);
    r.set(3, 2, shade(canopy, 1.15));
    if (season === 1) {
      r.set(2, 4, [232, 96, 72]);
      r.set(5, 3, [232, 96, 72]);
    }
    return toSprite(r, 3, 7);
  });
}

/** 神社: 鳥居と社殿。32x44 (oy=28)。 */
export function shrineSprite(season: SeasonTint): { base: Sprite; emissive: Sprite | null } {
  return pairCache.get(`shrine:${season}`, () => {
    const DY = 28;
    const r = new Raster(TILE_W, TILE_H + DY);
    const e = new Raster(TILE_W, TILE_H + DY);
    const gravel: RGB = season === 3 ? [226, 232, 238] : [208, 204, 192];
    forEachDiamondPixel((x, y, u, v) => {
      const n = hash2(31, x, y);
      const path = Math.abs(u - 0.5) < 0.12;
      let c: RGB = path ? gravel : grassPixel(x, y, season);
      if (path && n < 0.1) c = shade(gravel, 0.9);
      r.set(x, y + DY, c);
    });
    const red: RGB = [200, 56, 48];
    const redDark: RGB = [150, 40, 36];
    // 鳥居 (手前、参道の入口)
    {
      const [px, py] = uvToPixel(0.5, 0.9);
      const gx = Math.floor(px);
      const gy = Math.floor(py) + DY;
      r.vline(gx - 4, gy - 12, gy, red);
      r.vline(gx + 3, gy - 12, gy, redDark);
      r.hline(gx - 6, gx + 5, gy - 12, red);
      r.hline(gx - 6, gx + 5, gy - 13, redDark);
      r.hline(gx - 5, gx + 4, gy - 9, red);
    }
    // 社殿 (奥): 木の壁と緑の屋根
    {
      const wall: RGB = [164, 120, 84];
      const wallR = shade(wall, 0.72);
      const roof: RGB = [72, 112, 96];
      const fw = 16;
      const x0 = HALF_W - fw / 2;
      const x1 = HALF_W + fw / 2;
      const baseTop = DY - 8; // 奥寄りに置く
      const wallH = 7;
      for (let x = x0; x < x1; x++) {
        const [ytR, ybR] = diamondRows(x, fw);
        const yt = ytR + baseTop;
        const yb = ybR + baseTop;
        const left = x < HALF_W;
        for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, left ? wall : wallR);
        // 入口と灯籠の明かり
        if (left && (x === HALF_W - 3 || x === HALF_W - 2)) {
          for (let y = yb - 4; y <= yb; y++) r.set(x, y, shade(wall, 0.45));
          e.set(x, yb - 4, PAL.windowLitWarm);
        }
        // 反りのある屋根
        let last = -1;
        for (let y = yt - wallH - 1; y <= yb - wallH; y++) {
          const A = (x + 0.5 - HALF_W) / (fw / 2);
          const B = (y + 0.5 - baseTop - HALF_H + wallH) / (fw / 4) + 1;
          const v = (B - A) / 2;
          const eh = Math.round(5 * (1 - Math.abs(2 * v - 1)));
          const target = y - eh;
          const color = v < 0.5 ? shade(roof, 1.15) : shade(roof, 0.8);
          if (last >= 0) for (let yy = Math.min(last + 1, target); yy <= Math.max(last - 1, target); yy++) r.set(x, yy, color);
          r.set(x, target, color);
          last = target;
        }
        r.set(x, yb - wallH + 1, shade(roof, 0.6));
      }
      // 千木
      r.vline(HALF_W - 1, baseTop - wallH - 7, baseTop - wallH - 4, [220, 200, 160]);
      r.vline(HALF_W + 1, baseTop - wallH - 7, baseTop - wallH - 4, [220, 200, 160]);
    }
    // 灯籠
    for (const u of [0.32, 0.68]) {
      const [px, py] = uvToPixel(u, 0.7);
      const lx = Math.floor(px);
      const ly = Math.floor(py) + DY;
      r.vline(lx, ly - 5, ly, PAL.concreteDark);
      r.fillRect(lx - 1, ly - 7, 3, 2, PAL.concrete);
      r.set(lx, ly - 6, [255, 220, 140]);
      e.set(lx, ly - 6, PAL.windowLitWarm);
    }
    return { base: toSprite(r, 0, DY), emissive: toSprite(e, 0, DY) };
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
    if (!bridge) {
      const r = new Raster(TILE_W, TILE_H);
      paintRoad(r, mask, false, 0, season);
      return toSprite(r, 0, 0);
    }
    // 橋: 少し持ち上げた桁、欄干、橋脚
    const lift = 3;
    const DY = lift + 6;
    const r = new Raster(TILE_W, TILE_H + DY);
    const alongX = (mask & (DIR_E | DIR_W)) !== 0;
    const pier: RGB = [112, 112, 108];
    for (const t of [0.2, 0.8]) {
      for (const side of [-0.2, 0.2]) {
        const [px, py] = alongX ? uvToPixel(t, 0.5 + side) : uvToPixel(0.5 + side, t);
        r.vline(Math.floor(px), Math.floor(py) + DY - lift, Math.floor(py) + DY + 1, pier);
      }
    }
    forEachDiamondPixel((x, y, u, v) => {
      if (inBand(u, v, ROAD_HW, mask)) r.set(x, y + DY - lift, hash2(mask, x, y) < 0.05 ? PAL.roadDark : PAL.road);
      else if (inBand(u, v, WALK_HW, mask)) r.set(x, y + DY - lift, PAL.concreteDark);
    });
    // 欄干
    const rail: RGB = [220, 220, 212];
    const railDark: RGB = [168, 168, 160];
    for (const side of [-WALK_HW, WALK_HW]) {
      for (let t = 0; t <= 1; t += 1 / 48) {
        const [px, py] = alongX ? uvToPixel(t, 0.5 + side) : uvToPixel(0.5 + side, t);
        const gx = Math.floor(px);
        const gy = Math.floor(py) + DY - lift;
        r.set(gx, gy - 3, side < 0 ? rail : railDark);
        const k = t * 6;
        if (Math.abs(k - Math.round(k)) < 0.05) r.vline(gx, gy - 3, gy - 1, railDark);
      }
    }
    return toSprite(r, 0, DY);
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

/** 8 方向の接続先 (uv 座標): 辺の中点または角 */
const RAIL_ENDS: [number, number][] = [
  [0.5, 0], // N
  [1, 0], // NE
  [1, 0.5], // E
  [1, 1], // SE
  [0.5, 1], // S
  [0, 1], // SW
  [0, 0.5], // W
  [0, 0], // NW
];

function railSegments(mask: number): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  for (let d = 0; d < 8; d++) {
    if (mask & R8_BIT[d]) segs.push([0.5, 0.5, RAIL_ENDS[d][0], RAIL_ENDS[d][1]]);
  }
  if (segs.length === 0) segs.push([0, 0.5, 1, 0.5]);
  return segs;
}

function distToSegment(u: number, v: number, s: [number, number, number, number]): number {
  const [u0, v0, u1, v1] = s;
  const du = u1 - u0;
  const dv = v1 - v0;
  const len2 = du * du + dv * dv;
  let t = len2 > 0 ? ((u - u0) * du + (v - v0) * dv) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = u0 + du * t - u;
  const py = v0 + dv * t - v;
  return Math.sqrt(px * px + py * py);
}

/** 線路 (任意の方向の組み合わせ) を描く */
function paintRail(r: Raster, mask: number, bridge: boolean, dy = 0, withBallast = true, season: SeasonTint = 0): void {
  const segs = railSegments(mask);
  if (withBallast) {
    forEachDiamondPixel((x, y, u, v) => {
      let dmin = 9;
      for (const sg of segs) dmin = Math.min(dmin, distToSegment(u, v, sg));
      if (dmin <= 0.2) {
        const n = hash2(mask + 500, x, y);
        r.set(x, y + dy, bridge ? PAL.concreteDark : n < 0.15 ? shade(PAL.ballast, 0.85) : PAL.ballast);
      } else if (!bridge) {
        r.set(x, y + dy, grassPixel(x, y, season));
      }
    });
  }
  // 枕木 (線分に直交)
  for (const [u0, v0, u1, v1] of segs) {
    const du = u1 - u0;
    const dv = v1 - v0;
    const len = Math.hypot(du, dv);
    const nu = -dv / len;
    const nv = du / len;
    for (let t = 0.08; t < 1; t += 0.16 / len) {
      const u = u0 + du * t;
      const v = v0 + dv * t;
      lineUV(r, u - nu * 0.13, v - nv * 0.13, u + nu * 0.13, v + nv * 0.13, PAL.sleeper, dy);
    }
  }
  // レール
  for (const [u0, v0, u1, v1] of segs) {
    const du = u1 - u0;
    const dv = v1 - v0;
    const len = Math.hypot(du, dv);
    const nu = -dv / len;
    const nv = du / len;
    for (const off of [-0.08, 0.08]) {
      lineUV(r, u0 + nu * off, v0 + nv * off, u1 + nu * off, v1 + nv * off, PAL.rail, dy);
    }
  }
}

export function railSprite(mask: number, bridge: boolean, season: SeasonTint = 0, lift = 0): Sprite {
  return cache.get(`rl:${mask}:${bridge ? 1 : 0}:${season}:${lift}`, () => {
    if (!bridge) {
      const r = new Raster(TILE_W, TILE_H);
      paintRail(r, mask, bridge, 0, true, season);
      return toSprite(r, 0, 0);
    }
    // 鉄橋: 桁を線路の高さ (lift) に置き、橋脚と側桁 (トラス) を描く
    const DY = lift + 8;
    const r = new Raster(TILE_W, TILE_H + DY);
    const alongX = (mask & (R8_E | R8_W)) !== 0;
    const steel: RGB = [150, 64, 52];
    const steelDark: RGB = [104, 44, 36];
    const pier: RGB = [120, 120, 112];
    const pierDark: RGB = [92, 92, 86];
    // 橋脚 (桁の下、水面まで)
    if (lift > 0) {
      for (const t of [0.22, 0.78]) {
        for (const side of [-0.14, 0.14]) {
          const [px, py] = alongX ? uvToPixel(t, 0.5 + side) : uvToPixel(0.5 + side, t);
          const gx = Math.floor(px);
          const gy = Math.floor(py) + DY;
          r.vline(gx, gy - lift, gy + 1, side < 0 ? pier : pierDark);
          r.vline(gx + 1, gy - lift, gy + 1, pierDark);
        }
      }
    }
    // 桁 (デッキ)
    forEachDiamondPixel((x, y, u, v) => {
      const segs = railSegments(mask);
      let dmin = 9;
      for (const sg of segs) dmin = Math.min(dmin, distToSegment(u, v, sg));
      if (dmin <= 0.24) r.set(x, y + DY - lift, hash2(mask + 7, x, y) < 0.1 ? shade(PAL.concreteDark, 0.9) : PAL.concreteDark);
    });
    paintRail(r, mask, true, DY - lift, false, season);
    // 側桁: 両側に低いトラス
    for (const side of [-0.25, 0.25]) {
      for (let t = 0; t <= 1; t += 1 / 48) {
        const [px, py] = alongX ? uvToPixel(t, 0.5 + side) : uvToPixel(0.5 + side, t);
        const gx = Math.floor(px);
        const gy = Math.floor(py) + DY - lift;
        r.set(gx, gy - 4, steel);
        r.set(gx, gy, steelDark);
        const k = Math.floor(t * 8);
        if (Math.abs(t * 8 - k) < 0.03) r.vline(gx, gy - 4, gy, side < 0 ? steelDark : steel);
        else if ((t * 8) % 1 > 0.45 && (t * 8) % 1 < 0.55) r.set(gx, gy - 2, steel);
      }
    }
    return toSprite(r, 0, DY);
  });
}

export function crossingSprite(railMask: number, roadMask: number, season: SeasonTint = 0): Sprite {
  return cache.get(`x:${railMask}:${roadMask}:${season}`, () => {
    const r = new Raster(TILE_W, TILE_H);
    paintRoad(r, roadMask, false, 0, season);
    paintRail(r, railMask, false, 0, false);
    // 踏切の縞模様
    const alongX = railIsStraightX(railMask);
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

/**
 * 駅: 線路 + ホーム + 屋根。size で駅舎が大きくなる (0=ホームだけ 1=駅舎 2=橋上駅舎)。
 * plazaDir が 1/3 (東/西) のときは南北の線路。
 */
export function stationSprite(plazaDir: number, season: SeasonTint = 0, railMask = 0, size = 0): { base: Sprite; emissive: Sprite | null } {
  return pairCache.get(`st:${plazaDir}:${season}:${railMask}:${size}`, () => {
    const DY = size >= 2 ? 34 : size === 1 ? 22 : 10;
    const r = new Raster(TILE_W, TILE_H + DY);
    const e = new Raster(TILE_W, TILE_H + DY);
    const vertical = plazaDir === 1 || plazaDir === 3;
    paintRail(r, railMask || (vertical ? R8_BIT[0] | R8_BIT[4] : R8_E | R8_W), false, DY, true, season);
    // across: 広場側へ向かう座標 (0 = 線路の反対側, 1 = 広場側)、along: 線路に沿った座標
    const toLocal = (u: number, v: number): [number, number] => {
      if (plazaDir === 2) return [u, v];
      if (plazaDir === 0) return [u, 1 - v];
      if (plazaDir === 1) return [v, u];
      return [v, 1 - u];
    };
    const fromLocal = (along: number, across: number): [number, number] => {
      if (plazaDir === 2) return [along, across];
      if (plazaDir === 0) return [along, 1 - across];
      if (plazaDir === 1) return [across, along];
      return [1 - across, along];
    };
    forEachDiamondPixel((x, y, u, v) => {
      const [along, across] = toLocal(u, v);
      if (across >= 0.66 && along > 0.02 && along < 0.98) {
        r.set(x, y + DY, across < 0.7 ? PAL.concreteDark : PAL.platform);
      }
    });
    const ROOF = 9;
    const wall: RGB = [226, 222, 208];
    const wallDark = shade(wall, 0.72);
    const stationRoof: RGB = size >= 2 ? [120, 132, 160] : [150, 92, 76];
    /** ローカル座標の矩形を高さ h の箱にする (uv → ピクセル)。足元の行は across/along で決まる */
    const localBox = (a0: number, a1: number, c0: number, c1: number, lift: number, h: number, roof: RGB, windows: boolean) => {
      const cells: [number, number, number, number][] = [];
      forEachDiamondPixel((x, y, u, v) => {
        const [along, across] = toLocal(u, v);
        if (along >= a0 && along <= a1 && across >= c0 && across <= c1) cells.push([x, y + DY - lift, along, across]);
      });
      // 画面の下側の縁にある画素だけ壁になる: 同じ x で最大の y
      const bottomAt = new Map<number, number>();
      for (const [x, y] of cells) bottomAt.set(x, Math.max(bottomAt.get(x) ?? -1, y));
      let minX = 99;
      let maxX = -1;
      for (const [x] of cells) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      const midX = (minX + maxX) / 2;
      for (const [x, yb] of bottomAt) {
        const left = x < midX;
        for (let k = 1; k <= h; k++) {
          const y = yb - k + 1;
          let c: RGB = left ? wall : wallDark;
          const colInWall = left ? x - minX : maxX - x;
          if (windows && k >= 3 && k <= h - 3 && colInWall % 3 === 1 && colInWall > 0) {
            c = shade(PAL.windowDay, left ? 1 : 0.85);
            e.set(x, y, PAL.windowLitWarm);
          }
          r.set(x, y, c);
        }
      }
      for (const [x, y] of cells) {
        const yr = y - h;
        const edge = !cells.some(([cx, cy]) => cx === x && cy === y + 1) || x === minX || x === maxX;
        r.set(x, yr, edge ? shade(roof, 0.8) : roof);
      }
      // 高架の柱
      if (lift > 0) {
        for (const x of [minX + 1, maxX - 1]) {
          const yb = bottomAt.get(x) ?? 0;
          for (let y = yb + 1; y <= yb + lift; y++) r.set(x, y, PAL.concreteDark);
        }
      }
    };
    if (size === 0) {
      // ホームの屋根
      forEachDiamondPixel((x, y, u, v) => {
        const [along, across] = toLocal(u, v);
        if (across >= 0.7 && across <= 0.96 && along >= 0.1 && along <= 0.9) {
          const edge = across > 0.94 || across < 0.72 || along < 0.12 || along > 0.88;
          r.set(x, y + DY - ROOF, edge ? shade(PAL.roofStation, 0.8) : PAL.roofStation);
        }
      });
      for (const along of [0.18, 0.5, 0.82]) {
        const [u, v] = fromLocal(along, 0.9);
        const [px, py] = uvToPixel(u, v);
        r.vline(Math.floor(px), Math.floor(py) + DY - ROOF + 1, Math.floor(py) + DY - 1, PAL.concreteDark);
      }
    } else {
      // 駅舎: 広場側の縁に建つ 1 階建て。ホームの屋根はその手前
      forEachDiamondPixel((x, y, u, v) => {
        const [along, across] = toLocal(u, v);
        if (across >= 0.68 && across <= 0.8 && along >= 0.1 && along <= 0.9) {
          const edge = across > 0.78 || across < 0.7 || along < 0.12 || along > 0.88;
          r.set(x, y + DY - 7, edge ? shade(PAL.roofStation, 0.8) : PAL.roofStation);
        }
      });
      localBox(0.1, 0.9, 0.8, 0.98, 0, 11, stationRoof, true);
      // 入口の明かり
      const [u, v] = fromLocal(0.5, 0.98);
      const [px, py] = uvToPixel(u, v);
      e.set(Math.floor(px), Math.floor(py) + DY - 8, PAL.lamp);
      e.set(Math.floor(px) + 1, Math.floor(py) + DY - 8, PAL.lamp);
    }
    if (size >= 2) {
      // 橋上駅舎: 線路をまたぐ高架のコンコース
      localBox(0.3, 0.7, 0.05, 0.95, 13, 10, stationRoof, true);
      // 屋上の看板
      const [u, v] = fromLocal(0.5, 0.5);
      const [px, py] = uvToPixel(u, v);
      const sx = Math.floor(px) - 3;
      const sy = Math.floor(py) + DY - 13 - 10 - 4;
      r.fillRect(sx, sy, 7, 3, [240, 240, 232]);
      r.fillRect(sx + 1, sy + 1, 5, 1, [60, 100, 180]);
      e.fillRect(sx, sy, 7, 3, [255, 255, 240]);
      e.fillRect(sx + 1, sy + 1, 5, 1, [120, 170, 255]);
    }
    // ホームの明かり
    for (const along of [0.32, 0.68]) {
      const [u, v] = fromLocal(along, 0.74);
      const [px, py] = uvToPixel(u, v);
      const lx = Math.floor(px);
      const ly = Math.floor(py) + DY - (size === 0 ? ROOF - 2 : 5);
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

/**
 * 建物の本体と発光をアトラスに置く。本体は lights に依らないので、
 * 同じ建物の別の明かりパターンと共有する (アトラスの消費を抑える)。
 */
function packBuilding(spec: BuildingSpec, r: Raster, e: Raster, ox: number, oy: number, anyLight: boolean): { base: Sprite; emissive: Sprite | null } {
  const base = cache.get(`bb:${spec.level}:${spec.style}:${spec.floors}:${spec.state}`, () => toSprite(r, ox, oy));
  return { base, emissive: anyLight ? toSprite(e, ox, oy) : null };
}

/** 建物スプライト (壁・屋根のみ、地面は別)。oy = 高さ - 16。 */
export function buildingSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const key = `b:${spec.level}:${spec.style}:${spec.floors}:${spec.state}:${spec.lights}`;
  return pairCache.get(key, () => {
    if (spec.level === 1) return houseSprite(spec);
    if (spec.level === 8) return bigTowerSprite(spec);
    if (spec.level === 6) return bigLandmarkTowerSprite(spec);
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
      // 建前: 木の柱と梁
      const top = yb - (floors + 1) * fh + 1;
      const wood: RGB = [184, 140, 92];
      const woodDark: RGB = [140, 100, 64];
      for (let y = top; y <= yb - floors * fh; y++) {
        if (along % 4 === 0 || y === top || y === top + 1) r.set(x, y, left ? wood : woodDark);
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
  return packBuilding(spec, r, e, 0, baseTop, anyLight);
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
  return packBuilding(spec, r, e, 0, baseTop, anyLight);
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
  // レベル 2 の種類: 0=アパート 1=レストラン 2=コンビニ 3=商店
  const shop = level === 2 ? (st >> 4) & 3 : 0;
  let wall: RGB = level === 4 ? TOWER_WALLS[st % TOWER_WALLS.length] : WALLS[st % WALLS.length];
  if (shop === 2) wall = [240, 240, 236];
  if (shop === 1) wall = [236, 224, 200];
  let roof: RGB = level <= 2 ? ROOFS[(st >> 3) % ROOFS.length] : shade(wall, 0.9);
  if (shop === 2) roof = [120, 124, 128];
  const BANDS: RGB[] = [[40, 120, 200], [40, 160, 96], [232, 120, 40], [200, 48, 72]];
  const band: RGB = BANDS[(st >> 6) & 3];
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
    if (level === 2 && !left && floors === total && along >= 1 && along < fw / 2 - 3 && shop !== 2) {
      const top = yb - wallH + 1;
      r.set(x, top + 1, sign);
      r.set(x, top + 2, shade(sign, 0.8));
    }
    if (level === 2 && floors > 0 && along < fw / 2 - 1) {
      const gTop = yb - fh + 1; // 1 階の上端
      if (shop === 1) {
        // レストラン: 赤白のひさしと大きな窓
        if (left && along >= 1) {
          const stripe = along % 2 === 0;
          r.set(x, gTop + 1, stripe ? [220, 60, 50] : [250, 250, 240]);
          r.set(x, gTop + 2, stripe ? [180, 48, 40] : [220, 220, 210]);
          if (along >= 5 && along !== fw / 2 - 2) {
            for (let wy = 3; wy <= 5; wy++) if (putWindow(r, e, x, gTop + wy, shade(PAL.windowDay, 1.1), !abandoned && !constructing ? PAL.windowLitWarm : null)) anyLight = true;
          }
        }
      } else if (shop === 2) {
        // コンビニ: 色の帯と、ガラス張りの明るい 1 階
        const bc = abandoned ? shade(band, 0.5) : band;
        r.set(x, gTop + 1, bc);
        r.set(x, gTop + 2, shade(bc, 0.85));
        if (along >= 1 && along < fw / 2 - 2 && !(left && along >= fw / 2 - 5 && along <= fw / 2 - 4)) {
          for (let wy = 3; wy <= 5; wy++) if (putWindow(r, e, x, gTop + wy, [120, 150, 180], !abandoned && !constructing ? [255, 255, 236] : null)) anyLight = true;
        }
      } else if (shop === 3 && left && along >= 1) {
        // 商店: 単色のひさしとショーウィンドウ
        const ac = abandoned ? shade(band, 0.5) : band;
        r.set(x, gTop + 1, shade(ac, 1.1));
        r.set(x, gTop + 2, ac);
        if (along >= 1 && along < fw / 2 - 5) {
          for (let wy = 3; wy <= 5; wy++) if (putWindow(r, e, x, gTop + wy, shade(PAL.windowDay, 1.15), !abandoned && !constructing && hash2(spec.lights, along >> 2, 9) < 0.8 ? PAL.windowLit : null)) anyLight = true;
        }
      }
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
  return packBuilding(spec, r, e, 0, baseTop, anyLight);
}

/**
 * 2x2 の超高層タワー。幅 64 の菱形 (高さ 32) を底面とし、アンカー (右下のタイル) を基準に描く。
 * ox = 16, oy = 高さ - 32 + 8。
 */
function bigTowerSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const W = 64;
  const CELL = 32;
  const CX = 32;
  const CY = 16;
  const fh = 6;
  const total = buildingFloors(8, spec.style);
  const constructing = spec.state === BState.Constructing;
  const floors = constructing ? spec.floors : total;
  const H = CELL + total * fh + 30;
  const baseTop = H - CELL;
  const r = new Raster(W, H);
  const e = new Raster(W, H);
  let anyLight = false;
  const st = spec.style;
  const wall: RGB = TOWER_WALLS[st % TOWER_WALLS.length];
  const wallL = wall;
  const wallR = shade(wall, 0.72);
  const roof = shade(wall, 0.85);
  const wallH = floors * fh;
  const rows = (x: number): [number, number] => {
    const d = x < CX ? x : W - 1 - x;
    const k = Math.floor(d / 2);
    return [CY - 1 - k, CY + k];
  };
  // 足元の広場
  for (let x = 0; x < W; x++) {
    const [yt, yb] = rows(x);
    for (let y = yt; y <= yb; y++) r.set(x, y + baseTop, hash2(st, x, y) < 0.06 ? PAL.concreteDark : PAL.concrete);
  }
  // 塔は底面より少し小さく (幅 56)
  const fw = 56;
  const x0 = CX - fw / 2;
  const x1 = CX + fw / 2;
  const frows = (x: number): [number, number] => {
    const d = x < CX ? x - x0 : x1 - 1 - x;
    const k = Math.floor(d / 2);
    return [CY - 1 - k, CY + k];
  };
  for (let x = x0; x < x1; x++) {
    const [ytR, ybR] = frows(x);
    const yt = ytR + baseTop;
    const yb = ybR + baseTop;
    const left = x < CX;
    const along = left ? x - x0 : x1 - 1 - x;
    const wc = left ? wallL : wallR;
    for (let y = yb - wallH + 1; y <= yb; y++) r.set(x, y, wc);
    // 窓: 2 列ごとに 1 列の柱
    if (along % 3 !== 0 && along < fw / 2 - 2) {
      for (let f = 0; f < floors; f++) {
        const fTop = yb - (f + 1) * fh + 1;
        const lit = !constructing && hash3(spec.lights, f, along >> 2, left ? 1 : 2) < 0.6;
        const warm = hash3(spec.lights, f, along >> 2, 3) < 0.4;
        for (let wy = 1; wy <= fh - 3; wy++) {
          if (putWindow(r, e, x, fTop + wy, shade(PAL.windowDay, left ? 1 : 0.8), lit ? (warm ? PAL.windowLitWarm : PAL.windowLitCool) : null)) anyLight = true;
        }
      }
    }
    // 1 階のエントランス (左壁の中央寄り)
    if (left && along >= fw / 2 - 8 && along <= fw / 2 - 3 && floors > 0) {
      for (let y = yb - 4; y <= yb; y++) r.set(x, y, shade(wc, 0.5));
      if (!constructing) {
        e.set(x, yb - 4, PAL.windowLitWarm);
        anyLight = true;
      }
    }
    // 屋上
    for (let y = yt - wallH; y <= yb - wallH; y++) {
      const edge = y === yt - wallH || y === yb - wallH;
      r.set(x, y, edge ? shade(roof, 0.75) : y === yt - wallH + 1 ? shade(roof, 1.1) : roof);
    }
    if (x === CX && wallH > 0) r.vline(x, yb - wallH + 1, yb, shade(wallR, 0.85));
  }
  if (!constructing) {
    // ヘリポートとアンテナ、縁の灯り
    const topY = baseTop + CY - 1 - wallH;
    r.disc(CX - 8, topY + 2, 4.5, shade(roof, 0.9));
    r.disc(CX - 8, topY + 2, 3.2, [236, 236, 228]);
    r.set(CX - 8, topY + 2, roof);
    r.vline(CX + 6, topY - 12, topY - 1, PAL.railDark);
    r.set(CX + 6, topY - 13, PAL.redLight);
    e.set(CX + 6, topY - 13, PAL.redLight);
    e.set(x0 + 1, baseTop + CY - 1 - wallH + 8, PAL.redLight);
    e.set(x1 - 2, baseTop + CY - 1 - wallH + 8, PAL.redLight);
    anyLight = true;
  } else if (floors < total) {
    // 足場とクレーン (2 基)
    for (let x = x0; x < x1; x++) {
      const [, ybR] = frows(x);
      const yb = ybR + baseTop;
      const top = yb - (floors + 1) * fh + 1;
      for (let y = top; y <= yb - floors * fh; y++) {
        const along = x < CX ? x - x0 : x1 - 1 - x;
        if (along % 3 === 0 || (y - top) % 3 === 0) r.set(x, y, PAL.scaffold);
      }
    }
    for (const mx of [CX - 10, CX + 12]) {
      const [, ybR] = frows(mx);
      const base = ybR + baseTop - (floors + 1) * fh;
      const top = base - 16;
      for (let y = top; y <= base; y++) r.set(mx, y, (y - top) % 2 === 0 ? PAL.crane : PAL.craneDark);
      r.hline(mx - 12, mx + 8, top, PAL.crane);
      r.vline(mx + 6, top + 1, top + 7, PAL.railDark);
      r.set(mx, top - 1, PAL.redLight);
      e.set(mx, top - 1, PAL.redLight);
      anyLight = true;
    }
  }
  return packBuilding(spec, r, e, 16, baseTop + 8, anyLight);
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
    return packBuilding(spec, r, e, 0, baseTop, true);
  }
  if (spec.level === 5) drawHall(r, e, baseTop, spec);
  else drawWheel(r, e, baseTop, spec);
  return packBuilding(spec, r, e, 0, baseTop, true);
}

/**
 * 2x2 のタワー (ランドマーク、レベル 6)。bigTowerSprite と同じく幅 64 の菱形を底面とし、
 * アンカー (右下のタイル) を基準に描く。ox = 16, oy = 高さ - 32 + 8。
 */
function bigLandmarkTowerSprite(spec: BuildingSpec): { base: Sprite; emissive: Sprite | null } {
  const W = 64;
  const CELL = 32;
  const CX = 32;
  const CY = 16;
  const TOWER_H = 150;
  const H = CELL + TOWER_H + 24;
  const baseTop = H - CELL;
  const r = new Raster(W, H);
  const e = new Raster(W, H);
  const constructing = spec.state === BState.Constructing;
  const rows = (x: number): [number, number] => {
    const d = x < CX ? x : W - 1 - x;
    const k = Math.floor(d / 2);
    return [CY - 1 - k, CY + k];
  };
  // 足元: 公園のような広場 (縁は植え込み)
  for (let x = 0; x < W; x++) {
    const [yt, yb] = rows(x);
    for (let y = yt; y <= yb; y++) {
      const edge = y === yt || y === yb || x < 2 || x > W - 3;
      const n = hash2(spec.style, x, y);
      r.set(x, y + baseTop, constructing ? (n < 0.12 ? PAL.concreteDark : n < 0.2 ? PAL.sand : PAL.dirt) : edge ? PAL.canopyDark : n < 0.06 ? PAL.concreteDark : PAL.concrete);
    }
  }
  if (constructing) {
    // 工事現場: 柵と 2 基のクレーン
    for (const mx of [CX - 12, CX + 12]) {
      const [, ybR] = rows(mx);
      const base = ybR + baseTop - 4;
      const top = base - 22;
      for (let y = top; y <= base; y++) r.set(mx, y, (y - top) % 2 === 0 ? PAL.crane : PAL.craneDark);
      r.hline(mx - 12, mx + 8, top, PAL.crane);
      r.vline(mx + 6, top + 1, top + 7, PAL.railDark);
      r.set(mx, top - 1, PAL.redLight);
      e.set(mx, top - 1, PAL.redLight);
    }
    // 基礎
    for (let x = CX - 20; x <= CX + 20; x += 8) {
      const [, ybR] = rows(x);
      r.fillRect(x - 1, ybR + baseTop - 6, 3, 6, PAL.concreteDark);
    }
    return packBuilding(spec, r, e, 16, baseTop + 8, true);
  }
  drawTower(r, e, baseTop, { cx: CX, height: TOWER_H, maxHw: 24, bottom: baseTop + CY + 4 });
  return packBuilding(spec, r, e, 16, baseTop + 8, true);
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

/** 鉄塔 (タワー)。cx を中心に、bottom から height だけ上へ。脚の広がりは maxHw */
function drawTower(r: Raster, e: Raster, baseTop: number, geo: { cx: number; height: number; maxHw: number; bottom: number }): void {
  void baseTop;
  const orange: RGB = [232, 104, 48];
  const dark: RGB = [168, 72, 32];
  const { cx: HALF_W, height, maxHw, bottom } = geo;
  const top = bottom - height;
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / height;
    const hw = 1 + t * t * maxHw;
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
  // 展望台 (大展望台と、その上の特別展望台)
  const decks = maxHw > 16 ? [0.45, 0.22] : [0.45];
  for (const [n, at] of decks.entries()) {
    const deckY = top + Math.round(height * at);
    const dhw = Math.round(1 + at * at * maxHw) + (n === 0 ? 4 : 2);
    const dh = n === 0 && maxHw > 16 ? 6 : 4;
    r.fillRect(HALF_W - dhw, deckY - 2, dhw * 2 + 1, dh, [236, 236, 228]);
    r.hline(HALF_W - dhw, HALF_W + dhw, deckY - 2 + dh, [160, 160, 152]);
    for (let x = HALF_W - dhw + 1; x < HALF_W + dhw; x += 2) {
      r.set(x, deckY, PAL.windowDay);
      e.set(x, deckY, PAL.windowLit);
      if (dh > 4) {
        r.set(x, deckY + 2, PAL.windowDay);
        e.set(x, deckY + 2, PAL.windowLit);
      }
    }
    e.set(HALF_W - 1, deckY - 3, PAL.redLight);
    e.set(HALF_W + 1, deckY - 3, PAL.redLight);
  }
  // アンテナと灯
  const ant = maxHw > 16 ? 12 : 6;
  r.vline(HALF_W, top - ant, top - 1, PAL.railDark);
  r.set(HALF_W, top - ant - 1, PAL.redLight);
  e.set(HALF_W, top - ant - 1, PAL.redLight);
  // 脚の灯り
  for (let y = bottom - 8; y > top + 8; y -= 12) {
    const t = (y - top) / height;
    const hw = 1 + t * t * maxHw;
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
  axis: "x" | "y" | "ne" | "se";
  facing: 1 | -1;
  kind: "head" | "mid" | "tail";
}

/** 凸四角形の内側か (uv 空間) */
function insideQuad(u: number, v: number, q: [number, number][]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [au, av] = q[i];
    const [bu, bv] = q[(i + 1) % 4];
    const cross = (bu - au) * (v - av) - (bv - av) * (u - au);
    if (cross === 0) continue;
    const sgn = cross > 0 ? 1 : -1;
    if (sign === 0) sign = sgn;
    else if (sign !== sgn) return false;
  }
  return true;
}

/**
 * 任意の向きの箱 (車両用)。footprint は uv 座標の四角形 (時計回りでなくてもよい)。
 * 画面手前 (uv で +u+v 方向) を向く辺が側面として見える。
 */
function isoBoxQuad(
  r: Raster,
  quad: [number, number][],
  h: number,
  baseTop: number,
  colors: { top: RGB; side: RGB },
  sidePixel?: (x: number, y: number, edge: number, t: number, k: number, facing: number) => RGB | null,
): void {
  // 辺ごとの外向き法線 (手前向きかどうか)
  const cu = quad.reduce((a, q) => a + q[0], 0) / 4;
  const cv = quad.reduce((a, q) => a + q[1], 0) / 4;
  const edges = quad.map((a, i) => {
    const b = quad[(i + 1) % 4];
    let nu = b[1] - a[1];
    let nv = -(b[0] - a[0]);
    const len = Math.hypot(nu, nv) || 1;
    nu /= len;
    nv /= len;
    // 中心から外へ向くように
    const mu = (a[0] + b[0]) / 2 - cu;
    const mv = (a[1] + b[1]) / 2 - cv;
    if (nu * mu + nv * mv < 0) {
      nu = -nu;
      nv = -nv;
    }
    return { a, b, nu, nv, facing: (nu + nv) / Math.SQRT2 };
  });
  const ground: [number, number, number, number][] = [];
  forEachDiamondPixel((x, y, u, v) => {
    if (insideQuad(u, v, quad)) ground.push([x, y + baseTop, u, v]);
  });
  ground.sort((a, b) => a[1] - b[1]);
  for (const [x, y, u, v] of ground) {
    // 一番近い手前向きの辺
    let best = -1;
    let bestD = 9;
    for (let i = 0; i < 4; i++) {
      if (edges[i].facing <= 0.05) continue;
      const d = distToSegment(u, v, [edges[i].a[0], edges[i].a[1], edges[i].b[0], edges[i].b[1]]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const e = edges[best >= 0 ? best : 0];
    // 辺に沿った位置 0..1
    const du = e.b[0] - e.a[0];
    const dv = e.b[1] - e.a[1];
    const t = Math.max(0, Math.min(1, ((u - e.a[0]) * du + (v - e.a[1]) * dv) / (du * du + dv * dv || 1)));
    const bright = 0.7 + 0.3 * Math.max(0, e.nv) + 0.05 * Math.max(0, -e.nu);
    const base = shade(colors.side, bright);
    for (let k = 1; k <= h; k++) {
      const c = sidePixel ? (sidePixel(x, y - k, best, t, k, e.facing) ?? base) : base;
      r.set(x, y - k, c);
    }
  }
  for (const [x, y] of ground) r.set(x, y - h, colors.top);
}

/** 車両。タイル中心を (16, 24) に置いた 32x32 のラスタ (ox=16, oy=24)。 */
export function carSprite(spec: CarSpriteSpec): { base: Sprite; emissive: Sprite | null } {
  const key = `car:${spec.axis}:${spec.facing}:${spec.kind}`;
  return pairCache.get(key, () => {
    const r = new Raster(32, 32);
    const e = new Raster(32, 32);
    const baseTop = 16;
    // 進行軸 (uv) と、車両の長さ・幅
    const axisVec: Record<CarSpriteSpec["axis"], [number, number]> = { x: [1, 0], y: [0, 1], ne: [Math.SQRT1_2, -Math.SQRT1_2], se: [Math.SQRT1_2, Math.SQRT1_2] };
    const [au, av] = axisVec[spec.axis];
    const half = spec.axis === "x" || spec.axis === "y" ? 0.4 : 0.58;
    const wid = spec.axis === "x" || spec.axis === "y" ? 0.15 : 0.13;
    const pu = -av;
    const pv = au;
    const quad: [number, number][] = [
      [0.5 - au * half - pu * wid, 0.5 - av * half - pv * wid],
      [0.5 + au * half - pu * wid, 0.5 + av * half - pv * wid],
      [0.5 + au * half + pu * wid, 0.5 + av * half + pv * wid],
      [0.5 - au * half + pu * wid, 0.5 - av * half + pv * wid],
    ];
    // 辺 0: 進行軸に平行 (片側)、辺 1: +軸側の端、辺 2: 平行 (反対側)、辺 3: -軸側の端
    const body: RGB = [236, 232, 216];
    const stripe: RGB = [48, 96, 192];
    const H = 7;
    const front = spec.kind === "head";
    const back = spec.kind === "tail";
    const frontEdge = spec.facing === 1 ? 1 : 3;
    const backEdge = spec.facing === 1 ? 3 : 1;
    isoBoxQuad(r, quad, H, baseTop, { top: [120, 124, 132], side: body }, (_x, _y, edge, t, k, facing) => {
      const longSide = edge === 0 || edge === 2;
      if (k === 2) return shade(stripe, 0.7 + 0.3 * facing);
      if (longSide && (k === 4 || k === 5)) {
        const w = t * 7;
        if (w % 1 < 0.55 && w > 0.4 && w < 6.6) return shade(PAL.windowDay, 0.8 + 0.2 * facing);
      }
      if (!longSide && (front || back) && edge === frontEdge && front && k === 3) return PAL.windowDay;
      return null;
    });
    // 前照灯・尾灯: 見える端面に。端面が真横 (見えない) のときは角に置く
    const endEdge = front ? frontEdge : back ? backEdge : -1;
    if (endEdge >= 0) {
      const a = quad[endEdge];
      const b = quad[(endEdge + 1) % 4];
      const mu = (a[0] + b[0]) / 2;
      const mv = (a[1] + b[1]) / 2;
      // 端面の中心が手前側 (u+v が大きい) なら見える
      const visible = mu + mv > 1.0 + 0.05;
      if (visible || spec.axis === "ne" || spec.axis === "se") {
        const [ex, ey] = uvToPixel(mu, mv);
        const lx = Math.floor(ex);
        const ly = Math.floor(ey) + baseTop - 2;
        const c: RGB = front ? PAL.lamp : PAL.redLight;
        const cd: RGB = front ? [255, 250, 200] : [200, 60, 50];
        if (visible) {
          e.set(lx - 1, ly, c);
          e.set(lx + 1, ly, c);
          r.set(lx - 1, ly, cd);
          r.set(lx + 1, ly, cd);
        } else {
          e.set(lx, ly, c);
          r.set(lx, ly, cd);
        }
      }
    }
    // 窓明かり
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const d = r.data;
        if (d[i + 3] && Math.abs(d[i] - PAL.windowDay[0]) <= 15 && Math.abs(d[i + 1] - PAL.windowDay[1]) <= 19 && Math.abs(d[i + 2] - PAL.windowDay[2]) <= 26) {
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
