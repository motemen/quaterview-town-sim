import { fbm, hash2 } from "./rng";
import { makePlaceName } from "./names";
import { updateRailMask } from "./rail";
import { Kind, MAX_HEIGHT, Slope, World, idx, inBounds, isFlat, DX, DY, updateSlopes } from "./world";

/**
 * 地形を生成する。
 * - 頂点ベースの高さ (0..MAX_HEIGHT)。隣接頂点の差は 1 以下。
 * - 水面タイルの頂点は 0。
 * - 線路の通る頂点は 1 に固定 (築堤・切通しになる)。
 */
export function generateTerrain(w: World): void {
  const W = w.w;
  const H = w.h;
  const S = W + 1;
  const seed = w.seed;

  // 1. 線路の経路: 西端から東端へ。たまに南北に1つずれる。
  const railY0 = Math.floor(H * 0.4 + hash2(seed, 1, 2) * H * 0.2);
  let ry = railY0;
  const railTiles: [number, number][] = [];
  const onRail = new Uint8Array(W * H);
  let sinceJog = 0;
  for (let x = 0; x < W; x++) {
    railTiles.push([x, ry]);
    sinceJog++;
    const canJog = x > 4 && x < W - 8 && sinceJog > 10;
    if (canJog && hash2(seed + 77, x, 0) < 0.12) {
      // 斜め (135°) に 1〜3 マスずれて、また東へ
      const dir = hash2(seed + 78, x, 0) < 0.5 ? -1 : 1;
      const len = 1 + Math.floor(hash2(seed + 79, x, 0) * 3);
      for (let k = 0; k < len && x < W - 6; k++) {
        const ny = Math.min(H - 4, Math.max(3, ry + dir));
        if (ny === ry) break;
        x++;
        ry = ny;
        railTiles.push([x, ry]);
      }
      sinceJog = 0;
    }
  }
  for (const [x, y] of railTiles) onRail[idx(w, x, y)] = 1;
  // 東西にまっすぐな線路タイルか (ジョグの前後は曲線なので橋にしない)
  const straightRail = new Uint8Array(W * H);
  for (let k = 0; k < railTiles.length; k++) {
    const [x, y] = railTiles[k];
    const prev = railTiles[k - 1];
    const next = railTiles[k + 1];
    if ((!prev || prev[1] === y) && (!next || next[1] === y)) straightRail[idx(w, x, y)] = 1;
  }

  // 2. 水面: マップの一辺が海。川が海と反対側から流れ込む。
  const waterSeed = seed ^ 0x5eed;
  const seaSide = Math.floor(hash2(seed, 7, 7) * 4); // 0=N 1=E 2=S 3=W
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = x / W;
      const ny = y / H;
      let coast = 1;
      if (seaSide === 0) coast = ny;
      else if (seaSide === 1) coast = 1 - nx;
      else if (seaSide === 2) coast = 1 - ny;
      else coast = nx;
      // 岸の形をノイズで乱す
      const wobble = (fbm(waterSeed + 3, x / 9, y / 9, 2) - 0.5) * 0.3;
      w.water[idx(w, x, y)] = coast + wobble < 0.1 ? 1 : 0;
    }
  }
  // 川: 海と反対側の辺から海へ向かって蛇行する。線路の近くではまっすぐ渡る。
  const riverCount = hash2(seed, 3, 3) < 0.35 ? 2 : 1;
  for (let r = 0; r < riverCount; r++) {
    const vertical = seaSide === 0 || seaSide === 2; // 南北に流れる
    const len = vertical ? H : W;
    const span = vertical ? W : H;
    let lateral = Math.floor(span * 0.25 + hash2(seed + 11, r, 0) * span * 0.5);
    for (let k = 0; k < len; k++) {
      // 海側に向かって進む
      const along = seaSide === 0 || seaSide === 3 ? len - 1 - k : k;
      const drift = (fbm(waterSeed + 40 + r * 7, k / 6, r * 3, 2) - 0.5) * 3.2;
      const step = Math.round(drift);
      const x0 = vertical ? lateral : along;
      const y0 = vertical ? along : lateral;
      const nearRail = vertical ? Math.abs(y0 - railYAt(railTiles, x0)) <= 2 : false;
      const wide = k > len * 0.6;
      const mark = (x: number, y: number) => {
        if (!inBounds(w, x, y)) return;
        w.water[idx(w, x, y)] = 1;
      };
      mark(x0, y0);
      if (wide) vertical ? mark(x0 + 1, y0) : mark(x0, y0 + 1);
      if (!nearRail && step !== 0) {
        const s = Math.max(-1, Math.min(1, step));
        lateral = Math.max(2, Math.min(span - 3, lateral + s));
        // 斜めにならないように繋ぐ
        vertical ? mark(lateral, y0) : mark(x0, lateral);
        if (wide) vertical ? mark(lateral + 1, y0) : mark(x0, lateral + 1);
      }
    }
  }
  // 池: 低地に小さな水たまりを 2〜4 個
  const areaScale = (W * H) / 4096;
  const pondCount = Math.round((3 + Math.floor(hash2(seed, 5, 5) * 4)) * areaScale);
  for (let n = 0; n < pondCount; n++) {
    const cx = 4 + Math.floor(hash2(seed + 61, n, 0) * (W - 8));
    const cy = 4 + Math.floor(hash2(seed + 62, n, 0) * (H - 8));
    if (Math.abs(cy - railYAt(railTiles, cx)) < 4) continue;
    const rx = 1 + hash2(seed + 63, n, 0) * 1.6;
    const ry = 1 + hash2(seed + 64, n, 0) * 1.6;
    // 周囲も含めて低地 (高さノイズが 0 の範囲) であること
    let lowland = true;
    for (let vy = cy - 3; vy <= cy + 4 && lowland; vy++) {
      for (let vx = cx - 3; vx <= cx + 4; vx++) {
        if (vx < 0 || vy < 0 || vx > W || vy > H) continue;
        if (fbm(seed, vx / 13, vy / 13, 3) > 0.47) {
          lowland = false;
          break;
        }
      }
    }
    if (!lowland) continue;
    for (let y = cy - 3; y <= cy + 3; y++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        if (!inBounds(w, x, y)) continue;
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + (hash2(seed + 65, x, y) - 0.5) * 0.6;
        if (d < 1) w.water[idx(w, x, y)] = 1;
      }
    }
  }
  // 線路のカーブ部分は水面にしない。陸上の線路の周囲 8 近傍も水面にしない (築堤を保つ)。
  for (const [x, y] of railTiles) {
    const i = idx(w, x, y);
    if (!straightRail[i]) w.water[i] = 0;
  }
  const bridgeColumn = new Uint8Array(W);
  for (const [x, y] of railTiles) if (w.water[idx(w, x, y)]) bridgeColumn[x] = 1;
  for (const [x, y] of railTiles) {
    const i = idx(w, x, y);
    if (w.water[i]) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(w, nx, ny)) continue;
        const j = idx(w, nx, ny);
        if (!onRail[j] && !bridgeColumn[nx]) w.water[j] = 0;
      }
    }
  }

  // 3. 頂点高さ: ノイズを量子化
  const fixed = new Uint8Array(S * S);
  for (let vy = 0; vy < S; vy++) {
    for (let vx = 0; vx < S; vx++) {
      const n = fbm(seed, vx / 13, vy / 13, 3); // 0..1
      let h = 0;
      if (n > 0.73) h = 3;
      else if (n > 0.63) h = 2;
      else if (n > 0.5) h = 1;
      w.height[vy * S + vx] = Math.min(h, MAX_HEIGHT);
    }
  }

  // 4. 水面タイルの頂点は 0、陸上の線路の頂点は 1 に固定 (水面優先)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!w.water[idx(w, x, y)]) continue;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = (y + dy) * S + (x + dx);
        w.height[i] = 0;
        fixed[i] = 1;
      }
    }
  }
  // 線路の頂点は 1 に固定。鉄橋 (水面上) も同じ高さにして、坂を作らない
  for (const [x, y] of railTiles) {
    w.kind[idx(w, x, y)] = Kind.Rail;
    const bridge = w.water[idx(w, x, y)] === 1;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const i = (y + dy) * S + (x + dx);
      if (!fixed[i] || bridge) {
        w.height[i] = 1;
        fixed[i] = 1;
      }
    }
  }

  // 5. 隣接頂点の高さ差を 1 以下にし、線路が通れる形に整える
  fixRailGeometry(w, railTiles, straightRail, fixed);

  // 6. 水面でない、線路でもないタイルを草地/森に
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(w, x, y);
      if (w.water[i]) {
        if (w.kind[i] !== Kind.Rail) w.kind[i] = Kind.Water;
        continue;
      }
      if (w.kind[i] === Kind.Rail) continue;
      const f = fbm(seed + 31, x / 7, y / 7, 2);
      const hilly = w.height[y * S + x] >= 2;
      w.kind[i] = f > 0.58 || (hilly && f > 0.5) ? Kind.Forest : Kind.Grass;
    }
  }

  // 7. 駅: 線路の中央付近で、南側か北側が陸のところ。駅前は平らに均す。
  placeInitialStation(w, railTiles, straightRail, fixed);

  // 8. 田畑: 平らな低地に長方形の区画を置く
  placeFarms(w);

  // 9. 神社: 森の中の平地に
  placeShrine(w);

  updateRailMask(w);
}

function placeShrine(w: World): void {
  const S = w.w + 1;
  const count = Math.max(1, Math.round(((w.w * w.h) / 4096) * 0.7));
  const placed: [number, number][] = [];
  for (let n = 0; n < count; n++) {
    let best = -1;
    let bestScore = -Infinity;
    for (let y = 2; y < w.h - 2; y++) {
      for (let x = 2; x < w.w - 2; x++) {
        const i = idx(w, x, y);
        if (w.kind[i] !== Kind.Forest || !isFlat(w, x, y)) continue;
        // 参道 (南側) も平らな陸地であること
        const pi = idx(w, x, y + 1);
        if (w.water[pi] || !isFlat(w, x, y + 1) || (w.kind[pi] !== Kind.Forest && w.kind[pi] !== Kind.Grass)) continue;
        // 既存の神社から離れていること
        let tooClose = false;
        for (const [sx, sy] of placed) if (Math.hypot(sx - x, sy - y) < 24) tooClose = true;
        if (tooClose) continue;
        let forest = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inBounds(w, x + dx, y + dy) && w.kind[idx(w, x + dx, y + dy)] === Kind.Forest) forest++;
        const h = w.height[y * S + x];
        const d = w.stations.length ? Math.hypot(w.stations[0].x - x, w.stations[0].y - y) : 20;
        const score = forest + h * 4 - (n === 0 ? Math.abs(d - 12) * 0.8 : 0) + hash2(w.seed, x, y) * 3;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    if (best < 0) return;
    w.kind[best] = Kind.Shrine;
    w.kind[best + w.w] = Kind.FarmPath; // 参道
    placed.push([best % w.w, Math.floor(best / w.w)]);
  }
}

function placeFarms(w: World): void {
  const S = w.w + 1;
  const rng = w.rng;
  const patches = Math.round((26 + rng.int(10)) * ((w.w * w.h) / 4096));
  for (let n = 0; n < patches; n++) {
    const pw = 3 + rng.int(4);
    const ph = 3 + rng.int(4);
    const x0 = rng.int(w.w - pw);
    const y0 = rng.int(w.h - ph);
    const roll = rng.next();
    const style = roll < 0.5 ? 0 : roll < 0.8 ? 1 : roll < 0.92 ? 2 : 3; // 田 / 畑 / 花畑 / 果樹園
    const orient = rng.int(2) * 4;
    // 区画内の各タイルが平らな草地なら田畑にする (一部欠けてもよい)
    let placed = 0;
    for (let y = y0; y < y0 + ph; y++) {
      for (let x = x0; x < x0 + pw; x++) {
        const i = idx(w, x, y);
        if (w.kind[i] !== Kind.Grass && w.kind[i] !== Kind.Forest) continue;
        if (!isFlat(w, x, y) || w.height[y * S + x] > 1) continue;
        // 駅前には置かない
        if (w.stations.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) <= 2)) continue;
        w.kind[i] = Kind.Farm;
        w.bStyle[i] = style | orient;
        placed++;
      }
    }
    // 区画の縁に農道を通す
    if (placed > 0 && rng.chance(0.7)) {
      const south = rng.chance(0.5);
      for (let k = -1; k <= (south ? pw : ph); k++) {
        const x = south ? x0 + k : x0 + pw;
        const y = south ? y0 + ph : y0 + k;
        if (!inBounds(w, x, y)) continue;
        const i = idx(w, x, y);
        if ((w.kind[i] === Kind.Grass || w.kind[i] === Kind.Forest) && isFlat(w, x, y) && !w.water[i]) w.kind[i] = Kind.FarmPath;
      }
    }
  }
}

/**
 * 線路タイルが通れる形になるまで、頂点を下げて整える。
 * 直線 (東西) の線路は平地か東西方向の坂、カーブ・駅は平地でなければならない。
 */
function fixRailGeometry(w: World, railTiles: [number, number][], straightRail: Uint8Array, fixed: Uint8Array): void {
  const S = w.w + 1;
  for (let iter = 0; iter < 16; iter++) {
    relax(w, fixed);
    updateSlopes(w);
    let changed = false;
    for (const [x, y] of railTiles) {
      const i = idx(w, x, y);
      const s = w.slope[i] as Slope;
      const needFlat = !straightRail[i] || w.kind[i] === Kind.Station;
      const bad = s === Slope.Irregular || s === Slope.AlongY || (needFlat && s !== Slope.Flat);
      if (!bad) continue;
      const vs = [y * S + x, y * S + x + 1, (y + 1) * S + x, (y + 1) * S + x + 1];
      const m = Math.min(...vs.map((v) => w.height[v]));
      for (const v of vs) {
        w.height[v] = m;
        fixed[v] = 1;
      }
      changed = true;
    }
    if (!changed) return;
  }
}

function railYAt(railTiles: [number, number][], x: number): number {
  for (const [rx, ry] of railTiles) if (rx === x) return ry;
  return -100;
}

function relax(w: World, fixed: Uint8Array): void {
  const S = w.w + 1;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (let vy = 0; vy < S; vy++) {
      for (let vx = 0; vx < S; vx++) {
        const i = vy * S + vx;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const nx = vx + dx;
          const ny = vy + dy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const j = ny * S + nx;
          if (w.height[i] > w.height[j] + 1) {
            if (!fixed[i]) {
              w.height[i] = w.height[j] + 1;
              changed = true;
            } else if (!fixed[j]) {
              w.height[j] = w.height[i] - 1;
              changed = true;
            }
          }
        }
      }
    }
  }
}

function placeInitialStation(w: World, railTiles: [number, number][], straightRail: Uint8Array, fixed: Uint8Array): void {
  const S = w.w + 1;
  const mid = Math.floor(railTiles.length / 2);
  const tryAt = (x: number, y: number, force: boolean): boolean => {
    const i = idx(w, x, y);
    if (w.water[i] || !straightRail[i]) return false;
    if (!force && !isFlat(w, x, y)) return false;
    for (const plazaDir of [2, 0]) {
      const px = x + DX[plazaDir];
      const py = y + DY[plazaDir];
      if (!inBounds(w, px, py)) continue;
      const pi = idx(w, px, py);
      if (w.water[pi] || w.kind[pi] === Kind.Rail) continue;
      // 駅前広場を駅と同じ高さに均す
      const h = w.height[y * S + x];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const v = (py + dy) * S + (px + dx);
        w.height[v] = h;
        fixed[v] = 1;
      }
      w.kind[i] = Kind.Station;
      w.kind[pi] = Kind.Road;
      w.stations.push({ x, y, plazaDir, name: makePlaceName(w.rng) });
      return true;
    }
    return false;
  };
  for (let k = 0; k < railTiles.length; k++) {
    const t = railTiles[mid + (k % 2 === 0 ? k / 2 : -(k + 1) / 2)];
    if (t && tryAt(t[0], t[1], false)) break;
  }
  if (w.stations.length === 0) {
    for (let k = 0; k < railTiles.length; k++) {
      const t = railTiles[mid + (k % 2 === 0 ? k / 2 : -(k + 1) / 2)];
      if (t && tryAt(t[0], t[1], true)) break;
    }
  }
  fixRailGeometry(w, railTiles, straightRail, fixed);
}
