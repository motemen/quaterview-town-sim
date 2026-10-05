import { bigSiteFree, claimBigSite } from "./growth";
import { BState, DX, DY, Kind, World, idx, inBounds, isFlat, isBuildableGround } from "./world";

/** ランドマークのレベル (bLevel) */
export const LANDMARK_HALL = 5; // 市役所
export const LANDMARK_TOWER = 6; // タワー
export const LANDMARK_WHEEL = 7; // 観覧車

export const LANDMARK_FLAG = { [LANDMARK_HALL]: 4, [LANDMARK_TOWER]: 8, [LANDMARK_WHEEL]: 16 } as const;
export const LANDMARK_LABEL: Record<number, string> = { 5: "市役所", 6: "タワー", 7: "観覧車" };

const PLAN: { level: number; population: number }[] = [
  { level: LANDMARK_HALL, population: 3000 },
  { level: LANDMARK_TOWER, population: 12000 },
  { level: LANDMARK_WHEEL, population: 25000 },
];

export function isLandmark(level: number): boolean {
  return level >= 5 && level <= 7;
}

/** 取り壊されない建物か (ランドマークと 2x2 タワー) */
export function isPermanent(level: number): boolean {
  return level >= 5;
}

/** 人口の節目でランドマークを建て始める。1 日 1 回呼ぶ。 */
export function maybeStartLandmark(w: World): void {
  for (const p of PLAN) {
    const flag = LANDMARK_FLAG[p.level as keyof typeof LANDMARK_FLAG];
    if (w.flags & flag) continue;
    if (w.population < p.population) continue;
    const site = findSite(w, p.level);
    if (site < 0) continue;
    w.flags |= flag;
    if (p.level === LANDMARK_TOWER) {
      // タワーは 2x2。site は右下 (アンカー)
      const ax = site % w.w;
      const ay = Math.floor(site / w.w);
      claimBigSite(w, ax - 1, ay - 1, p.level, w.rng.int(256));
      w.events.push(`${LANDMARK_LABEL[p.level]}の建設が始まりました`);
      return;
    }
    w.kind[site] = Kind.Building;
    w.cache.buildings.push(site);
    w.bLevel[site] = p.level;
    w.bStyle[site] = w.rng.int(256);
    w.bState[site] = BState.Constructing;
    w.bProgress[site] = 0;
    w.bAge[site] = 0;
    w.lotTimer[site] = 0;
    w.lights[site] = w.rng.int(16);
    w.events.push(`${LANDMARK_LABEL[p.level]}の建設が始まりました`);
    return;
  }
}

/** 駅の近くで、道路に面した平らな場所を探す。建物があっても低いものなら取り壊す。タワーは 2x2 で、右下のタイルを返す。 */
function findSite(w: World, level: number): number {
  const big = level === LANDMARK_TOWER;
  let best = -1;
  let bestScore = -Infinity;
  for (const s of w.stations) {
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (!inBounds(w, x, y) || !isFlat(w, x, y)) continue;
        const i = idx(w, x, y);
        const k = w.kind[i];
        if (w.water[i]) continue;
        if (big) {
          if (!bigSiteFree(w, x - 1, y - 1, -1, 3)) continue;
        } else {
          const replaceable = isBuildableGround(k) || (k === Kind.Building && w.bLevel[i] <= 2);
          if (!replaceable) continue;
        }
        let road = false;
        let water = 0;
        // 区画 (1x1 か 2x2) の外周に道路があるか
        const cells: [number, number][] = big ? [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]] : [[x, y]];
        for (const [cx, cy] of cells) {
          for (let d = 0; d < 4; d++) {
            const nx = cx + DX[d];
            const ny = cy + DY[d];
            if (!inBounds(w, nx, ny)) continue;
            const nk = w.kind[idx(w, nx, ny)];
            if (nk === Kind.Road) road = true;
            if (nk === Kind.Water) water++;
          }
        }
        if (!road) continue;
        const dist = Math.hypot(dx, dy);
        let score = -dist;
        if (k !== Kind.Building) score += 3;
        if (level === 7) score += water * 4 + dist * 0.5; // 観覧車は少し離れた水辺が似合う
        if (level === 5) score -= dist * 0.5; // 市役所は駅前
        score += w.rng.next() * 2;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
  }
  return best;
}
