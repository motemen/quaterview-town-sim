import { fbm } from "./rng";
import { maybeOpenStation } from "./rail";
import { updateWeather } from "./weather";
import { seasonOf, toCalendar } from "./time";
import {
  BState,
  DX,
  DY,
  DIR_E,
  DIR_N,
  DIR_S,
  DIR_W,
  Kind,
  World,
  idx,
  inBounds,
  isBuildableGround,
  isFlat,
  isRoadLike,
  passableAlong,
  railConnections,
  roadConnections,
  cornerHeights,
} from "./world";

/** 建物レベルごとの人口 */
export const LEVEL_CAPACITY = [0, 4, 14, 40, 120] as const;
/** 建設にかかる日数 */
export const CONSTRUCTION_DAYS = [0, 3, 5, 9, 14] as const;
/** 建物レベルごとの階数 (描画用) */
export const LEVEL_FLOORS = [0, 1, 2, 5, 10] as const;

export const STATION_RADIUS = 22;
export const MAX_BRIDGE_LEN = 5;

export function levelForValue(v: number): number {
  if (v < 40) return 1;
  if (v < 62) return 2;
  if (v < 88) return 3;
  return 4;
}

/** 1ゲーム時間ごとに呼ぶ。hour は 0..23。 */
export function hourlyStep(w: World, hour: number, totalDays: number): void {
  const cal = toCalendar(totalDays * 1440 + hour * 60);
  const season = seasonOf(cal.month);
  updateWeather(w, hour, cal.month, season);
  if (hour === 0) {
    if (cal.month === 11 && cal.day === 1) w.snowSeen = false;
    if (totalDays % 10 === 0 && maybeOpenStation(w)) w.stationsChanged = true;
    computeLandValue(w, totalDays);
    dailyAging(w);
    computePopulation(w);
  }
  if (hour === 6) seasonalNews(w, cal.month, cal.day);
  if (hour === 18) rerollLights(w);
  growRoads(w);
  growBuildings(w);
}

export function computeLandValue(w: World, totalDays: number): void {
  const years = totalDays / 360;
  const W = w.w;
  const H = w.h;
  const S = W + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(w, x, y);
      if (w.water[i]) {
        w.value[i] = 0;
        continue;
      }
      let v = 0;
      // 駅の影響
      let best = 0;
      for (const s of w.stations) {
        const d = Math.hypot(x - s.x, y - s.y);
        best = Math.max(best, Math.max(0, 1 - d / STATION_RADIUS));
      }
      v += 52 * Math.pow(best, 1.4);
      // 道路アクセス
      let roadAdj = false;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (inBounds(w, nx, ny) && isRoadLike(w.kind[idx(w, nx, ny)])) roadAdj = true;
      }
      if (roadAdj) v += 10;
      // 周囲の密度 (5x5)
      let density = 0;
      let amenity = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(w, nx, ny)) continue;
          const j = idx(w, nx, ny);
          const k = w.kind[j];
          if (k === Kind.Building && w.bState[j] === BState.Built) density += w.bLevel[j];
          else if (k === Kind.Building && w.bState[j] === BState.Abandoned) density -= 1;
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
            if (k === Kind.Water || k === Kind.Park) amenity += 5;
          }
        }
      }
      v += Math.min(48, density * 1.1);
      v += Math.min(12, amenity);
      // 眺望 (高台)
      v += w.height[y * S + x] * 2;
      // 流行の移り変わり: ゆっくり動くノイズ
      v += (fbm(w.seed + 500, x / 12 + years * 0.35, y / 12 - years * 0.2, 2) - 0.5) * 44;
      w.value[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

function dailyAging(w: World): void {
  const n = w.w * w.h;
  for (let i = 0; i < n; i++) {
    const k = w.kind[i];
    if (k === Kind.Building) {
      if (w.bState[i] === BState.Built && w.bAge[i] < 65000) w.bAge[i]++;
      if (w.bState[i] === BState.Abandoned && w.lotTimer[i] < 255) w.lotTimer[i]++;
    } else if (k === Kind.Lot) {
      if (w.lotTimer[i] < 255) w.lotTimer[i]++;
    }
  }
}

const MILESTONES = [100, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
export const FLAG_FIRST_TOWER = 1;
export const FLAG_FIRST_MIDRISE = 2;

export function computePopulation(w: World): void {
  let pop = 0;
  const n = w.w * w.h;
  for (let i = 0; i < n; i++) {
    if (w.kind[i] === Kind.Building && w.bState[i] === BState.Built) {
      pop += LEVEL_CAPACITY[w.bLevel[i]];
    }
  }
  w.population = pop;
  for (const m of MILESTONES) {
    if (pop >= m && w.popMilestone < m) {
      w.popMilestone = m;
      w.events.push(`人口が${m.toLocaleString("ja-JP")}人を超えました`);
    }
  }
}

/** 季節の便り。毎日 6 時に呼ぶ。 */
function seasonalNews(w: World, month: number, day: number): void {
  if (day !== 1) return;
  const msg: Record<number, string> = {
    1: "新年あけましておめでとうございます",
    3: "梅の花が咲きはじめました",
    4: "桜が満開です",
    6: "梅雨入りしました",
    7: "海開きの季節です",
    8: "今夜は花火大会です",
    9: "虫の声が聞こえる季節になりました",
    10: "紅葉がはじまりました",
    12: "街のイルミネーションが点灯しました",
  };
  if (msg[month]) w.events.push(msg[month]);
}

function rerollLights(w: World): void {
  const n = w.w * w.h;
  for (let i = 0; i < n; i++) {
    if (w.kind[i] === Kind.Building && w.rng.chance(0.3)) w.lights[i] = w.rng.int(256);
  }
}

function countKinds(w: World): { roads: number; buildings: number } {
  let roads = 0;
  let buildings = 0;
  const n = w.w * w.h;
  for (let i = 0; i < n; i++) {
    const k = w.kind[i];
    if (k === Kind.Road) roads++;
    else if (k === Kind.Building && w.bState[i] !== BState.Abandoned) buildings++;
  }
  return { roads, buildings };
}

interface RoadCandidate {
  tiles: number[]; // 変換するタイル index の列 (順番に)
  kinds: Kind[];
  weight: number;
}

/** 道路の延伸候補を調べる。延伸できなければ null。 */
export function roadExtension(w: World, x: number, y: number, dir: number): { tiles: number[]; kinds: Kind[] } | null {
  const tx = x + DX[dir];
  const ty = y + DY[dir];
  if (!inBounds(w, tx, ty)) return null;
  const ti = idx(w, tx, ty);
  const k = w.kind[ti];
  const srcBit = [DIR_S, DIR_W, DIR_N, DIR_E][dir]; // target から見た source の方向ビット
  const aheadBit = [DIR_N, DIR_E, DIR_S, DIR_W][dir];

  const shapeOk = (px: number, py: number): boolean => {
    const m = roadConnections(w, px, py) & ~srcBit;
    return m === 0 || m === aheadBit;
  };

  if (k === Kind.Water) {
    // 橋: まっすぐ水面を渡って対岸へ
    const tiles: number[] = [];
    const kinds: Kind[] = [];
    let cx = tx;
    let cy = ty;
    let len = 0;
    while (inBounds(w, cx, cy) && w.kind[idx(w, cx, cy)] === Kind.Water) {
      tiles.push(idx(w, cx, cy));
      kinds.push(Kind.Road);
      len++;
      if (len > MAX_BRIDGE_LEN) return null;
      cx += DX[dir];
      cy += DY[dir];
    }
    if (!inBounds(w, cx, cy)) return null;
    const li = idx(w, cx, cy);
    if (!isBuildableGround(w.kind[li])) return null;
    if (!passableAlong(w, cx, cy, dir)) return null;
    // 対岸: 橋の手前を source とみなす
    const m = roadConnections(w, cx, cy);
    if (m !== 0 && m !== aheadBit) return null;
    tiles.push(li);
    kinds.push(Kind.Road);
    return { tiles, kinds };
  }

  if (k === Kind.Rail) {
    const rc = railConnections(w, tx, ty);
    const alongX = (rc & (DIR_E | DIR_W)) !== 0 && (rc & (DIR_N | DIR_S)) === 0;
    const alongY = (rc & (DIR_N | DIR_S)) !== 0 && (rc & (DIR_E | DIR_W)) === 0;
    const perpendicular = (alongX && (dir === 0 || dir === 2)) || (alongY && (dir === 1 || dir === 3));
    if (!perpendicular) return null;
    if (!isFlat(w, tx, ty)) return null;
    const bx = tx + DX[dir];
    const by = ty + DY[dir];
    if (!inBounds(w, bx, by)) return null;
    const bi = idx(w, bx, by);
    if (!isBuildableGround(w.kind[bi])) return null;
    if (!passableAlong(w, bx, by, dir)) return null;
    const m = roadConnections(w, bx, by);
    if (m !== 0 && m !== aheadBit) return null;
    return { tiles: [ti, bi], kinds: [Kind.Crossing, Kind.Road] };
  }

  if (isBuildableGround(k)) {
    if (!passableAlong(w, tx, ty, dir)) return null;
    if (!shapeOk(tx, ty)) return null;
    // 線路に隣接して平行に走る道は避ける
    return { tiles: [ti], kinds: [Kind.Road] };
  }
  return null;
}

function growRoads(w: World): void {
  const { roads, buildings } = countKinds(w);
  let perDay = Math.min(3, 0.6 + buildings / 40);
  if (roads > buildings * 1.0 + 16) perDay *= 0.3;
  let attempts = Math.floor(perDay / 24);
  if (w.rng.chance(perDay / 24 - attempts)) attempts++;
  for (let a = 0; a < attempts; a++) extendRoadOnce(w);
}

function extendRoadOnce(w: World): void {
  const candidates: RoadCandidate[] = [];
  let totalWeight = 0;
  for (let y = 0; y < w.h; y++) {
    for (let x = 0; x < w.w; x++) {
      const i = idx(w, x, y);
      if (w.kind[i] !== Kind.Road) continue;
      const conn = roadConnections(w, x, y);
      const degree = popcount(conn);
      for (let d = 0; d < 4; d++) {
        if (conn & [DIR_N, DIR_E, DIR_S, DIR_W][d]) continue;
        const ext = roadExtension(w, x, y, d);
        if (!ext) continue;
        const last = ext.tiles[ext.tiles.length - 1];
        let weight = 1 + w.value[last] / 16;
        const oppositeBit = [DIR_S, DIR_W, DIR_N, DIR_E][d];
        const straight = (conn & oppositeBit) !== 0;
        if (straight && degree === 1) weight *= 8; // 行き止まりの先へまっすぐ
        else if (straight) weight *= 1.5; // 十字路・T字路から直進
        else if (degree === 2 && (conn === (DIR_N | DIR_S) || conn === (DIR_E | DIR_W))) weight *= 0.12; // 直線道路からの枝分かれ
        else weight *= 0.3; // 曲がる
        if (ext.tiles.length > 1) weight *= 0.5; // 橋・踏切はやや珍しい
        // 2マス隣に平行な道路があると街区が狭すぎるので抑える
        const lx = last % w.w;
        const ly = Math.floor(last / w.w);
        const px = d === 0 || d === 2 ? 2 : 0;
        const py = d === 1 || d === 3 ? 2 : 0;
        for (const sgn of [-1, 1]) {
          for (const [dist, pen] of [
            [2, 0.04],
            [3, 0.3],
          ] as const) {
            const qx = lx + (px / 2) * dist * sgn;
            const qy = ly + (py / 2) * dist * sgn;
            if (inBounds(w, qx, qy) && w.kind[idx(w, qx, qy)] === Kind.Road) weight *= pen;
          }
        }
        if (w.kind[last] === Kind.Forest) weight *= 0.7;
        candidates.push({ tiles: ext.tiles, kinds: ext.kinds, weight });
        totalWeight += weight;
      }
    }
  }
  if (candidates.length === 0) return;
  let r = w.rng.next() * totalWeight;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) {
      for (let k = 0; k < c.tiles.length; k++) {
        w.kind[c.tiles[k]] = c.kinds[k];
        w.lotTimer[c.tiles[k]] = 0;
      }
      return;
    }
  }
}

function popcount(m: number): number {
  let c = 0;
  while (m) {
    c += m & 1;
    m >>= 1;
  }
  return c;
}

function growBuildings(w: World): void {
  const W = w.w;
  const H = w.h;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(w, x, y);
      const k = w.kind[i];
      if (k === Kind.Building) {
        stepBuilding(w, i);
        continue;
      }
      if (k === Kind.Forest) {
        // 市街地に囲まれた森は公園になる
        let urban = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(w, nx, ny)) continue;
            const nk = w.kind[idx(w, nx, ny)];
            if (nk === Kind.Building || nk === Kind.Road) urban++;
          }
        }
        if (urban >= 4 && w.rng.chance(0.08 / 24)) w.kind[i] = Kind.Park;
      }
      if (!isBuildableGround(k)) continue;
      if (!isFlat(w, x, y)) continue;
      // 田舎では田畑が広がる
      if (k === Kind.Grass && w.value[i] < 22) {
        let farmStyle = -1;
        let farms = 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (!inBounds(w, nx, ny)) continue;
          const j = idx(w, nx, ny);
          if (w.kind[j] === Kind.Farm) {
            farms++;
            farmStyle = w.bStyle[j];
          }
        }
        if (farms >= 2 && w.rng.chance(0.08 / 24)) {
          w.kind[i] = Kind.Farm;
          w.bStyle[i] = farmStyle;
          continue;
        }
      }
      // 道路までの距離 (1 = 隣接, 2 = 1マス挟む)
      let roadDist = 0;
      for (let d = 0; d < 4 && roadDist !== 1; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!inBounds(w, nx, ny)) continue;
        const nk = w.kind[idx(w, nx, ny)];
        if (nk === Kind.Road) roadDist = 1;
        else if (roadDist === 0 && nk === Kind.Building) {
          for (let e = 0; e < 4; e++) {
            const mx = nx + DX[e];
            const my = ny + DY[e];
            if (inBounds(w, mx, my) && w.kind[idx(w, mx, my)] === Kind.Road) roadDist = 2;
          }
        }
      }
      if (roadDist === 0) {
        if (k === Kind.Lot && w.lotTimer[i] > 60 && w.rng.chance(0.1 / 24)) w.kind[i] = Kind.Grass;
        continue;
      }
      const v = w.value[i];
      let pDay = Math.pow(v / 100, 2) * 0.45;
      if (roadDist === 2) pDay *= 0.4;
      if (k === Kind.Lot) pDay *= 3;
      if (k === Kind.Forest) pDay *= 0.6;
      if (k === Kind.Farm) pDay *= 0.5;
      if (v < 8) pDay = 0;
      if (w.rng.chance(pDay / 24)) {
        startConstruction(w, i, v);
      } else if (k === Kind.Lot && w.lotTimer[i] > 90 && w.rng.chance(0.05 / 24)) {
        w.kind[i] = Kind.Grass;
      }
    }
  }
}

function startConstruction(w: World, i: number, v: number): void {
  let level = levelForValue(v);
  if (level > 1 && w.rng.chance(0.4)) level--;
  if (level > 1 && w.rng.chance(0.25)) level--;
  w.kind[i] = Kind.Building;
  w.bLevel[i] = level;
  w.bStyle[i] = w.rng.int(256);
  w.bState[i] = BState.Constructing;
  w.bProgress[i] = 0;
  w.bAge[i] = 0;
  w.lotTimer[i] = 0;
  w.lights[i] = w.rng.int(256);
}

function stepBuilding(w: World, i: number): void {
  const state = w.bState[i];
  const level = w.bLevel[i];
  if (state === BState.Constructing) {
    const perHour = 255 / (CONSTRUCTION_DAYS[level] * 24);
    const p = w.bProgress[i] + perHour;
    if (p >= 255) {
      w.bProgress[i] = 255;
      w.bState[i] = BState.Built;
      if (level === 4 && !(w.flags & FLAG_FIRST_TOWER)) {
        w.flags |= FLAG_FIRST_TOWER;
        w.events.push("街で初めての高層ビルが完成しました");
      } else if (level === 3 && !(w.flags & FLAG_FIRST_MIDRISE)) {
        w.flags |= FLAG_FIRST_MIDRISE;
        w.events.push("初めての中層ビルが完成しました");
      }
    } else {
      w.bProgress[i] = p;
    }
    return;
  }
  const target = levelForValue(w.value[i]);
  if (state === BState.Built) {
    if (target > level && w.bAge[i] > 25) {
      // 建て替え
      if (w.rng.chance((0.02 * (target - level)) / 24)) demolish(w, i);
    } else if (target < level - 1 || w.value[i] < 10) {
      // 衰退
      if (w.bAge[i] > 40 && w.rng.chance(0.04 / 24)) {
        w.bState[i] = BState.Abandoned;
        w.lotTimer[i] = 0;
      }
    }
    return;
  }
  if (state === BState.Abandoned) {
    if (target >= level && w.rng.chance(0.08 / 24)) {
      // 再利用
      w.bState[i] = BState.Built;
      w.bAge[i] = 0;
    } else if (w.lotTimer[i] > 15 && w.rng.chance(0.06 / 24)) {
      demolish(w, i);
    }
  }
}

function demolish(w: World, i: number): void {
  w.kind[i] = Kind.Lot;
  w.bState[i] = BState.None;
  w.bLevel[i] = 0;
  w.lotTimer[i] = 0;
}

/** 雑居ビルか (レベル 2・3 のスタイルで決まる) */
export function isMixedUse(level: number, style: number): boolean {
  return (level === 2 || level === 3) && (style & 0xc0) === 0xc0;
}

/** 建物の階数 (レベルとスタイルで決まる) */
export function buildingFloors(level: number, style: number): number {
  if (level === 1) return (style >> 7) & 1 ? 2 : 1;
  if (level === 2) return isMixedUse(level, style) ? 3 : 2;
  if (level === 3) return isMixedUse(level, style) ? 6 : 5;
  if (level === 4) return 9 + (style & 3) * 2;
  return LEVEL_FLOORS[level] ?? 1;
}

/** 建物の見た目上の階数 (建設中は進捗に応じて) */
export function visibleFloors(w: World, i: number): number {
  const total = buildingFloors(w.bLevel[i], w.bStyle[i]);
  if (w.bState[i] !== BState.Constructing) return total;
  return Math.min(total, Math.floor((w.bProgress[i] / 255) * (total + 1)));
}

export { cornerHeights };
