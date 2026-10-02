import { makePlaceName } from "./names";
import { flattenTile } from "./terraform";
import {
  BState,
  DX8,
  DY8,
  Kind,
  R8_BIT,
  World,
  idx,
  inBounds,
  isRailLike,
  railIsStraightX,
  roadConnections,
  DIR_E,
  DIR_W,
} from "./world";

/** 支線: 本線の駅のそばから 135° で分岐し、北か南へ伸びて終点駅に至る */
export interface Branch {
  tiles: [number, number][];
  /** 建設済みのタイル数 */
  built: number;
  done: boolean;
  name: string;
  /** 分岐元の駅 (w.stations のインデックス) */
  from: number;
  /** 終点駅の広場の向き (1=東 3=西) */
  plazaDir: number;
  /** 延伸した回数 */
  extensions?: number;
  /** 延伸中の新しい終点の名前 */
  pendingName?: string;
}

const MAX_EXTENSIONS = 2;

const MAX_BRANCHES = 4;
const TILES_PER_DAY = 2;

/** 10 日に 1 回: 条件が揃えば新しい支線を計画する (既存の支線の延伸を優先) */
export function maybePlanBranch(w: World): boolean {
  if (w.population < 2000) return false;
  if (maybeExtendBranch(w)) return true;
  const limit = Math.min(MAX_BRANCHES, Math.max(1, Math.floor(w.stations.length / 2)));
  if (w.branches.length >= limit) return false;
  // 候補の駅: 本線上で、周囲に建物が多く、まだ支線のない駅
  const used = new Set(w.branches.map((b) => b.from));
  let best: { from: number; tiles: [number, number][]; plazaDir: number; score: number } | null = null;
  for (let si = 0; si < w.stations.length; si++) {
    if (used.has(si)) continue;
    const st = w.stations[si];
    if (st.plazaDir !== 0 && st.plazaDir !== 2) continue; // 本線の駅だけ
    let buildings = 0;
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        const x = st.x + dx;
        const y = st.y + dy;
        if (inBounds(w, x, y) && w.kind[idx(w, x, y)] === Kind.Building) buildings++;
      }
    }
    if (buildings < 12) continue;
    for (const dir of [-1, 1]) {
      const plan = planPath(w, st.x, st.y, dir);
      if (!plan) continue;
      const score = buildings + plan.tiles.length * 0.5 + w.rng.next() * 5;
      if (!best || score > best.score) best = { from: si, tiles: plan.tiles, plazaDir: plan.plazaDir, score };
    }
  }
  if (!best) return false;
  const name = makePlaceName(w.rng, new Set(w.stations.map((s) => s.name ?? "")));
  w.branches.push({ tiles: best.tiles, built: 0, done: false, name, from: best.from, plazaDir: best.plazaDir });
  w.events.push(`${name}線の建設が始まりました`);
  return true;
}

/** 開通済みの支線の終点がにぎわってきたら、同じ向きにさらに伸ばす */
function maybeExtendBranch(w: World): boolean {
  for (const b of w.branches) {
    if (!b.done || (b.extensions ?? 0) >= MAX_EXTENSIONS) continue;
    const [tx, ty] = b.tiles[b.tiles.length - 1];
    let buildings = 0;
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const x = tx + dx;
        const y = ty + dy;
        if (inBounds(w, x, y) && w.kind[idx(w, x, y)] === Kind.Building) buildings++;
      }
    }
    if (buildings < 10) continue;
    const [px, py] = b.tiles[b.tiles.length - 2];
    const dir = Math.sign(ty - py) || 1;
    const ext = planExtension(w, tx, ty, dir);
    if (!ext) continue;
    const name = makePlaceName(w.rng, new Set(w.stations.map((s) => s.name ?? "")));
    b.tiles.push(...ext.tiles);
    b.done = false;
    b.plazaDir = ext.plazaDir;
    b.extensions = (b.extensions ?? 0) + 1;
    b.name = b.name; // 路線名はそのまま
    w.events.push(`${b.name}線が${name}まで延伸工事に入りました`);
    b.pendingName = name;
    return true;
  }
  return false;
}

/** 終点 (tx,ty) から dir 方向へまっすぐ伸ばす経路 (終点は含まない) */
function planExtension(w: World, tx: number, ty: number, dir: number): { tiles: [number, number][]; plazaDir: number } | null {
  const tiles: [number, number][] = [];
  const maxLen = 14 + w.rng.int(12);
  let waterRun = 0;
  let y = ty;
  for (let k = 0; k < maxLen; k++) {
    const ny = y + dir;
    if (!inBounds(w, tx, ny) || ny < 3 || ny > w.h - 4) break;
    if (!ok(w, tx, ny, k === 0)) break;
    if (w.water[idx(w, tx, ny)]) {
      waterRun++;
      if (waterRun > 4) {
        while (tiles.length > 0 && w.water[idx(w, tiles[tiles.length - 1][0], tiles[tiles.length - 1][1])]) tiles.pop();
        break;
      }
    } else waterRun = 0;
    y = ny;
    tiles.push([tx, y]);
  }
  while (tiles.length > 0) {
    const [ex, ey] = tiles[tiles.length - 1];
    if (!w.water[idx(w, ex, ey)]) {
      for (const plazaDir of [1, 3]) {
        const px = ex + (plazaDir === 1 ? 1 : -1);
        if (!inBounds(w, px, ey)) continue;
        const pi = idx(w, px, ey);
        if (w.water[pi] || isRailLike(w.kind[pi]) || w.kind[pi] === Kind.Shrine) continue;
        if (w.kind[pi] === Kind.Building && w.bLevel[pi] >= 5) continue;
        if (tiles.length < 10) return null;
        return { tiles, plazaDir };
      }
    }
    tiles.pop();
  }
  return null;
}

/** 駅 (sx,sy) の隣 (side: 1=東 -1=西) から分岐し、dir (-1=北 1=南) へ伸びる経路を作る */
function planPath(w: World, sx: number, sy: number, dir: number): { tiles: [number, number][]; plazaDir: number } | null {
  for (const side of [1, -1]) {
    const r = planPathSide(w, sx, sy, dir, side);
    if (r) return r;
  }
  return null;
}

function planPathSide(w: World, sx: number, sy: number, dir: number, side: number): { tiles: [number, number][]; plazaDir: number } | null {
  const jx = sx + side;
  const jy = sy;
  if (!inBounds(w, jx, jy)) return null;
  const ji = idx(w, jx, jy);
  if (w.kind[ji] !== Kind.Rail || !railIsStraightX(w.railMask[ji])) return null;
  const tiles: [number, number][] = [[jx, jy]];
  // 斜めに 2 マス (本線の隣なので隣接チェックはしない)
  let x = jx;
  let y = jy;
  for (let k = 0; k < 2; k++) {
    x += side;
    y += dir;
    if (!ok(w, x, y, true)) return null;
    tiles.push([x, y]);
  }
  // まっすぐ
  const maxLen = 18 + w.rng.int(14);
  let waterRun = 0;
  for (let k = 0; k < maxLen; k++) {
    const ny = y + dir;
    if (!inBounds(w, x, ny) || ny < 3 || ny > w.h - 4) break;
    if (!ok(w, x, ny, false)) break;
    if (w.water[idx(w, x, ny)]) {
      waterRun++;
      if (waterRun > 4) {
        while (tiles.length > 3 && w.water[idx(w, tiles[tiles.length - 1][0], tiles[tiles.length - 1][1])]) tiles.pop();
        break;
      }
    } else waterRun = 0;
    y = ny;
    tiles.push([x, y]);
  }
  // 終点は陸で、東か西に広場が取れること
  while (tiles.length > 3) {
    const [tx, ty] = tiles[tiles.length - 1];
    if (!w.water[idx(w, tx, ty)]) {
      for (const plazaDir of [1, 3]) {
        const px = tx + (plazaDir === 1 ? 1 : -1);
        if (!inBounds(w, px, ty)) continue;
        const pi = idx(w, px, ty);
        if (w.water[pi] || isRailLike(w.kind[pi]) || w.kind[pi] === Kind.Shrine) continue;
        if (w.kind[pi] === Kind.Building && w.bLevel[pi] >= 5) continue;
        if (tiles.length < 12) return null;
        return { tiles, plazaDir };
      }
    }
    tiles.pop();
  }
  return null;
}

/** 線路を通せるタイルか。nearMain のとき (分岐直後) は他の線路との隣接を気にしない */
function ok(w: World, x: number, y: number, nearMain: boolean): boolean {
  if (!inBounds(w, x, y)) return false;
  const i = idx(w, x, y);
  const k = w.kind[i];
  if (isRailLike(k) || k === Kind.Shrine || k === Kind.BuildingPart) return false;
  if (k === Kind.Building && w.bLevel[i] >= 5) return false;
  if (nearMain) return !w.water[i];
  // 他の線路のすぐ隣は避ける
  for (let d = 0; d < 8; d++) {
    const nx = x + DX8[d];
    const ny = y + DY8[d];
    if (inBounds(w, nx, ny) && isRailLike(w.kind[idx(w, nx, ny)])) return false;
  }
  return true;
}

/** 毎日: 建設中の支線を少し進める */
export function buildBranches(w: World): void {
  for (const b of w.branches) {
    if (b.done) continue;
    for (let k = 0; k < TILES_PER_DAY && b.built < b.tiles.length; k++) {
      layTile(w, b, b.built);
      b.built++;
    }
    if (b.built >= b.tiles.length) {
      b.done = true;
      const [tx, ty] = b.tiles[b.tiles.length - 1];
      const name = b.pendingName ?? b.name;
      b.pendingName = undefined;
      w.stations.push({ x: tx, y: ty, plazaDir: b.plazaDir, name });
      w.stationsChanged = true;
      w.events.push(b.extensions ? `${b.name}線が${name}駅まで延伸しました` : `${b.name}線が開通し、${name}駅ができました`);
    }
  }
}

function dirIndex(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX8[d] === dx && DY8[d] === dy) return d;
  return 2;
}

/** 支線の k 番目のタイルを敷く */
function layTile(w: World, b: Branch, k: number): void {
  const [x, y] = b.tiles[k];
  const i = idx(w, x, y);
  const last = k === b.tiles.length - 1;
  // 接続ビット
  if (k > 0) {
    const [px, py] = b.tiles[k - 1];
    w.railMask[i] |= R8_BIT[dirIndex(px - x, py - y)];
    w.railMask[idx(w, px, py)] |= R8_BIT[dirIndex(x - px, y - py)];
  }
  if (k === 0) return; // 分岐点は既存の本線
  const kind = w.kind[i];
  if (kind === Kind.Building) {
    w.bState[i] = BState.None;
    w.bLevel[i] = 0;
  }
  if (kind === Kind.Road && (roadConnections(w, x, y) & ~(DIR_E | DIR_W)) === 0 && !last) {
    w.kind[i] = Kind.Crossing;
  } else {
    w.kind[i] = last ? Kind.Station : Kind.Rail;
  }
  w.lotTimer[i] = 0;
  flattenForRail(w, x, y);
  if (last) {
    // 終点駅の広場
    const px = x + (b.plazaDir === 1 ? 1 : -1);
    const pi = idx(w, px, y);
    if (w.kind[pi] === Kind.Building) {
      w.bState[pi] = BState.None;
      w.bLevel[pi] = 0;
    }
    if (w.kind[pi] !== Kind.Road) w.kind[pi] = Kind.Road;
    w.water[pi] = 0;
    flattenForRail(w, px, y);
  }
}

/** タイル (x,y) の 4 頂点を線路の高さ 1 にして、周囲をなだらかにする */
export function flattenForRail(w: World, x: number, y: number): void {
  flattenTile(w, x, y, 1, true);
}
