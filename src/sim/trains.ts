import { railPath, stationIndices } from "./rail";
import { World, idx, Kind } from "./world";

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

/** 路線: 本線 (端から端へ抜ける) か支線 (往復) */
export interface Line {
  path: [number, number][];
  stations: number[];
  trains: Train[];
  shuttle: boolean;
  spawnTimer: number;
  nextDir: 1 | -1;
  batchLeft: number;
}

const CAR_SPACING = 0.78;
const STOP_SECONDS = 1.8;
const TRAIN_CARS = 3;
const SHUTTLE_CARS = 2;

/** シミュレーション速度に対する列車の見た目の速さ (タイル/秒) */
function tilesPerSecond(simSpeed: number): number {
  if (simSpeed <= 0) return 0;
  if (simSpeed <= 1) return 7;
  if (simSpeed <= 4) return 12;
  return 18;
}

/** 列車の運行。保存はしない (再読み込みで消えてよい)。 */
export class TrainSystem {
  lines: Line[] = [];
  /** 踏切ごとの警報状態 (tile index) */
  activeCrossings = new Set<number>();
  blink = 0;

  constructor(w: World) {
    this.refresh(w);
  }

  /** 本線の経路 (互換用) */
  get path(): [number, number][] {
    return this.lines[0]?.path ?? [];
  }
  get stations(): number[] {
    return this.lines[0]?.stations ?? [];
  }
  get trains(): Train[] {
    return this.lines[0]?.trains ?? [];
  }

  refresh(w: World): void {
    const keep = new Map(this.lines.map((l) => [l.path.map((t) => t.join(",")).join(";"), l]));
    const next: Line[] = [];
    const mainPath = railPath(w);
    next.push(this.makeLine(w, mainPath, false, keep));
    for (const b of w.branches) {
      if (!b.done) continue;
      const st = w.stations[b.from];
      const path: [number, number][] = [[st.x, st.y], ...b.tiles];
      next.push(this.makeLine(w, path, true, keep));
    }
    this.lines = next;
  }

  private makeLine(w: World, path: [number, number][], shuttle: boolean, keep: Map<string, Line>): Line {
    const key = path.map((t) => t.join(",")).join(";");
    const old = keep.get(key);
    const stations = stationIndices(w, path);
    if (old) {
      old.stations = stations;
      return old;
    }
    return { path, stations, trains: [], shuttle, spawnTimer: shuttle ? 1 : 2, nextDir: -1, batchLeft: 0 };
  }

  update(w: World, dtReal: number, simSpeed: number): void {
    this.blink += dtReal;
    if (simSpeed <= 0) return;
    const v = tilesPerSecond(simSpeed) * dtReal;
    for (const line of this.lines) {
      if (line.path.length < 2) continue;
      if (line.shuttle) this.updateShuttle(line, v, dtReal);
      else this.updateMain(w, line, v, dtReal);
    }
    this.updateCrossings(w);
  }

  private moveAndStop(line: Line, t: Train, v: number): void {
    const prev = t.pos;
    t.pos += t.dir * v;
    for (const s of line.stations) {
      if (s === t.lastStop) continue;
      if ((t.dir > 0 && prev < s && t.pos >= s) || (t.dir < 0 && prev > s && t.pos <= s)) {
        t.pos = s;
        t.stopTimer = STOP_SECONDS;
        t.lastStop = s;
        break;
      }
    }
  }

  private updateMain(w: World, line: Line, v: number, dtReal: number): void {
    const len = line.path.length;
    for (const t of line.trains) {
      if (t.stopTimer > 0) {
        t.stopTimer -= dtReal;
        continue;
      }
      this.moveAndStop(line, t, v);
    }
    const margin = TRAIN_CARS * CAR_SPACING + 1;
    line.trains = line.trains.filter((t) => t.pos > -margin && t.pos < len - 1 + margin);
    // 単線なので同じ向きの列車をまとめて走らせ、全部抜けたら向きを変える
    line.spawnTimer -= dtReal;
    const maxTrains = Math.min(4, 1 + Math.floor(line.stations.length / 2) + Math.floor(len / 128));
    if (line.trains.length === 0) {
      if (line.spawnTimer <= 0) {
        line.nextDir = line.nextDir === 1 ? -1 : 1;
        line.batchLeft = maxTrains;
        this.spawnOne(line, len, margin);
        line.spawnTimer = Math.max(4, 16 - w.population / 800);
      }
    } else if (line.batchLeft > 0 && line.spawnTimer <= 0) {
      const dir = line.nextDir;
      const entry = dir > 0 ? -margin : len - 1 + margin;
      let nearest = Infinity;
      for (const t of line.trains) nearest = Math.min(nearest, Math.abs(t.pos - entry));
      if (nearest > 45) {
        this.spawnOne(line, len, margin);
        line.spawnTimer = 3;
      }
    }
  }

  /** 支線: 1 本の列車が両端の駅で折り返す */
  private updateShuttle(line: Line, v: number, dtReal: number): void {
    const len = line.path.length;
    if (line.trains.length === 0) {
      line.spawnTimer -= dtReal;
      if (line.spawnTimer <= 0) {
        line.trains.push({ pos: 0, dir: 1, cars: SHUTTLE_CARS, stopTimer: STOP_SECONDS, lastStop: 0 });
      }
      return;
    }
    const t = line.trains[0];
    if (t.stopTimer > 0) {
      t.stopTimer -= dtReal;
      return;
    }
    this.moveAndStop(line, t, v);
    const tail = (t.cars - 1) * CAR_SPACING;
    if (t.dir > 0 && t.pos >= len - 1) {
      t.pos = len - 1;
      t.dir = -1;
      t.stopTimer = STOP_SECONDS * 2;
      t.lastStop = len - 1;
    } else if (t.dir < 0 && t.pos <= tail) {
      t.pos = tail;
      t.dir = 1;
      t.stopTimer = STOP_SECONDS * 2;
      t.lastStop = 0;
    }
  }

  private spawnOne(line: Line, len: number, margin: number): void {
    const dir = line.nextDir;
    line.trains.push({ pos: dir > 0 ? -margin + 0.5 : len - 1 + margin - 0.5, dir, cars: TRAIN_CARS, stopTimer: 0, lastStop: -1 });
    line.batchLeft--;
  }

  private updateCrossings(w: World): void {
    this.activeCrossings.clear();
    for (const line of this.lines) {
      for (const t of line.trains) {
        const tail = t.pos - t.dir * (t.cars - 1) * CAR_SPACING;
        const lo = Math.min(t.pos, tail) - 1;
        const hi = Math.max(t.pos, tail) + 1;
        const aheadLo = t.dir > 0 ? t.pos : t.pos - 5;
        const aheadHi = t.dir > 0 ? t.pos + 5 : t.pos;
        for (let k = Math.max(0, Math.floor(Math.min(lo, aheadLo))); k <= Math.min(line.path.length - 1, Math.ceil(Math.max(hi, aheadHi))); k++) {
          const [x, y] = line.path[k];
          const i = idx(w, x, y);
          if (w.kind[i] === Kind.Crossing) this.activeCrossings.add(i);
        }
      }
    }
  }

  /** デバッグ用: 本線の指定位置に列車を置く */
  spawnAt(pos: number, dir: 1 | -1, stopSeconds = 0): void {
    this.lines[0]?.trains.push({ pos, dir, cars: TRAIN_CARS, stopTimer: stopSeconds, lastStop: -1 });
  }

  /** すべての路線の列車 */
  *allTrains(): Generator<[Line, Train]> {
    for (const line of this.lines) for (const t of line.trains) yield [line, t];
  }

  /** 各車両の位置と向き */
  carPoses(t: Train, line?: Line): CarPose[] {
    const ln = line ?? this.lines[0];
    const out: CarPose[] = [];
    for (let c = 0; c < t.cars; c++) {
      const p = t.pos - t.dir * c * CAR_SPACING;
      const pose = this.poseAt(ln, p, t.dir);
      if (!pose) continue;
      out.push({ ...pose, kind: c === 0 ? "head" : c === t.cars - 1 ? "tail" : "mid" });
    }
    return out;
  }

  private poseAt(line: Line, p: number, dir: 1 | -1): Omit<CarPose, "kind"> | null {
    const len = line.path.length;
    if (p < -0.5 || p > len - 0.5) return null;
    const k = Math.max(0, Math.min(len - 2, Math.floor(p)));
    const [ax, ay] = line.path[k];
    const [bx, by] = line.path[k + 1];
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
