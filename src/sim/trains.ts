import { railPath, stationIndices } from "./rail";
import { World, idx, isRailLike, Kind } from "./world";

export interface Train {
  /** 先頭車両の経路上の位置 (タイル単位) */
  pos: number;
  dir: 1 | -1;
  cars: number;
  /** 停車の残り秒 */
  stopTimer: number;
  /** 直前に停車した駅のインデックス */
  lastStop: number;
}

export interface CarPose {
  /** タイル座標 (小数) */
  tx: number;
  ty: number;
  /** 進行方向の軸: x=東西 y=南北 ne=北東-南西 (画面では水平) se=北西-南東 (画面では垂直) */
  axis: "x" | "y" | "ne" | "se";
  /** 軸に沿った向き (+1 = 東/南/北東/南東) */
  facing: 1 | -1;
  kind: "head" | "mid" | "tail";
}

const CAR_SPACING = 0.78;
const STOP_SECONDS = 1.8;
const TRAIN_CARS = 3;

/** シミュレーション速度に対する列車の見た目の速さ (タイル/秒) */
function tilesPerSecond(simSpeed: number): number {
  if (simSpeed <= 0) return 0;
  if (simSpeed <= 1) return 7;
  if (simSpeed <= 4) return 12;
  return 18;
}

/** 列車の運行。保存はしない (再読み込みで消えてよい)。 */
export class TrainSystem {
  path: [number, number][] = [];
  stations: number[] = [];
  trains: Train[] = [];
  private spawnTimer = 2;
  private nextDir: 1 | -1 = -1;
  private batchLeft = 0;
  /** 踏切ごとの警報状態 (tile index → true) */
  activeCrossings = new Set<number>();
  blink = 0;

  constructor(w: World) {
    this.refresh(w);
  }

  refresh(w: World): void {
    this.path = railPath(w);
    this.stations = stationIndices(w, this.path);
  }

  update(w: World, dtReal: number, simSpeed: number): void {
    this.blink += dtReal;
    if (simSpeed <= 0 || this.path.length < 2) return;
    const v = tilesPerSecond(simSpeed) * dtReal;
    const len = this.path.length;
    for (const t of this.trains) {
      if (t.stopTimer > 0) {
        t.stopTimer -= dtReal;
        continue;
      }
      const prev = t.pos;
      t.pos += t.dir * v;
      // 駅を通過したら停車
      for (const s of this.stations) {
        if (s === t.lastStop) continue;
        if ((t.dir > 0 && prev < s && t.pos >= s) || (t.dir < 0 && prev > s && t.pos <= s)) {
          t.pos = s;
          t.stopTimer = STOP_SECONDS;
          t.lastStop = s;
          break;
        }
      }
    }
    const margin = TRAIN_CARS * CAR_SPACING + 1;
    this.trains = this.trains.filter((t) => t.pos > -margin && t.pos < len - 1 + margin);
    // 単線なので同じ向きの列車をまとめて走らせ、全部抜けたら向きを変える
    this.spawnTimer -= dtReal;
    const maxTrains = Math.min(4, 1 + Math.floor(this.stations.length / 2) + Math.floor(len / 128));
    if (this.trains.length === 0) {
      if (this.spawnTimer <= 0) {
        this.nextDir = this.nextDir === 1 ? -1 : 1;
        this.batchLeft = maxTrains;
        this.spawnOne(len, margin);
        this.spawnTimer = Math.max(4, 16 - w.population / 800);
      }
    } else if (this.batchLeft > 0 && this.spawnTimer <= 0) {
      // 先行列車が十分進んでから次を出す
      const dir = this.nextDir;
      const entry = dir > 0 ? -margin : len - 1 + margin;
      let nearest = Infinity;
      for (const t of this.trains) nearest = Math.min(nearest, Math.abs(t.pos - entry));
      if (nearest > 45) {
        this.spawnOne(len, margin);
        this.spawnTimer = 3;
      }
    }
    this.updateCrossings(w);
  }

  private updateCrossings(w: World): void {
    this.activeCrossings.clear();
    for (const t of this.trains) {
      const tail = t.pos - t.dir * (t.cars - 1) * CAR_SPACING;
      const lo = Math.min(t.pos, tail) - 1;
      const hi = Math.max(t.pos, tail) + 1;
      const aheadLo = t.dir > 0 ? t.pos : t.pos - 5;
      const aheadHi = t.dir > 0 ? t.pos + 5 : t.pos;
      for (let k = Math.max(0, Math.floor(Math.min(lo, aheadLo))); k <= Math.min(this.path.length - 1, Math.ceil(Math.max(hi, aheadHi))); k++) {
        const [x, y] = this.path[k];
        const i = idx(w, x, y);
        if (w.kind[i] === Kind.Crossing) this.activeCrossings.add(i);
      }
    }
  }

  private spawnOne(len: number, margin: number): void {
    const dir = this.nextDir;
    this.trains.push({ pos: dir > 0 ? -margin + 0.5 : len - 1 + margin - 0.5, dir, cars: TRAIN_CARS, stopTimer: 0, lastStop: -1 });
    this.batchLeft--;
  }

  /** デバッグ用: 指定位置に列車を置く */
  spawnAt(pos: number, dir: 1 | -1, stopSeconds = 0): void {
    this.trains.push({ pos, dir, cars: TRAIN_CARS, stopTimer: stopSeconds, lastStop: -1 });
  }

  /** 各車両の位置と向き */
  carPoses(t: Train): CarPose[] {
    const out: CarPose[] = [];
    for (let c = 0; c < t.cars; c++) {
      const p = t.pos - t.dir * c * CAR_SPACING;
      const pose = this.poseAt(p, t.dir);
      if (!pose) continue;
      out.push({ ...pose, kind: c === 0 ? "head" : c === t.cars - 1 ? "tail" : "mid" });
    }
    return out;
  }

  private poseAt(p: number, dir: 1 | -1): Omit<CarPose, "kind"> | null {
    const len = this.path.length;
    if (p < -0.5 || p > len - 0.5) return null;
    const k = Math.max(0, Math.min(len - 2, Math.floor(p)));
    const [ax, ay] = this.path[k];
    const [bx, by] = this.path[k + 1];
    const t = p - k;
    const tx = ax + (bx - ax) * t;
    const ty = ay + (by - ay) * t;
    const sdx = bx - ax;
    const sdy = by - ay;
    let axis: CarPose["axis"];
    let seg: number;
    if (sdy === 0) {
      axis = "x";
      seg = sdx;
    } else if (sdx === 0) {
      axis = "y";
      seg = sdy;
    } else if (sdx * sdy < 0) {
      axis = "ne";
      seg = sdx;
    } else {
      axis = "se";
      seg = sdx;
    }
    const facing = (seg * dir > 0 ? 1 : -1) as 1 | -1;
    return { tx, ty, axis, facing };
  }
}

export function isOnRail(w: World, x: number, y: number): boolean {
  return isRailLike(w.kind[idx(w, x, y)]);
}
