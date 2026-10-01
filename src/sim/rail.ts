import { makePlaceName } from "./names";
import { BState, DX, DX8, DY, DY8, Kind, R8_BIT, R8_E, R8_W, World, idx, inBounds, isFlat, isRailLike } from "./world";

/** 線路の経路を西端から東端へたどる (8 近傍。直進 > 直角 > 斜めの順に優先)。 */
export function railPath(w: World): [number, number][] {
  let start: [number, number] | null = null;
  for (let y = 0; y < w.h && !start; y++) {
    if (isRailLike(w.kind[idx(w, 0, y)])) start = [0, y];
  }
  if (!start) return [];
  const visited = new Uint8Array(w.w * w.h);
  const path: [number, number][] = [start];
  visited[idx(w, start[0], start[1])] = 1;
  let [x, y] = start;
  let heading = 2; // 東
  for (;;) {
    let next: [number, number] | null = null;
    let nextHeading = heading;
    // 来た向きを基準に: 直進、直角 (±2)、斜め (±1)、残り
    for (const off of [0, 2, -2, 1, -1, 3, -3]) {
      const d = (heading + off + 8) % 8;
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (!inBounds(w, nx, ny)) continue;
      const i = idx(w, nx, ny);
      if (visited[i] || !isRailLike(w.kind[i])) continue;
      // 接続マスクがあるときはそれに従う
      const cur = w.railMask[idx(w, x, y)];
      if (cur !== 0 && !(cur & R8_BIT[d])) continue;
      next = [nx, ny];
      nextHeading = d;
      break;
    }
    if (!next) break;
    visited[idx(w, next[0], next[1])] = 1;
    path.push(next);
    [x, y] = next;
    heading = nextHeading;
  }
  return path;
}

/** 経路から各線路タイルの接続マスクを計算する */
export function updateRailMask(w: World): [number, number][] {
  w.railMask.fill(0);
  const path = railPath(w);
  for (let k = 0; k < path.length; k++) {
    const [x, y] = path[k];
    const i = idx(w, x, y);
    if (k > 0) {
      const [px, py] = path[k - 1];
      w.railMask[i] |= R8_BIT[dirIndex(px - x, py - y)];
    }
    if (k + 1 < path.length) {
      const [nx, ny] = path[k + 1];
      w.railMask[i] |= R8_BIT[dirIndex(nx - x, ny - y)];
    }
    // マップ端から外へ
    if (x === 0) w.railMask[i] |= R8_W;
    if (x === w.w - 1) w.railMask[i] |= R8_E;
  }
  return path;
}

function dirIndex(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX8[d] === dx && DY8[d] === dy) return d;
  return 2;
}

/** 経路上の駅の位置 (インデックス) */
export function stationIndices(w: World, path: [number, number][]): number[] {
  const out: number[] = [];
  path.forEach(([x, y], i) => {
    if (w.kind[idx(w, x, y)] === Kind.Station) out.push(i);
  });
  return out;
}

export const NEW_STATION_MIN_DISTANCE = 14;
export const NEW_STATION_MIN_BUILDINGS = 18;

/**
 * 発展した場所に新しい駅を開業する。1 日 1 回呼ぶ。
 * 既存の駅から十分離れた直線区間で、周囲に建物が多いところに作る。
 */
export function maybeOpenStation(w: World): boolean {
  const path = railPath(w);
  let best: { i: number; score: number; plazaDir: number } | null = null;
  for (let k = 1; k < path.length - 1; k++) {
    const [x, y] = path[k];
    const i = idx(w, x, y);
    if (w.kind[i] !== Kind.Rail || w.water[i] || !isFlat(w, x, y)) continue;
    // 直線 (東西) であること
    if (path[k - 1][1] !== y || path[k + 1][1] !== y) continue;
    let far = true;
    for (const s of w.stations) {
      if (Math.hypot(s.x - x, s.y - y) < NEW_STATION_MIN_DISTANCE) far = false;
    }
    if (!far) continue;
    for (const plazaDir of [2, 0]) {
      const px = x + DX[plazaDir];
      const py = y + DY[plazaDir];
      if (!inBounds(w, px, py)) continue;
      const pi = idx(w, px, py);
      const pk = w.kind[pi];
      if (w.water[pi] || !isFlat(w, px, py)) continue;
      if (pk === Kind.Rail || pk === Kind.Crossing || pk === Kind.Station) continue;
      // 広場側 6 マス以内の建物数
      let count = 0;
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(w, nx, ny)) continue;
          const j = idx(w, nx, ny);
          if (w.kind[j] === Kind.Building && w.bState[j] !== BState.Abandoned) count++;
        }
      }
      if (count < NEW_STATION_MIN_BUILDINGS) continue;
      const score = count + (pk === Kind.Road ? 5 : 0);
      if (!best || score > best.score) best = { i: k, score, plazaDir };
    }
  }
  if (!best) return false;
  const [x, y] = path[best.i];
  const px = x + DX[best.plazaDir];
  const py = y + DY[best.plazaDir];
  const pi = idx(w, px, py);
  w.kind[idx(w, x, y)] = Kind.Station;
  w.kind[pi] = Kind.Road;
  w.bState[pi] = BState.None;
  w.bLevel[pi] = 0;
  w.lotTimer[pi] = 0;
  const name = makePlaceName(w.rng, new Set(w.stations.map((s) => s.name ?? "")));
  w.stations.push({ x, y, plazaDir: best.plazaDir, name });
  w.events.push(`${name}駅が開業しました`);
  return true;
}
