import { BState, Kind, LEVEL_BIG_TOWER, Slope, World, cornerHeights, idx, inBounds, isFlat, isRailLike, slopeOf, updateSlopes } from "./world";

/** 頂点が固定されているか: 水面のタイル (0) か線路のタイル (1) に属する */
export function vertexFixed(w: World, vx: number, vy: number): boolean {
  for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
    const x = vx + dx;
    const y = vy + dy;
    if (!inBounds(w, x, y)) continue;
    const i = idx(w, x, y);
    if (isRailLike(w.kind[i]) || (w.water[i] && w.kind[i] === Kind.Water)) return true;
  }
  return false;
}

/**
 * タイル (x,y) の 4 頂点を高さ h にして、周囲をなだらかにする (切土・盛土)。
 * 固定された頂点が h と違えばできないので false を返す。
 * 傾いてしまった建物や道路は片づける。
 */
export function flattenTile(w: World, x: number, y: number, h: number, allowFixed = false): boolean {
  const S = w.w + 1;
  const corners: [number, number][] = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
  if (!allowFixed) {
    for (const [vx, vy] of corners) {
      if (vertexFixed(w, vx, vy) && w.height[vy * S + vx] !== h) return false;
    }
  }
  for (const [vx, vy] of corners) w.height[vy * S + vx] = h;
  relaxAround(w, x, y);
  return true;
}

/** タイル (x,y) の 4 頂点を起点に、隣との差を 1 以内にする (上げ下げ両方)。固定頂点は動かさない。 */
export function relaxAround(w: World, x: number, y: number): void {
  const S = w.w + 1;
  const queue: number[] = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) queue.push((y + dy) * S + (x + dx));
  const minX = Math.max(0, x - 6);
  const maxX = Math.min(w.w, x + 7);
  const minY = Math.max(0, y - 6);
  const maxY = Math.min(w.h, y + 7);
  let guard = 0;
  while (queue.length && guard++ < 4000) {
    const v = queue.pop()!;
    const vx = v % S;
    const vy = Math.floor(v / S);
    const hv = w.height[v];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = vx + dx;
      const ny = vy + dy;
      if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;
      const nv = ny * S + nx;
      const hn = w.height[nv];
      if (Math.abs(hn - hv) <= 1) continue;
      if (vertexFixed(w, nx, ny)) continue;
      w.height[nv] = hn > hv ? hv + 1 : hv - 1;
      queue.push(nv);
    }
  }
  updateSlopes(w);
  cleanupSlopes(w, minX, minY, maxX, maxY);
  w.terrainChanged = true;
}

/** 範囲内で、傾いてしまった建物・道路・田畑を片づける */
export function cleanupSlopes(w: World, minX: number, minY: number, maxX: number, maxY: number): void {
  for (let ty = minY; ty < maxY && ty < w.h; ty++) {
    for (let tx = minX; tx < maxX && tx < w.w; tx++) {
      const i = idx(w, tx, ty);
      const k = w.kind[i];
      const s = slopeOf(cornerHeights(w, tx, ty));
      if ((k === Kind.Building || k === Kind.BuildingPart) && s !== Slope.Flat) {
        if (k === Kind.BuildingPart || w.bLevel[i] === LEVEL_BIG_TOWER) {
          demolishBigAt(w, i);
        } else {
          w.kind[i] = Kind.Lot;
          w.bState[i] = BState.None;
          w.bLevel[i] = 0;
          w.lotTimer[i] = 0;
        }
      } else if (k === Kind.Road && s === Slope.Irregular) {
        w.kind[i] = Kind.Grass;
      } else if (k === Kind.Farm && !isFlat(w, tx, ty)) {
        w.kind[i] = Kind.Grass;
      }
    }
  }
}

/** 2x2 の建物をまるごと取り壊す (growth.ts の demolishBig と同じだが循環参照を避けてここに置く) */
function demolishBigAt(w: World, i: number): void {
  const off = w.kind[i] === Kind.BuildingPart ? w.bStyle[i] : 0;
  const anchor = w.kind[i] === Kind.BuildingPart ? i + (off & 1) + (off >> 1) * w.w : i;
  const ax = anchor % w.w;
  const ay = Math.floor(anchor / w.w);
  for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    const x = ax + dx;
    const y = ay + dy;
    if (!inBounds(w, x, y)) continue;
    const j = idx(w, x, y);
    if (j === anchor || w.kind[j] === Kind.BuildingPart) {
      w.kind[j] = Kind.Lot;
      w.bState[j] = BState.None;
      w.bLevel[j] = 0;
      w.lotTimer[j] = 0;
    }
  }
}
