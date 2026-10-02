import { visibleFloors } from "../sim/growth";
import { fbm, hash2 } from "../sim/rng";
import { CarPose, TrainSystem } from "../sim/trains";
import { BState, DX, DY, Kind, World, cornerHeights, idx, inBounds, railConnections, railIsStraightX, roadConnections } from "../sim/world";
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
      this.ctx.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, 0, 0, s.w, s.h);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ectx.globalCompositeOperation = "destination-out";
      this.ectx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
      this.ectx.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, 0, 0, s.w, s.h);
      this.ectx.setTransform(1, 0, 0, 1, 0, 0);
      this.ectx.globalCompositeOperation = "source-over";
      return;
    }
    this.ctx.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, px - s.ox, py - s.oy, s.w, s.h);
    this.ectx.globalCompositeOperation = "destination-out";
    this.ectx.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, px - s.ox, py - s.oy, s.w, s.h);
    this.ectx.globalCompositeOperation = "source-over";
  }

  blitEmissive(s: Sprite, px: number, py: number): void {
    this.ectx.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, px - s.ox, py - s.oy, s.w, s.h);
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
    const water = w.water[i] === 1;
    // 水面はつねに高さ 0 の平面として描く (橋の頂点が高くても水は水平)
    const hmin = water ? 0 : Math.min(c[0], c[1], c[2], c[3]);
    const rel = water ? ([0, 0, 0, 0] as const) : ([c[0] - hmin, c[1] - hmin, c[2] - hmin, c[3] - hmin] as const);
    const [px0, py0] = this.tileScreen(x, y);
    const px = px0;
    const py = py0 - hmin * LEVEL_H;
    const variant = Math.floor(hash2(w.seed, x, y) * 8);
    /** 橋の桁の高さ (px)。線路の頂点の高さに合わせる */
    const bridgeLift = water ? Math.min(c[0], c[1], c[2], c[3]) * LEVEL_H : 0;

    // 地面
    let ground: GroundKind = "grass";
    if (water) ground = "water";
    else if (k === Kind.Lot) ground = w.lotTimer[i] < 20 ? "rubble" : "lot";
    else if (k === Kind.Park) ground = "park";
    else if (k === Kind.Building) ground = w.bLevel[i] >= 2 ? "concrete" : "grass";
    else if (k === Kind.BuildingPart) ground = "concrete";
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
        this.blit(railSprite(railConnections(w, x, y), water, this.season, bridgeLift), px, py, rel);
        break;
      case Kind.Crossing: {
        const rm = railConnections(w, x, y);
        this.blit(crossingSprite(rm, roadConnections(w, x, y), this.season), px, py, rel);
        if (activeCrossings?.has(i)) {
          const g = gateSprite(railIsStraightX(rm), blinkOn);
          this.blit(g.base, px, py);
          if (g.emissive) this.blitEmissive(g.emissive, px, py);
        }
        break;
      }
      case Kind.Station: {
        const st = w.stations.find((s) => s.x === x && s.y === y);
        const sp = stationSprite(st ? st.plazaDir : 2, this.season, railConnections(w, x, y));
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
    const h = heightAt(c, u, v) * LEVEL_H;
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

/** チャンク (CHUNK×CHUNK タイル) ごとの静的キャンバス */
interface Chunk {
  cx: number;
  cy: number;
  canvas: HTMLCanvasElement;
  emissive: HTMLCanvasElement;
  painter: TilePainter;
  /** ワールド座標でのキャンバス左上 */
  x0: number;
  y0: number;
  dirty: boolean;
  lastUsed: number;
}

export const CHUNK = 32;
/** 建物やタワーが上に伸びるぶんの余白 (px) */
const CHUNK_TOP = 330;
const CHUNK_BOTTOM = 40;
const MAX_CHUNKS = 28;

/**
 * マップをチャンクに分けて描く静的レイヤー。見えている範囲だけ描き、
 * 変化したタイルを含むチャンクだけ描き直す。
 */
export class MapLayer {
  private chunks = new Map<string, Chunk>();
  season: SeasonTint = 0;
  illumination = false;
  /** 変化検出用のスナップショット */
  private snapKind: Uint8Array;
  private snapState: Uint8Array;
  private snapProgress: Uint8Array;
  private snapLights: Uint8Array;
  private snapLevel: Uint8Array;
  private frame = 0;

  constructor(readonly world: World) {
    this.snapKind = new Uint8Array(world.kind);
    this.snapState = new Uint8Array(world.bState);
    this.snapProgress = new Uint8Array(world.bProgress);
    this.snapLights = new Uint8Array(world.lights);
    this.snapLevel = new Uint8Array(world.bLevel);
  }

  /** 全チャンクを捨てる (季節が変わったときなど) */
  invalidate(): void {
    for (const c of this.chunks.values()) c.dirty = true;
  }

  /** ワールドの変化を調べ、関係するチャンクを汚す。1 時間ごとなど、変化がありうるときに呼ぶ。 */
  detectChanges(): void {
    const w = this.world;
    const n = w.w * w.h;
    for (let i = 0; i < n; i++) {
      if (
        w.kind[i] !== this.snapKind[i] ||
        w.bState[i] !== this.snapState[i] ||
        w.bProgress[i] !== this.snapProgress[i] ||
        w.lights[i] !== this.snapLights[i] ||
        w.bLevel[i] !== this.snapLevel[i]
      ) {
        this.markTile(i % w.w, Math.floor(i / w.w));
      }
    }
    this.snapKind.set(w.kind);
    this.snapState.set(w.bState);
    this.snapProgress.set(w.bProgress);
    this.snapLights.set(w.lights);
    this.snapLevel.set(w.bLevel);
  }

  private markTile(x: number, y: number): void {
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    // スプライトは上 (北西側) に伸びるので、北・西・北西のチャンクにも影響する
    for (const [dx, dy] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ]) {
      const c = this.chunks.get(`${cx + dx},${cy + dy}`);
      if (c) c.dirty = true;
    }
  }

  private chunkBounds(cx: number, cy: number): { x0: number; y0: number; w: number; h: number } {
    const tx0 = cx * CHUNK;
    const ty0 = cy * CHUNK;
    const [ox] = tileOrigin(tx0, ty0 + CHUNK - 1);
    const [, oy] = tileOrigin(tx0, ty0);
    return { x0: ox, y0: oy - CHUNK_TOP, w: CHUNK * 2 * HALF_W, h: CHUNK * 2 * HALF_H + TILE_H + CHUNK_TOP + CHUNK_BOTTOM };
  }

  private getChunk(cx: number, cy: number): Chunk {
    const key = `${cx},${cy}`;
    let c = this.chunks.get(key);
    if (!c) {
      if (this.chunks.size >= MAX_CHUNKS) this.evict();
      const b = this.chunkBounds(cx, cy);
      const canvas = document.createElement("canvas");
      canvas.width = b.w;
      canvas.height = b.h;
      const emissive = document.createElement("canvas");
      emissive.width = b.w;
      emissive.height = b.h;
      const ctx = canvas.getContext("2d")!;
      const ectx = emissive.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ectx.imageSmoothingEnabled = false;
      const painter = new TilePainter(this.world, ctx, ectx, -b.x0, -b.y0);
      c = { cx, cy, canvas, emissive, painter, x0: b.x0, y0: b.y0, dirty: true, lastUsed: this.frame };
      for (const cv of [canvas, emissive]) {
        cv.addEventListener("contextlost", () => (c!.dirty = true));
        cv.addEventListener("contextrestored", () => (c!.dirty = true));
      }
      this.chunks.set(key, c);
    }
    return c;
  }

  private evict(): void {
    let oldest: Chunk | null = null;
    for (const c of this.chunks.values()) if (!oldest || c.lastUsed < oldest.lastUsed) oldest = c;
    if (oldest) {
      oldest.canvas.width = 0;
      oldest.emissive.width = 0;
      this.chunks.delete(`${oldest.cx},${oldest.cy}`);
    }
  }

  private renderChunk(c: Chunk): void {
    const w = this.world;
    c.painter.season = this.season;
    c.painter.illumination = this.illumination;
    c.painter.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.painter.ectx.clearRect(0, 0, c.emissive.width, c.emissive.height);
    // このチャンクの範囲に描き込みうるタイル: 和 (tx+ty) と差 (tx-ty) の範囲で絞る
    const tx0 = c.cx * CHUNK;
    const ty0 = c.cy * CHUNK;
    const s0 = tx0 + ty0;
    const d0 = tx0 - (ty0 + CHUNK - 1);
    const sMin = s0 - Math.ceil(CHUNK_BOTTOM / HALF_H);
    const sMax = s0 + 2 * (CHUNK - 1) + Math.ceil(CHUNK_TOP / HALF_H) + 2;
    const dMin = d0 - 2;
    const dMax = d0 + 2 * (CHUNK - 1) + 1;
    for (let sum = sMin; sum <= sMax; sum++) {
      for (let diff = dMin; diff <= dMax; diff++) {
        if ((sum + diff) % 2 !== 0) continue;
        const tx = (sum + diff) / 2;
        const ty = (sum - diff) / 2;
        if (!inBounds(w, tx, ty)) continue;
        c.painter.drawTile(tx, ty);
      }
    }
    c.dirty = false;
  }

  /** 発光レイヤーだけ描く (draw の後に呼ぶ) */
  drawEmissive(ectx: CanvasRenderingContext2D, viewX0: number, viewY0: number, viewW: number, viewH: number): void {
    for (const c of this.chunks.values()) {
      if (c.x0 + c.canvas.width < viewX0 || c.x0 > viewX0 + viewW || c.y0 + c.canvas.height < viewY0 || c.y0 > viewY0 + viewH) continue;
      ectx.drawImage(c.emissive, c.x0, c.y0);
    }
  }

  /** 見えているチャンクを (必要なら描いてから) ctx に描く。ctx には既にカメラ変換がかかっていること。 */
  draw(ctx: CanvasRenderingContext2D, ectx: CanvasRenderingContext2D | null, viewX0: number, viewY0: number, viewW: number, viewH: number): void {
    this.frame++;
    const w = this.world;
    const nx = Math.ceil(w.w / CHUNK);
    const ny = Math.ceil(w.h / CHUNK);
    let budget = 3; // 1 フレームに描き直すチャンク数の上限
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const b = this.chunkBounds(cx, cy);
        if (b.x0 + b.w < viewX0 || b.x0 > viewX0 + viewW || b.y0 + b.h < viewY0 || b.y0 > viewY0 + viewH) continue;
        const c = this.getChunk(cx, cy);
        c.lastUsed = this.frame;
        if (c.dirty && budget > 0) {
          this.renderChunk(c);
          budget--;
        }
        ctx.drawImage(c.canvas, c.x0, c.y0);
        if (ectx) ectx.drawImage(c.emissive, c.x0, c.y0);
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
    for (const [line, t] of trains.allTrains()) {
      for (const pose of trains.carPoses(t, line)) cars.push({ pose, sum: pose.tx + pose.ty });
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
    for (let s = s0 + 1; s <= s0 + 44; s++) {
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
