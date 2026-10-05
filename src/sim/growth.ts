import { fbm } from "./rng";
import { maybeOpenStation } from "./rail";
import { updateWeather } from "./weather";
import {
  isLandmark,
  isPermanent,
  maybeStartLandmark,
  LANDMARK_LABEL,
} from "./landmarks";
import { LEVEL_BIG_TOWER, partAnchor } from "./world";
import { buildBranches, maybePlanBranch } from "./branch";
import { relaxAround, vertexFixed } from "./terraform";
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
  railIsStraightX,
  railIsStraightY,
  roadConnections,
  cornerHeights,
  MAX_HEIGHT,
} from "./world";

/** 建物レベルごとの人口 */
export const LEVEL_CAPACITY = [0, 4, 14, 40, 120, 0, 0, 0, 600] as const;
/** 建設にかかる日数 */
export const CONSTRUCTION_DAYS = [0, 3, 5, 9, 14, 20, 30, 24, 36] as const;
/** 建物レベルごとの階数 (描画用) */
export const LEVEL_FLOORS = [0, 1, 2, 5, 10, 1, 1, 1, 30] as const;

export const STATION_RADIUS = 22;

/** 計測用カウンタ */
export const stats = {
  starts: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  upgrades: 0,
  declines: 0,
  reuse: 0,
  roadAttempts: 0,
  roadTiles: 0,
  roadGated: 0,
  candidates: 0,
};
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
  if (hour === 0) dailyTasks(w, cal.month, cal.day, totalDays);
  if (hour === 6) seasonalNews(w, cal.month, cal.day);
  if (hour === 18) rerollLights(w);
  growRoads(w, 1, totalDays);
  growBuildings(w, hour, 1, totalDays);
}

function dailyTasks(
  w: World,
  month: number,
  day: number,
  totalDays: number,
): void {
  if (month === 11 && day === 1) w.snowSeen = false;
  if (totalDays % 10 === 0 && maybeOpenStation(w)) w.stationsChanged = true;
  if (totalDays % 10 === 5) maybePlanBranch(w);
  buildBranches(w);
  computeLandValue(w, totalDays);
  dailyAging(w);
  computePopulation(w);
  maybeStartLandmark(w);
  growStations(w);
  rebuildBuildingList(w);
}

/** 駅舎の大きさ (駅タイルの bLevel に入れる): 0=ホームだけ 1=駅舎 2=橋上駅舎 */
export const STATION_SIZE_BUILDINGS = [0, 30, 80] as const;

/** 周囲の建物が増えた駅の駅舎を大きくする。1 日 1 回。 */
function growStations(w: World): void {
  for (const st of w.stations) {
    const i = idx(w, st.x, st.y);
    if (w.kind[i] !== Kind.Station) continue;
    const cur = w.bLevel[i];
    if (cur >= 2) continue;
    let count = 0;
    for (let dy = -7; dy <= 7; dy++) {
      for (let dx = -7; dx <= 7; dx++) {
        const x = st.x + dx;
        const y = st.y + dy;
        if (!inBounds(w, x, y)) continue;
        const j = idx(w, x, y);
        if (w.kind[j] === Kind.Building && w.bState[j] === BState.Built) count++;
      }
    }
    let size = 0;
    for (let k = 1; k < STATION_SIZE_BUILDINGS.length; k++) if (count >= STATION_SIZE_BUILDINGS[k]) size = k;
    if (size <= cur) continue;
    w.bLevel[i] = cur + 1;
    w.events.push(cur + 1 === 2 ? `${st.name ?? ""}駅が橋上駅舎に建て替えられました` : `${st.name ?? ""}駅に駅舎ができました`);
  }
}

export function computeLandValue(w: World, totalDays: number): void {
  const years = totalDays / 360;
  const W = w.w;
  const H = w.h;
  const S = W + 1;
  const n = W * H;

  // 作業用バッファは使い回す (毎日 65k 要素を確保し直さない)
  const buf = landValueBuffers(w);
  const station = buf.station;
  station.fill(0);
  for (const st of w.stations) {
    const R = STATION_RADIUS;
    for (let y = Math.max(0, st.y - R); y <= Math.min(H - 1, st.y + R); y++) {
      for (let x = Math.max(0, st.x - R); x <= Math.min(W - 1, st.x + R); x++) {
        const d = Math.hypot(x - st.x, y - st.y);
        const v = Math.max(0, 1 - d / R);
        const i = y * W + x;
        if (v > station[i]) station[i] = v;
      }
    }
  }

  // 2. 密度と快適さは累積和で O(1) に
  const dens = buf.dens;
  const amen = buf.amen;
  const roadNear = buf.roadNear;
  dens.fill(0);
  amen.fill(0);
  roadNear.fill(0);
  for (let i = 0; i < n; i++) {
    const k = w.kind[i];
    if (k === Kind.Building) {
      if (w.bState[i] === BState.Built) dens[i] = Math.min(4, w.bLevel[i]);
      else if (w.bState[i] === BState.Abandoned) dens[i] = -1;
    } else if (k === Kind.Water || k === Kind.Park || k === Kind.Shrine)
      amen[i] = 1;
    if (isRoadLike(k)) roadNear[i] = 1;
  }
  const densSum = prefixSum(dens, W, H, buf.densSum);
  const amenSum = prefixSum(amen, W, H, buf.amenSum);

  // 3. 流行のノイズは 4 マスごとに計算して補間
  const G = 4;
  const gw = Math.floor(W / G) + 2;
  const gh = Math.floor(H / G) + 2;
  const drift = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      drift[gy * gw + gx] =
        (fbm(
          w.seed + 500,
          (gx * G) / 12 + years * 0.35,
          (gy * G) / 12 - years * 0.2,
          2,
        ) -
          0.5) *
        44;
    }
  }

  for (let y = 0; y < H; y++) {
    const gy = Math.floor(y / G);
    const fy = (y - gy * G) / G;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (w.water[i]) {
        w.value[i] = 0;
        continue;
      }
      let v = 72 * Math.pow(station[i], 1.4);
      // 道路は地価を少ししか上げない (建物が集まってはじめて上がる)
      if (
        (x > 0 && roadNear[i - 1]) ||
        (x < W - 1 && roadNear[i + 1]) ||
        (y > 0 && roadNear[i - W]) ||
        (y < H - 1 && roadNear[i + W])
      )
        v += 4;
      const density =
        rectSum(densSum, W, H, x - 2, y - 2, x + 2, y + 2) - dens[i];
      const amenity = rectSum(amenSum, W, H, x - 1, y - 1, x + 1, y + 1) * 5;
      v += Math.min(48, density * 1.1);
      v += Math.min(12, amenity);
      v += w.height[y * S + x] * 2;
      const gx = Math.floor(x / G);
      const fx = (x - gx * G) / G;
      const d00 = drift[gy * gw + gx];
      const d10 = drift[gy * gw + gx + 1];
      const d01 = drift[(gy + 1) * gw + gx];
      const d11 = drift[(gy + 1) * gw + gx + 1];
      v +=
        (d00 * (1 - fx) + d10 * fx) * (1 - fy) +
        (d01 * (1 - fx) + d11 * fx) * fy;
      w.value[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

interface LandValueBuffers {
  station: Float32Array;
  dens: Int16Array;
  amen: Uint8Array;
  roadNear: Uint8Array;
  densSum: Int32Array;
  amenSum: Int32Array;
}
const landValueBufferCache = new WeakMap<World, LandValueBuffers>();
function landValueBuffers(w: World): LandValueBuffers {
  let b = landValueBufferCache.get(w);
  if (!b) {
    const n = w.w * w.h;
    const m = (w.w + 1) * (w.h + 1);
    b = { station: new Float32Array(n), dens: new Int16Array(n), amen: new Uint8Array(n), roadNear: new Uint8Array(n), densSum: new Int32Array(m), amenSum: new Int32Array(m) };
    landValueBufferCache.set(w, b);
  }
  return b;
}

/** (W+1)x(H+1) の二次元累積和 */
function prefixSum(src: ArrayLike<number>, W: number, H: number, P: Int32Array): Int32Array {
  P.fill(0);
  for (let y = 1; y <= H; y++) {
    let row = 0;
    for (let x = 1; x <= W; x++) {
      row += src[(y - 1) * W + (x - 1)];
      P[y * (W + 1) + x] = P[(y - 1) * (W + 1) + x] + row;
    }
  }
  return P;
}

function rectSum(
  P: Int32Array,
  W: number,
  H: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(W - 1, x1);
  y1 = Math.min(H - 1, y1);
  const S = W + 1;
  return (
    P[(y1 + 1) * S + x1 + 1] -
    P[y0 * S + x1 + 1] -
    P[(y1 + 1) * S + x0] +
    P[y0 * S + x0]
  );
}

function dailyAging(w: World): void {
  const n = w.w * w.h;
  for (let i = 0; i < n; i++) {
    const k = w.kind[i];
    if (k === Kind.Building) {
      if (w.bState[i] === BState.Built && w.bAge[i] < 65000) w.bAge[i]++;
      if (w.bState[i] === BState.Abandoned && w.lotTimer[i] < 255)
        w.lotTimer[i]++;
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
    if (w.kind[i] === Kind.Building && w.rng.chance(0.3))
      w.lights[i] = w.rng.int(16);
  }
}

/** 道路・建物の数。1 日 1 回だけ数え直す */
function countKinds(
  w: World,
  totalDays: number,
): { roads: number; buildings: number } {
  const c = w.cache;
  if (c.countedDay !== totalDays || c.roads < 0) {
    let roads = 0;
    let buildings = 0;
    const n = w.w * w.h;
    for (let i = 0; i < n; i++) {
      const k = w.kind[i];
      if (k === Kind.Road) roads++;
      else if (k === Kind.Building && w.bState[i] !== BState.Abandoned)
        buildings++;
    }
    c.roads = roads;
    c.buildingCount = buildings;
    c.countedDay = totalDays;
  }
  return { roads: c.roads, buildings: c.buildingCount };
}

interface RoadCandidate {
  tiles: number[]; // 変換するタイル index の列 (順番に)
  kinds: Kind[];
  weight: number;
  from: number;
  dir: number;
  /** 造成が必要なときの目標の高さ */
  earthwork?: number;
}

/** 道路の延伸候補を調べる。延伸できなければ null。 */
export function roadExtension(
  w: World,
  x: number,
  y: number,
  dir: number,
): { tiles: number[]; kinds: Kind[]; earthwork?: number } | null {
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
    const alongX = railIsStraightX(rc);
    const alongY = railIsStraightY(rc);
    const perpendicular =
      (alongX && (dir === 0 || dir === 2)) ||
      (alongY && (dir === 1 || dir === 3));
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
    if (!shapeOk(tx, ty)) return null;
    if (passableAlong(w, tx, ty, dir))
      return { tiles: [ti], kinds: [Kind.Road] };
    // 通れない斜面: 手前の辺の高さ h に合わせ、奥の辺を h-1..h+1 のどれかに揃えて造成する (平地か進行方向の坂になる)
    const h = edgeHeight(w, x, y, dir);
    if (h < 0) return null;
    const hf = farEdgeTarget(w, tx, ty, dir, h);
    if (hf < 0) return null;
    return { tiles: [ti], kinds: [Kind.Road], earthwork: h * 4 + (hf - h + 1) };
  }
  return null;
}

/** タイル (x,y) の dir 側 (奥) の辺の 2 頂点 */
function farEdgeVertices(
  w: World,
  x: number,
  y: number,
  dir: number,
): [number, number][] {
  // T=(x,y) R=(x+1,y) B=(x+1,y+1) L=(x,y+1)。dir の奥の辺: N→T,R  E→R,B  S→B,L  W→L,T
  const T: [number, number] = [x, y];
  const R: [number, number] = [x + 1, y];
  const B: [number, number] = [x + 1, y + 1];
  const L: [number, number] = [x, y + 1];
  return dir === 0 ? [T, R] : dir === 1 ? [R, B] : dir === 2 ? [B, L] : [L, T];
}

/** 奥の辺を揃える高さ。固定頂点があればそれに合わせる。できなければ -1 */
function farEdgeTarget(
  w: World,
  tx: number,
  ty: number,
  dir: number,
  h: number,
): number {
  const S = w.w + 1;
  const far = farEdgeVertices(w, tx, ty, dir);
  const fixed = far.map(([vx, vy]) =>
    vertexFixed(w, vx, vy) ? w.height[vy * S + vx] : -1,
  );
  const cur = far.map(([vx, vy]) => w.height[vy * S + vx]);
  const avg = Math.round((cur[0] + cur[1]) / 2);
  for (const hf of [avg, h, h - 1, h + 1]) {
    if (hf < 0 || hf > MAX_HEIGHT || Math.abs(hf - h) > 1) continue;
    if (fixed.every((f) => f < 0 || f === hf)) return hf;
  }
  return -1;
}

/** 造成を実行: 手前の辺を h、奥の辺を hf にする */
export function applyEarthwork(
  w: World,
  tx: number,
  ty: number,
  dir: number,
  code: number,
): boolean {
  const h = Math.floor(code / 4);
  const hf = h + (code % 4) - 1;
  const S = w.w + 1;
  const near = farEdgeVertices(w, tx, ty, (dir + 2) % 4);
  const far = farEdgeVertices(w, tx, ty, dir);
  for (const [vx, vy] of near) {
    if (vertexFixed(w, vx, vy) && w.height[vy * S + vx] !== h) return false;
  }
  for (const [vx, vy] of far) {
    if (vertexFixed(w, vx, vy) && w.height[vy * S + vx] !== hf) return false;
  }
  for (const [vx, vy] of near) w.height[vy * S + vx] = h;
  for (const [vx, vy] of far) w.height[vy * S + vx] = hf;
  relaxAround(w, tx, ty);
  return true;
}

/** タイル (x,y) の dir 側の辺の高さ (両端が同じときだけ)。違えば -1 */
function edgeHeight(w: World, x: number, y: number, dir: number): number {
  const c = cornerHeights(w, x, y); // [T,R,B,L]
  const pair =
    dir === 0
      ? [c[0], c[1]]
      : dir === 1
        ? [c[1], c[2]]
        : dir === 2
          ? [c[2], c[3]]
          : [c[3], c[0]];
  return pair[0] === pair[1] ? pair[0] : -1;
}

function growRoads(w: World, hours: number, totalDays: number): void {
  const { roads, buildings } = countKinds(w, totalDays);
  let perDay = Math.min(1.4, 0.35 + buildings / 90);
  // 建物に対して道路が多すぎるときは伸ばさない (発展が止まれば道路も止まる)
  if (roads > buildings * 0.6 + 12) {
    stats.roadGated++;
    return;
  }
  if (roads > buildings * 0.45 + 8) perDay *= 0.4;
  const expected = (perDay * hours) / 24;
  let attempts = Math.floor(expected);
  if (w.rng.chance(expected - attempts)) attempts++;
  for (let a = 0; a < attempts; a++) {
    stats.roadAttempts++;
    extendRoadOnce(w);
  }
}

/** (x,y) から dir 方向に見て、道路が何マス続いているか */
function straightRunLength(
  w: World,
  x: number,
  y: number,
  dir: number,
): number {
  let n = 0;
  let cx = x + DX[dir];
  let cy = y + DY[dir];
  while (
    inBounds(w, cx, cy) &&
    w.kind[idx(w, cx, cy)] === Kind.Road &&
    n < 50
  ) {
    n++;
    cx += DX[dir];
    cy += DY[dir];
  }
  return n;
}

/** 近く (along 方向の前後 dist マス) に交差点や曲がり角があるか */
function nearJunction(w: World, x: number, y: number, dist: number): boolean {
  for (let d = 0; d < 4; d++) {
    let cx = x;
    let cy = y;
    for (let k = 1; k <= dist; k++) {
      cx += DX[d];
      cy += DY[d];
      if (!inBounds(w, cx, cy) || w.kind[idx(w, cx, cy)] !== Kind.Road) break;
      const conn = roadConnections(w, cx, cy);
      const straight = conn === (DIR_N | DIR_S) || conn === (DIR_E | DIR_W);
      if (!straight) return true;
    }
  }
  return false;
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
      const isStraightMid =
        degree === 2 && (conn === (DIR_N | DIR_S) || conn === (DIR_E | DIR_W));
      for (let d = 0; d < 4; d++) {
        if (conn & [DIR_N, DIR_E, DIR_S, DIR_W][d]) continue;
        const ext = roadExtension(w, x, y, d);
        if (!ext) continue;
        const last = ext.tiles[ext.tiles.length - 1];
        let weight = 1 + w.value[last] / 16;
        const oppositeBit = [DIR_S, DIR_W, DIR_N, DIR_E][d];
        const straight = (conn & oppositeBit) !== 0;
        if (straight && degree === 1) {
          // 行き止まりの先へまっすぐ。長い通りほど続きやすい
          weight *= 10 + Math.min(10, straightRunLength(w, x, y, (d + 2) % 4));
        } else if (straight) {
          weight *= 2; // 交差点から直進
        } else if (degree === 1) {
          // 行き止まりで曲がる: まっすぐ進めないときだけ
          const ahead = (d + 2) % 4; // 来た方向の反対 = 直進方向を求める
          void ahead;
          const fromDir = [DIR_N, DIR_E, DIR_S, DIR_W].indexOf(conn);
          const straightDir = (fromDir + 2) % 4;
          const canGoStraight = roadExtension(w, x, y, straightDir) !== null;
          weight *= canGoStraight ? 0.05 : 0.6;
        } else if (isStraightMid) {
          // 直線道路からの枝分かれ: 交差点や角から離れているところだけ
          weight *= nearJunction(w, x, y, 5) ? 0.003 : 0.08;
        } else {
          weight *= 0.05; // 交差点や角からさらに曲がる
        }
        if (ext.tiles.length > 1) weight *= 0.5; // 橋・踏切はやや珍しい
        // 別の道路に突き当たって交差点を作る延伸は控えめに
        if (
          popcount(roadConnections(w, last % w.w, Math.floor(last / w.w))) >=
            1 &&
          ext.tiles.length === 1
        ) {
          const m =
            roadConnections(w, last % w.w, Math.floor(last / w.w)) &
            ~[DIR_S, DIR_W, DIR_N, DIR_E][d];
          if (m !== 0) weight *= 0.35;
        }
        // 2〜3 マス隣に平行な道路があると街区が狭すぎるので抑える
        const lx = last % w.w;
        const ly = Math.floor(last / w.w);
        const px = d === 0 || d === 2 ? 2 : 0;
        const py = d === 1 || d === 3 ? 2 : 0;
        for (const sgn of [-1, 1]) {
          for (const [dist, pen] of [
            [2, 0.02],
            [3, 0.2],
          ] as const) {
            const qx = lx + (px / 2) * dist * sgn;
            const qy = ly + (py / 2) * dist * sgn;
            if (inBounds(w, qx, qy) && w.kind[idx(w, qx, qy)] === Kind.Road)
              weight *= pen;
          }
        }
        if (w.kind[last] === Kind.Forest) weight *= 0.7;
        if (ext.earthwork !== undefined) weight *= 0.15; // 造成が要る道は平地より珍しい
        candidates.push({
          tiles: ext.tiles,
          kinds: ext.kinds,
          weight,
          from: i,
          dir: d,
          earthwork: ext.earthwork,
        });
        totalWeight += weight;
      }
    }
  }
  if (candidates.length === 0) return;
  stats.candidates += candidates.length;
  let r = w.rng.next() * totalWeight;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) {
      if (c.earthwork !== undefined) {
        const t = c.tiles[0];
        if (
          !applyEarthwork(w, t % w.w, Math.floor(t / w.w), c.dir, c.earthwork)
        )
          return;
      }
      for (let k = 0; k < c.tiles.length; k++) {
        w.kind[c.tiles[k]] = c.kinds[k];
        w.lotTimer[c.tiles[k]] = 0;
        stats.roadTiles++;
        if (c.kinds[k] === Kind.Road) w.cache.roads++;
      }
      // まっすぐ伸びる場合は、何マスか続けて伸ばして長い通りにする
      const extra = 1 + w.rng.int(3);
      let cx = c.tiles[c.tiles.length - 1] % w.w;
      let cy = Math.floor(c.tiles[c.tiles.length - 1] / w.w);
      for (let k = 0; k < extra; k++) {
        const ext = roadExtension(w, cx, cy, c.dir);
        if (!ext || ext.tiles.length !== 1 || ext.earthwork !== undefined)
          break;
        const ti = ext.tiles[0];
        w.kind[ti] = Kind.Road;
        w.lotTimer[ti] = 0;
        w.cache.roads++;
        cx = ti % w.w;
        cy = Math.floor(ti / w.w);
        // 別の道路に突き当たったら止まる
        if (popcount(roadConnections(w, cx, cy)) > 1) break;
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

/** 建物以外のタイルは 1 日 1 回だけ、タイルごとに違う時刻に調べる (確率は 1 日分) */
const PHASES = 24;

/** 位相ごとのタイルリストを作る (マップごとに 1 回) */
function phaseLists(w: World): Int32Array[] {
  if (w.cache.phases) return w.cache.phases;
  const counts = new Array(PHASES).fill(0);
  for (let y = 0; y < w.h; y++)
    for (let x = 0; x < w.w; x++) counts[(x * 7 + y * 13) % PHASES]++;
  const lists = counts.map((n) => new Int32Array(n));
  const fill = new Array(PHASES).fill(0);
  for (let y = 0; y < w.h; y++) {
    for (let x = 0; x < w.w; x++) {
      const ph = (x * 7 + y * 13) % PHASES;
      lists[ph][fill[ph]++] = y * w.w + x;
    }
  }
  w.cache.phases = lists;
  return lists;
}

/** 建物タイルのリストと、変化しうるタイルのマスクを作り直す (1 日 1 回) */
function rebuildBuildingList(w: World): void {
  const list: number[] = [];
  const W = w.w;
  const H = w.h;
  const n = W * H;
  const active = w.cache.active && w.cache.active.length === n ? w.cache.active : new Uint8Array(n);
  active.fill(0);
  for (let i = 0; i < n; i++) {
    const k = w.kind[i];
    if (k === Kind.Building) {
      list.push(i);
      continue;
    }
    if (k === Kind.Lot || w.value[i] >= 12) {
      active[i] = 1;
      continue;
    }
    if (k !== Kind.Grass && k !== Kind.Forest && k !== Kind.Farm && k !== Kind.FarmPath) continue;
    const x = i % W;
    const y = (i - x) / W;
    // 田畑の隣 (田畑の拡大・一軒家)、市街地に接する森 (公園化)
    const kind = w.kind;
    const forest = k === Kind.Forest;
    const test = (nk: number): boolean => nk === Kind.Farm || nk === Kind.FarmPath || (forest && (nk === Kind.Building || nk === Kind.Road));
    if ((x > 0 && test(kind[i - 1])) || (x < W - 1 && test(kind[i + 1])) || (y > 0 && test(kind[i - W])) || (y < H - 1 && test(kind[i + W]))) active[i] = 1;
  }
  w.cache.buildings = list;
  w.cache.active = active;
}

function growBuildings(
  w: World,
  hour: number,
  hours: number,
  totalDays: number,
): void {
  const W = w.w;
  void hours;
  void totalDays;
  const P = 24;
  // 建物: 毎時間、リストを回す (取り壊されたものは飛ばす)
  for (const i of w.cache.buildings) {
    if (w.kind[i] === Kind.Building) stepBuilding(w, i, 1);
  }
  // それ以外: この時間の位相のタイルだけ
  const list = phaseLists(w)[((hour % PHASES) + PHASES) % PHASES];
  const active = w.cache.active;
  for (let n = 0; n < list.length; n++) {
    const i = list[n];
    if (active && !active[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    const k = w.kind[i];
    if (k === Kind.Building) continue;
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
      if (urban >= 4 && w.rng.chance((0.08 * P) / 24)) w.kind[i] = Kind.Park;
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
      if (farms >= 2 && w.rng.chance((0.08 * P) / 24)) {
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
          if (inBounds(w, mx, my) && w.kind[idx(w, mx, my)] === Kind.Road)
            roadDist = 2;
        }
      }
    }
    if (roadDist === 0) {
      // 道路から 2 マス (間に 1 マス挟む) なら、家だけがまれに建つ
      for (const [ox, oy] of OFFSETS_DIST2) {
        const nx = x + ox;
        const ny = y + oy;
        if (inBounds(w, nx, ny) && w.kind[idx(w, nx, ny)] === Kind.Road) {
          roadDist = 3;
          break;
        }
      }
    }
    if (roadDist === 0) {
      if (k === Kind.Lot && w.lotTimer[i] > 60 && w.rng.chance((0.1 * P) / 24))
        w.kind[i] = Kind.Grass;
      // ぽつんと一軒家: 田畑や農道のそばの野原に、ごくまれに
      if ((k === Kind.Grass || k === Kind.Farm) && w.value[i] < 24) {
        let rural = false;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (!inBounds(w, nx, ny)) continue;
          const nk = w.kind[idx(w, nx, ny)];
          if (nk === Kind.Farm || nk === Kind.FarmPath) rural = true;
        }
        if (rural && w.rng.chance((0.0003 * P) / 24)) {
          startConstruction(w, i, 0);
        }
      }
      continue;
    }
    const v = w.value[i];
    let pDay = Math.pow(v / 100, 2.2) * 0.5;
    if (roadDist === 2) pDay *= 0.4;
    if (roadDist === 3) pDay *= 0.12;
    if (k === Kind.Lot) pDay *= 3;
    if (k === Kind.Forest) pDay *= 0.6;
    if (k === Kind.Farm) pDay *= 0.5;
    if (v < 12) pDay = 0;
    if (w.rng.chance((pDay * P) / 24)) {
      startConstruction(w, i, v, roadDist === 3 ? 1 : 4);
    } else if (
      k === Kind.Lot &&
      w.lotTimer[i] > 90 &&
      w.rng.chance((0.05 * P) / 24)
    ) {
      w.kind[i] = Kind.Grass;
    }
  }
}

/** 道路から 2 マス離れた位置 (マンハッタン距離 2) */
const OFFSETS_DIST2: readonly (readonly [number, number])[] = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function startConstruction(w: World, i: number, v: number, maxLevel = 4): void {
  let level = Math.min(maxLevel, levelForValue(v));
  if (level > 1 && w.rng.chance(0.4)) level--;
  if (level > 1 && w.rng.chance(0.25)) level--;
  // ランドマークの周りは低い建物にして、眺めを隠さない
  const x = i % w.w;
  const y = Math.floor(i / w.w);
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(w, nx, ny)) continue;
      const j = idx(w, nx, ny);
      if (w.kind[j] === Kind.Building && isLandmark(w.bLevel[j]))
        level = Math.min(level, 2);
    }
  }
  stats.starts[level]++;
  w.cache.buildings.push(i);
  w.kind[i] = Kind.Building;
  w.bLevel[i] = level;
  w.bStyle[i] = w.rng.int(256);
  if (level === 4) {
    // 高層ビルの階数は地価で決める (地価が高い中心部ほど高い)
    const extra = Math.max(
      0,
      Math.min(7, Math.floor((v - 88) / 9) + w.rng.int(2)),
    );
    w.bStyle[i] = (w.bStyle[i] & ~0x1c) | (extra << 2);
    // 地価がとても高ければ 2x2 のタワーに
    if (v >= 100 && w.rng.chance(0.6)) tryBigTower(w, i);
  }
  w.bState[i] = BState.Constructing;
  w.bProgress[i] = 0;
  w.bAge[i] = 0;
  w.lotTimer[i] = 0;
  w.lights[i] = w.rng.int(16);
}

/**
 * 左上 (x0,y0) の 2x2 区画が確保できるか。except のタイルは調べない。
 * 低い建物 (レベル maxLevel 以下、築 30 日以上、建設中でない) は取り壊してよいものとして扱う。
 */
export function bigSiteFree(w: World, x0: number, y0: number, except = -1, maxLevel = 4): boolean {
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w.w || y0 + 1 >= w.h) return false;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const j = idx(w, x0 + dx, y0 + dy);
      if (j === except) continue;
      const k = w.kind[j];
      const low =
        k === Kind.Building &&
        w.bLevel[j] <= maxLevel &&
        w.bState[j] !== BState.Constructing &&
        w.bAge[j] > 30;
      if (!(isBuildableGround(k) || low) || w.water[j] || !isFlat(w, x0 + dx, y0 + dy)) return false;
    }
  }
  return true;
}

/** 左上 (x0,y0) の 2x2 区画に建物 (level) を建て始める。アンカーは右下のタイル。 */
export function claimBigSite(w: World, x0: number, y0: number, level: number, style: number): number {
  const anchor = idx(w, x0 + 1, y0 + 1);
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const j = idx(w, x0 + dx, y0 + dy);
      if (j === anchor) continue;
      w.kind[j] = Kind.BuildingPart;
      w.bStyle[j] = (1 - dx) | ((1 - dy) << 1);
      w.bLevel[j] = 0;
      w.bState[j] = BState.None;
      w.lotTimer[j] = 0;
    }
  }
  w.kind[anchor] = Kind.Building;
  w.cache.buildings.push(anchor);
  w.bLevel[anchor] = level;
  w.bStyle[anchor] = style;
  w.bState[anchor] = BState.Constructing;
  w.bProgress[anchor] = 0;
  w.bAge[anchor] = 0;
  w.lotTimer[anchor] = 0;
  w.lights[anchor] = w.rng.int(16);
  return anchor;
}

/** (x,y) を含む 2x2 の区画が確保できれば、2x2 タワーにする */
function tryBigTower(w: World, i: number): void {
  const x = i % w.w;
  const y = Math.floor(i / w.w);
  for (const [ox, oy] of [
    [0, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
  ]) {
    const x0 = x + ox;
    const y0 = y + oy;
    if (!bigSiteFree(w, x0, y0, i)) continue;
    claimBigSite(w, x0, y0, LEVEL_BIG_TOWER, w.bStyle[i]);
    if (!(w.flags & 32)) {
      w.flags |= 32;
      w.events.push("超高層タワーの建設が始まりました");
    }
    return;
  }
}

/** 2x2 の建物をまるごと取り壊す (i はアンカーか部分) */
export function demolishBig(w: World, i: number): void {
  const anchor = w.kind[i] === Kind.BuildingPart ? partAnchor(w, i) : i;
  const ax = anchor % w.w;
  const ay = Math.floor(anchor / w.w);
  for (const [dx, dy] of [
    [0, 0],
    [-1, 0],
    [0, -1],
    [-1, -1],
  ]) {
    const x = ax + dx;
    const y = ay + dy;
    if (!inBounds(w, x, y)) continue;
    const j = idx(w, x, y);
    if (j === anchor || w.kind[j] === Kind.BuildingPart) demolish(w, j);
  }
}

function stepBuilding(w: World, i: number, hours: number): void {
  const state = w.bState[i];
  const level = w.bLevel[i];
  if (state === BState.Constructing) {
    const perStep = (255 / (CONSTRUCTION_DAYS[level] * 24)) * hours;
    // bProgress は整数なので、端数は確率で繰り上げる
    const inc = Math.floor(perStep) + (w.rng.chance(perStep % 1) ? 1 : 0);
    const p = w.bProgress[i] + inc;
    if (p >= 255) {
      w.bProgress[i] = 255;
      w.bState[i] = BState.Built;
      if (isLandmark(level)) {
        w.events.push(`${LANDMARK_LABEL[level]}が完成しました`);
      } else if (level === 4 && !(w.flags & FLAG_FIRST_TOWER)) {
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
  if (isPermanent(level)) return; // ランドマークと 2x2 タワーは壊れない
  let target = levelForValue(w.value[i]);
  if (target > 2) {
    const x = i % w.w;
    const y = Math.floor(i / w.w);
    for (let dy = -1; dy <= 2 && target > 2; dy++) {
      for (let dx = -1; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (
          inBounds(w, nx, ny) &&
          w.kind[idx(w, nx, ny)] === Kind.Building &&
          isLandmark(w.bLevel[idx(w, nx, ny)])
        )
          target = 2;
      }
    }
  }
  if (state === BState.Built) {
    if (target > level && w.bAge[i] > 25) {
      // 建て替え
      if (w.rng.chance((0.02 * (target - level) * hours) / 24)) {
        stats.upgrades++;
        demolish(w, i);
      }
    } else if (target < level - 1 || w.value[i] < 10) {
      // 衰退
      if (w.bAge[i] > 40 && w.rng.chance((0.04 * hours) / 24)) {
        w.bState[i] = BState.Abandoned;
        w.lotTimer[i] = 0;
      }
    }
    return;
  }
  if (state === BState.Abandoned) {
    if (target >= level && w.rng.chance((0.08 * hours) / 24)) {
      // 再利用
      w.bState[i] = BState.Built;
      w.bAge[i] = 0;
    } else if (w.lotTimer[i] > 15 && w.rng.chance((0.06 * hours) / 24)) {
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
  if (level === 2)
    return isMixedUse(level, style) ? 3 : ((style >> 4) & 3) === 2 ? 1 : 2;
  if (level === 3) return isMixedUse(level, style) ? 6 : 5;
  if (level === 4) return 12 + ((style >> 2) & 7) * 2; // 12〜26 階
  if (level === LEVEL_BIG_TOWER) return 28 + ((style >> 2) & 7) * 2; // 28〜42 階
  return LEVEL_FLOORS[level] ?? 1;
}

/** 建物の見た目上の階数 (建設中は進捗に応じて) */
export function visibleFloors(w: World, i: number): number {
  const total = buildingFloors(w.bLevel[i], w.bStyle[i]);
  if (w.bState[i] !== BState.Constructing) return total;
  return Math.min(total, Math.floor((w.bProgress[i] / 255) * (total + 1)));
}

export { cornerHeights };
