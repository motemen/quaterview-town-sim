import { BState, DX, DY, Kind, World, idx, inBounds, isFlat, isRailLike } from "./world";

/** 線路の経路を西端から東端へたどる。 */
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
  for (;;) {
    let next: [number, number] | null = null;
    // 東を優先し、次に南北
    for (const d of [1, 2, 0, 3]) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!inBounds(w, nx, ny)) continue;
      const i = idx(w, nx, ny);
      if (visited[i] || !isRailLike(w.kind[i])) continue;
      next = [nx, ny];
      break;
    }
    if (!next) break;
    visited[idx(w, next[0], next[1])] = 1;
    path.push(next);
    [x, y] = next;
  }
  return path;
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
  w.stations.push({ x, y, plazaDir: best.plazaDir });
  w.events.push(`新しい駅が開業しました (${w.stations.length}駅目)`);
  return true;
}
