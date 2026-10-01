import { visibleFloors } from "../sim/growth";
import { fbm, hash2 } from "../sim/rng";
import { CarPose, TrainSystem } from "../sim/trains";
import { BState, DX, DY, Kind, World, cornerHeights, idx, inBounds, railConnections, roadConnections, DIR_E, DIR_W } from "../sim/world";
import { HALF_H, HALF_W, LEVEL_H, TILE_H, TILE_W, heightAt, tileOrigin, uvToPixel } from "./iso";
import { PAL } from "./palette";
import { Sprite } from "./raster";
import {
  GroundKind,
  SeasonTint,
  buildingSprite,
  carSprite,
  crossingSprite,
  gateSprite,
  groundSprite,
  RAIL_BRIDGE_LIFT,
  railSprite,
  roadEmissive,
  roadSprite,
  stationSprite,
  orchardTreeSprite,
  shrineSprite,
  treeLightsSprite,
  treeSprite,
} from "./sprites";

/**
 * タイルを「本体」と「発光」の 2 つのキャンバスに描く。
 * 発光キャンバスには、本体を描くたびに同じ形で消去 (destination-out) して遮蔽を表現する。
 */
export class TilePainter {
  /** 季節 (0=春 1=夏 2=秋 3=冬) */
  season: SeasonTint = 0;
  /** 年末のイルミネーション */
  illumination = false;

  constructor(
    readonly world: World,
    readonly ctx: CanvasRenderingContext2D,
    readonly ectx: CanvasRenderingContext2D,
    /** ワールド座標 (タイル原点系) → キャンバス座標のオフセット */
    public originX: number,
    public originY: number,
  ) {}

  blit(s: Sprite, px: number, py: number, rel?: readonly [number, number, number, number]): void {
    if (rel && (rel[0] | rel[1] | rel[2] | rel[3]) !== 0) {
      const t = shearTransform(px, py, s.oy, rel);
      this.ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      this.ctx.drawImage(s.canvas, 0, 0);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ectx.globalCompositeOperation = "destination-out";
      this.ectx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      this.ectx.drawImage(s.canvas, 0, 0);
      this.ectx.setTransform(1, 0, 0, 1, 0, 0);
      this.ectx.globalCompositeOperation = "source-over";
      return;
    }
    this.ctx.drawImage(s.canvas, px - s.ox, py - s.oy);
    this.ectx.globalCompositeOperation = "destination-out";
    this.ectx.drawImage(s.canvas, px - s.ox, py - s.oy);
    this.ectx.globalCompositeOperation = "source-over";
  }

  blitEmissive(s: Sprite, px: number, py: number): void {
    this.ectx.drawImage(s.canvas, px - s.ox, py - s.oy);
  }

  /** タイル (x,y) の描画原点 (高さ 0 の平面上) */
  tileScreen(x: number, y: number): [number, number] {
    const [ox0, oy0] = tileOrigin(x, y);
    return [ox0 + this.originX, oy0 + this.originY];
  }

  drawTile(x: number, y: number, activeCrossings?: Set<number>, blinkOn = false): void {
    const w = this.world;
    const i = idx(w, x, y);
    const k = w.kind[i];
    const c = cornerHeights(w, x, y);
    const hmin = Math.min(c[0], c[1], c[2], c[3]);
    const rel = [c[0] - hmin, c[1] - hmin, c[2] - hmin, c[3] - hmin] as const;
    const [px0, py0] = this.tileScreen(x, y);
    const px = px0;
    const py = py0 - hmin * LEVEL_H;
    const variant = Math.floor(hash2(w.seed, x, y) * 8);
    const water = w.water[i] === 1;

    // 地面
    let ground: GroundKind = "grass";
    if (water) ground = "water";
    else if (k === Kind.Lot) ground = w.lotTimer[i] < 20 ? "rubble" : "lot";
    else if (k === Kind.Park) ground = "park";
    else if (k === Kind.Building) ground = w.bLevel[i] >= 2 ? "concrete" : "grass";
    else if (k === Kind.Farm) ground = (["paddy", "field", "flower", "orchard"] as const)[w.bStyle[i] & 3];
    else if (k === Kind.FarmPath) ground = "farmpath";
    else if (k === Kind.Shrine) ground = "grass";
    let gv = variant;
    if (ground === "grass") {
      // 野原の種類はゆるやかなノイズで決める (まとまって現れる)
      const m = fbm(w.seed + 900, x / 7, y / 7, 2);
      const meadow = m < 0.42 ? 3 : m < 0.5 ? 1 : m > 0.6 ? 2 : 0;
      gv = variant | (meadow << 3);
    }
    if (k === Kind.Farm) {
      // 畝の向き + 同じ種類の田畑と接していない縁
      let mask = 0;
      const type = w.bStyle[i] & 3;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        const same = inBounds(w, nx, ny) && w.kind[idx(w, nx, ny)] === Kind.Farm && (w.bStyle[idx(w, nx, ny)] & 3) === type;
        if (!same) mask |= 1 << d;
      }
      gv = ((w.bStyle[i] & 4) >> 2) | (mask << 1);
    }
    if (k === Kind.FarmPath) {
      // 隣の農道・道路の向きに合わせる
      const ew = (inBounds(w, x - 1, y) && (w.kind[idx(w, x - 1, y)] === Kind.FarmPath || w.kind[idx(w, x - 1, y)] === Kind.Road)) || (inBounds(w, x + 1, y) && (w.kind[idx(w, x + 1, y)] === Kind.FarmPath || w.kind[idx(w, x + 1, y)] === Kind.Road));
      gv = ew ? 1 : 0;
    }
    this.blit(groundSprite(ground, rel, gv, this.season), px, py);

    // マップの縁の断面
    if (x === w.w - 1 || y === w.h - 1) this.drawEdgeFace(x, y, px, py, rel);

    switch (k) {
      case Kind.Grass: {
        // まばらな木立: ノイズの高いところに 1〜2 本
        const wood = fbm(w.seed + 950, x / 5, y / 5, 2);
        if (wood > 0.58) {
          const count = wood > 0.68 ? 2 : 1;
          for (let n = 0; n < count; n++) {
            if (hash2(w.seed + 40 + n, x, y) > 0.55) continue;
            const u = 0.2 + hash2(w.seed + 41 + n, x, y) * 0.6;
            const v = 0.2 + hash2(w.seed + 42 + n, x, y) * 0.6;
            this.drawTree(px, py, rel, u, v, variant * 3 + n);
          }
        }
        break;
      }
      case Kind.Farm: {
        if ((w.bStyle[i] & 3) === 3) {
          for (const [u, v] of [
            [0.3, 0.3],
            [0.7, 0.3],
            [0.3, 0.7],
            [0.7, 0.7],
          ]) {
            const [lx, ly] = uvToPixel(u, v);
            const h = heightAt(rel, u, v) * LEVEL_H;
            this.blit(orchardTreeSprite(this.season), px + Math.round(lx), py + Math.round(ly - h));
          }
        }
        // 防風林: 区画の北や西の縁に木を並べる
        const type = w.bStyle[i] & 3;
        const northEdge = !(inBounds(w, x, y - 1) && w.kind[idx(w, x, y - 1)] === Kind.Farm && (w.bStyle[idx(w, x, y - 1)] & 3) === type);
        const westEdge = !(inBounds(w, x - 1, y) && w.kind[idx(w, x - 1, y)] === Kind.Farm && (w.bStyle[idx(w, x - 1, y)] & 3) === type);
        if (northEdge && hash2(w.seed + 70, 0, y) < 0.35) {
          this.drawTree(px, py, rel, 0.25, 0.06, variant * 5);
          this.drawTree(px, py, rel, 0.75, 0.06, variant * 5 + 1);
        } else if (westEdge && hash2(w.seed + 71, x, 0) < 0.35) {
          this.drawTree(px, py, rel, 0.06, 0.3, variant * 5 + 2);
          this.drawTree(px, py, rel, 0.06, 0.8, variant * 5 + 3);
        }
        break;
      }
      case Kind.Forest: {
        // 密度はノイズで変える (1〜4 本)
        const dens = fbm(w.seed + 960, x / 6, y / 6, 2);
        const spots: [number, number][] = [
          [0.3, 0.3],
          [0.7, 0.45],
          [0.4, 0.75],
          [0.75, 0.8],
        ];
        const want = dens < 0.4 ? 1 : dens < 0.5 ? 2 : dens < 0.62 ? 3 : 4;
        for (let n = 0; n < want; n++) {
          if (hash2(w.seed + n, x, y) < 0.1) continue;
          const [u, v] = spots[n];
          const ju = u + (hash2(w.seed + 11 + n, x, y) - 0.5) * 0.2;
          const jv = v + (hash2(w.seed + 17 + n, x, y) - 0.5) * 0.2;
          this.drawTree(px, py, rel, ju, jv, variant * 3 + n);
        }
        break;
      }
      case Kind.Shrine: {
        const sp = shrineSprite(this.season);
        this.blit(sp.base, px, py);
        if (sp.emissive) this.blitEmissive(sp.emissive, px, py);
        break;
      }
      case Kind.Park:
        this.drawTree(px, py, rel, 0.3, 0.3, variant, this.illumination);
        this.drawTree(px, py, rel, 0.72, 0.7, variant + 1, this.illumination);
        break;
      case Kind.Road: {
        const mask = roadConnections(w, x, y);
        this.blit(roadSprite(mask, water, this.season), px, py, rel);
        const em = roadEmissive(mask);
        if (em) this.blitEmissive(em, px, py);
        break;
      }
      case Kind.Rail:
        this.blit(railSprite(railConnections(w, x, y), water, this.season), px, py, rel);
        break;
      case Kind.Crossing: {
        const rm = railConnections(w, x, y);
        this.blit(crossingSprite(rm, roadConnections(w, x, y), this.season), px, py, rel);
        if (activeCrossings?.has(i)) {
          const g = gateSprite((rm & (DIR_E | DIR_W)) !== 0, blinkOn);
          this.blit(g.base, px, py);
          if (g.emissive) this.blitEmissive(g.emissive, px, py);
        }
        break;
      }
      case Kind.Station: {
        const st = w.stations.find((s) => s.x === x && s.y === y);
        const sp = stationSprite(st ? st.plazaDir : 2, this.season);
        this.blit(sp.base, px, py);
        if (sp.emissive) this.blitEmissive(sp.emissive, px, py);
        if (this.illumination) {
          const v = (st ? st.plazaDir : 2) === 2 ? 0.9 : 0.1;
          for (const u of [0.2, 0.5, 0.8]) {
            const [lx, ly] = uvToPixel(u, v);
            this.blitEmissive(treeLightsSprite(variant + Math.round(u * 10)), px + Math.round(lx), py + Math.round(ly) - 4);
          }
        }
        break;
      }
      case Kind.Building: {
        const sp = buildingSprite({
          level: w.bLevel[i],
          style: w.bStyle[i],
          floors: visibleFloors(w, i),
          state: w.bState[i] as BState,
          lights: w.lights[i],
        });
        this.blit(sp.base, px, py);
        if (sp.emissive) this.blitEmissive(sp.emissive, px, py);
        break;
      }
      default:
        break;
    }
  }

  /** 車両の中心 (地面) の画面座標 */
  carScreen(pose: CarPose): [number, number] {
    const w = this.world;
    const tx = Math.max(0, Math.min(w.w - 1, Math.floor(pose.tx + 0.5)));
    const ty = Math.max(0, Math.min(w.h - 1, Math.floor(pose.ty + 0.5)));
    const c = cornerHeights(w, tx, ty);
    const u = pose.tx - tx + 0.5;
    const v = pose.ty - ty + 0.5;
    let h = heightAt(c, u, v) * LEVEL_H;
    // 鉄橋の上は桁のぶん高い
    if (w.water[idx(w, tx, ty)] && w.kind[idx(w, tx, ty)] === Kind.Rail) h += RAIL_BRIDGE_LIFT;
    const [sx, sy] = this.tileScreen(tx, ty);
    const [lx, ly] = uvToPixel(u, v);
    return [Math.round(sx + lx), Math.round(sy + ly - h)];
  }

  /** 車両を描く。位置はタイル座標 (小数)。 */
  drawCar(pose: CarPose): void {
    const [cx, cy] = this.carScreen(pose);
    const sp = carSprite({ axis: pose.axis, facing: pose.facing, kind: pose.kind });
    this.blit(sp.base, cx, cy);
    if (sp.emissive) this.blitEmissive(sp.emissive, cx, cy);
  }

  private drawTree(px: number, py: number, rel: readonly [number, number, number, number], u: number, v: number, variant: number, lights = false): void {
    const [lx, ly] = uvToPixel(u, v);
    const h = heightAt(rel, u, v) * LEVEL_H;
    if (lights) {
      const tx = px + Math.round(lx);
      const ty = py + Math.round(ly - h);
      this.blit(treeSprite(variant, this.season === 3 ? 3 : 0), tx, ty);
      this.blitEmissive(treeLightsSprite(variant), tx, ty);
      return;
    }
    // 春は一部が桜、秋は多くが紅葉、冬は雪をかぶる
    let tint = 0;
    if (this.season === 0 && variant % 4 === 0) tint = 1;
    else if (this.season === 2 && variant % 3 !== 0) tint = 2;
    else if (this.season === 3) tint = 3;
    this.blit(treeSprite(variant, tint), px + Math.round(lx), py + Math.round(ly - h));
  }

  private drawEdgeFace(x: number, y: number, px: number, py: number, rel: readonly [number, number, number, number]): void {
    const w = this.world;
    const depth = 26;
    const R: [number, number] = [px + TILE_W, py + HALF_H - rel[1] * LEVEL_H];
    const B: [number, number] = [px + HALF_W, py + TILE_H - rel[2] * LEVEL_H];
    const L: [number, number] = [px, py + HALF_H - rel[3] * LEVEL_H];
    const base = py + TILE_H + depth;
    const face = (a: [number, number], b: [number, number], color: string) => {
      for (const [c, erase] of [
        [this.ctx, false],
        [this.ectx, true],
      ] as const) {
        c.globalCompositeOperation = erase ? "destination-out" : "source-over";
        c.fillStyle = color;
        c.beginPath();
        c.moveTo(a[0], a[1]);
        c.lineTo(b[0], b[1]);
        c.lineTo(b[0], base);
        c.lineTo(a[0], base);
        c.closePath();
        c.fill();
        c.globalCompositeOperation = "source-over";
      }
    };
    const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
    if (y === w.h - 1) face(L, B, rgb(PAL.earth));
    if (x === w.w - 1) face(B, R, rgb(PAL.earthDark));
  }
}

/** マップ全体を 1 枚の静的レイヤーとして描き、更新があったときだけ描き直す。 */
export class MapLayer {
  readonly canvas: HTMLCanvasElement;
  readonly emissive: HTMLCanvasElement;
  readonly painter: TilePainter;
  readonly originX: number;
  readonly originY: number;
  dirty = true;

  constructor(readonly world: World) {
    this.originX = (world.h - 1) * HALF_W;
    this.originY = 3 * LEVEL_H + 96;
    const w = (world.w + world.h) * HALF_W;
    const h = (world.w + world.h) * HALF_H + this.originY + 40;
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.emissive = document.createElement("canvas");
    this.emissive.width = w;
    this.emissive.height = h;
    const ctx = this.canvas.getContext("2d")!;
    const ectx = this.emissive.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ectx.imageSmoothingEnabled = false;
    this.painter = new TilePainter(world, ctx, ectx, this.originX, this.originY);
  }

  invalidate(): void {
    this.dirty = true;
  }

  render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const w = this.world;
    this.painter.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.painter.ectx.clearRect(0, 0, this.emissive.width, this.emissive.height);
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        this.painter.drawTile(x, y);
      }
    }
  }
}

/**
 * 毎フレーム描き直す動的レイヤー (列車・踏切)。ビューポートと同じ大きさ。
 * 列車の手前にあるタイルを描き直して、建物の陰に隠れるようにする。
 */
export class DynamicLayer {
  readonly canvas: HTMLCanvasElement;
  readonly emissive: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ectx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.emissive = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
    this.ectx = this.emissive.getContext("2d")!;
  }

  render(world: World, trains: TrainSystem, viewW: number, viewH: number, camX: number, camY: number, season: SeasonTint = 0, illumination = false): void {
    const W = Math.ceil(viewW);
    const H = Math.ceil(viewH);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.emissive.width = W;
      this.emissive.height = H;
    }
    this.ctx.clearRect(0, 0, W, H);
    this.ectx.clearRect(0, 0, W, H);
    this.ctx.imageSmoothingEnabled = false;
    this.ectx.imageSmoothingEnabled = false;
    const painter = new TilePainter(world, this.ctx, this.ectx, -Math.round(camX), -Math.round(camY));
    painter.season = season;
    painter.illumination = illumination;
    const blinkOn = Math.floor(trains.blink * 3) % 2 === 0;

    // 踏切の警報: 遮断機を描き、その手前のタイルで隠す
    for (const i of trains.activeCrossings) {
      const x = i % world.w;
      const y = Math.floor(i / world.w);
      const [px, py] = painter.tileScreen(x, y);
      const c = cornerHeights(world, x, y);
      const h = Math.min(c[0], c[1], c[2], c[3]) * LEVEL_H;
      const box: [number, number, number, number] = [px, py - h - 8, TILE_W, TILE_H + 8];
      if (!this.visible(box, W, H)) continue;
      painter.drawTile(x, y, trains.activeCrossings, blinkOn);
      this.redrawFront(painter, x, y, box, trains.activeCrossings, blinkOn);
    }
    // 列車: 奥の車両から
    const cars: { pose: CarPose; sum: number }[] = [];
    for (const t of trains.trains) {
      for (const pose of trains.carPoses(t)) cars.push({ pose, sum: pose.tx + pose.ty });
    }
    cars.sort((a, b) => a.sum - b.sum);
    for (const { pose } of cars) {
      const tx = Math.floor(pose.tx + 0.5);
      const ty = Math.floor(pose.ty + 0.5);
      if (!inBounds(world, tx, ty)) continue;
      const [cx, cy] = painter.carScreen(pose);
      const box: [number, number, number, number] = [cx - 16, cy - 24, 32, 32];
      if (!this.visible(box, W, H)) continue;
      painter.drawCar(pose);
      this.redrawFront(painter, tx, ty, box, trains.activeCrossings, blinkOn);
    }
  }

  private visible(box: [number, number, number, number], W: number, H: number): boolean {
    return box[0] + box[2] > 0 && box[1] + box[3] > 0 && box[0] < W && box[1] < H;
  }

  /**
   * (x,y) より手前にあり、box に重なりうるタイルを奥から順に描き直す。
   * box にクリップするので、描き直したタイルがさらに手前のタイルを覆うことはない。
   */
  private redrawFront(
    painter: TilePainter,
    x: number,
    y: number,
    box: [number, number, number, number],
    crossings: Set<number>,
    blinkOn: boolean,
  ): void {
    const w = painter.world;
    for (const c of [painter.ctx, painter.ectx]) {
      c.save();
      c.beginPath();
      c.rect(box[0], box[1], box[2], box[3]);
      c.clip();
    }
    const d0 = x - y;
    const s0 = x + y;
    for (let s = s0 + 1; s <= s0 + 13; s++) {
      for (let d = d0 - 2; d <= d0 + 2; d++) {
        if ((s + d) % 2 !== 0) continue;
        const tx = (s + d) / 2;
        const ty = (s - d) / 2;
        if (!inBounds(w, tx, ty)) continue;
        painter.drawTile(tx, ty, crossings, blinkOn);
      }
    }
    for (const c of [painter.ctx, painter.ectx]) c.restore();
  }
}

/**
 * 平らな 32x16 ダイヤを描くスプライトを、傾いたタイル (東西 or 南北の坂) に合わせて
 * せん断する変換行列 [m11, m12, m21, m22, e, f] を返す。
 */
function shearTransform(px: number, py: number, oy: number, rel: readonly [number, number, number, number]): number[] {
  const Tx = px + HALF_W;
  const Ty = py - rel[0] * LEVEL_H;
  const Rx = px + TILE_W;
  const Ry = py + HALF_H - rel[1] * LEVEL_H;
  const Lx = px;
  const Ly = py + HALF_H - rel[3] * LEVEL_H;
  const ax = Rx - Tx;
  const ay = Ry - Ty;
  const bx = Lx - Tx;
  const by = Ly - Ty;
  const m11 = ax / 32 - bx / 32;
  const m12 = ay / 32 - by / 32;
  const m21 = ax / 16 + bx / 16;
  const m22 = ay / 16 + by / 16;
  const e = Tx + ax * (-0.5 - oy / 16) + bx * (0.5 - oy / 16);
  const f = Ty + ay * (-0.5 - oy / 16) + by * (0.5 - oy / 16);
  return [m11, m12, m21, m22, e, f];
}
